(function() {
'use strict';

/* globals Firebase, CryptoJS, setImmediate, setInterval, self */

const fireworkers = [];


class LocalStorage {
  constructor() {
    this._items = [];
    this._pendingItems = [];
    this._initialized = false;
    this._flushPending = this.flushPending.bind(this);
  }

  init(items) {
    if (!this._initialized) {
      this._items = items;
      this._initialized = true;
    }
  }

  _update(item) {
    if (!this._pendingItems.length) setImmediate(this._flushPending);
    this._pendingItems.push(item);
  }

  flushPending() {
    if (!fireworkers.length) return;
    fireworkers[0]._send({msg: 'updateLocalStorage', items: this._pendingItems});
    this._pendingItems = [];
  }

  get length() {return this._items.length;}

  key(n) {
    return this._items[n].key;
  }

  getItem(key) {
    for (let item of this._items) {
      if (item.key === key) return item.value;
    }
    return null;
  }

  setItem(key, value) {
    let targetItem;
    for (let item of this._items) {
      if (item.key === key) {
        targetItem = item;
        item.value = value;
        break;
      }
    }
    if (!targetItem) {
      targetItem = {key, value};
      this._items.push(targetItem);
    }
    this._update(targetItem);
  }

  removeItem(key) {
    for (let i = 0; i < this._items.length; i++) {
      if (this._items[i].key === key) {
        this._items.splice(i, 1);
        this._update({key, value: null});
        break;
      }
    }
  }

  clear() {
    for (let item in this._items) {
      this._update({key: item.key, value: null});
    }
    this._items = [];
  }
}

self.localStorage = new LocalStorage();


class Fireworker {
  constructor(port) {
    this.ping();
    this._port = port;
    this._callbacks = {};
    this._messages = [];
    this._flushMessageQueue = this._flushMessageQueue.bind(this);
    port.onmessage = this._receive.bind(this);
  }

  init({storage, url}) {
    if (storage) self.localStorage.init(storage);
    if (url) new Firebase(url);
    return {
      exposedFunctionNames: Object.keys(Fireworker._exposed),
      firebaseSdkVersion: Firebase.SDK_VERSION
    };
  }

  destroy() {
    for (let key in this._callbacks) {
      const callback = this._callbacks[key];
      if (callback.cancel) callback.cancel();
    }
    this._callbacks = {};
    this._port.onmessage = null;
    this._messages = [];
    const k = fireworkers.indexOf(this);
    if (k >= 0) fireworkers[k] = null;
  }

  ping() {
    this.lastTouched = Date.now();
  }

  bounceConnection() {
    Firebase.goOffline();
    Firebase.goOnline();
  }

  _receive(event) {
    Fireworker._firstMessageReceived = true;
    this.lastTouched = Date.now();
    for (let message of event.data) this._receiveMessage(message);
  }

  _receiveMessage(message) {
    let promise;
    try {
      const fn = this[message.msg];
      if (typeof fn !== 'function') throw new Error('Unknown message: ' + message.msg);
      promise = Promise.resolve(fn.call(this, message));
    } catch(e) {
      promise = Promise.reject(e);
    }
    if (!message.oneWay) {
      promise.then(result => {
        this._send({msg: 'resolve', id: message.id, result: result});
      }, error => {
        this._send({msg: 'reject', id: message.id, error: errorToJson(error)});
      });
    }
  }

  _send(message) {
    if (!this._messages.length) setImmediate(this._flushMessageQueue);
    this._messages.push(message);
  }

  _flushMessageQueue() {
    this._port.postMessage(this._messages);
    this._messages = [];
  }

  call({name, args}) {
    try {
      return Promise.resolve(this._exposed[name].apply(null, args));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  authWithCustomToken({url, authToken, options}) {
    return createRef(url).authWithCustomToken(authToken, options);
  }

  authAnonymously({url, options}) {
    return createRef(url).authAnonymously(options);
  }

  authWithOAuthToken({url, provider, credentials, options}) {
    return createRef(url).authWithOAuthToken(provider, credentials, options);
  }

  unauth({url}) {
    return createRef(url).unauth();
  }

  onAuth({url, callbackId}) {
    const authCallback = this._callbacks[callbackId] = this._onAuthCallback.bind(this, callbackId);
    authCallback.cancel = this._offAuth.bind(this, url, authCallback);
    createRef(url).onAuth(authCallback);
  }

  _offAuth(url, authCallback) {
    createRef(url).offAuth(authCallback);
  }

  _onAuthCallback(callbackId, auth) {
    this._send({msg: 'callback', id: callbackId, args: [auth]});
  }

  set({url, value}) {
    return createRef(url).set(value);
  }

  update({url, value}) {
    return createRef(url).update(value);
  }

  on({listenerKey, url, terms, eventType, callbackId, options}) {
    options = options || {};
    options.orderChildren = false;
    if (terms) {
      for (let term of terms) {
        if (term[0] === 'orderByChild' || term[0] === 'orderByValue') {
          options.orderChildren = true;
          break;
        }
      }
    }
    const snapshotCallback = this._callbacks[callbackId] =
      this._onSnapshotCallback.bind(this, callbackId, options);
    snapshotCallback.listenerKey = listenerKey;
    snapshotCallback.eventType = eventType;
    snapshotCallback.cancel = this.off.bind({listenerKey, url, terms, eventType, callbackId});
    const cancelCallback = this._onCancelCallback.bind(this, callbackId);
    createRef(url, terms).on(eventType, snapshotCallback, cancelCallback);
  }

  off({listenerKey, url, terms, eventType, callbackId}) {
    let snapshotCallback;
    if (callbackId) {
      // Callback IDs will not be reused across on() calls, so it's safe to just delete it.
      snapshotCallback = this._callbacks[callbackId];
      delete this._callbacks[callbackId];
    } else {
      for (let key of Object.keys(this._callbacks)) {
        if (!this._callbacks.hasOwnProperty(key)) continue;
        const callback = this._callbacks[key];
        if (callback.listenerKey === listenerKey &&
            (!eventType || callback.eventType === eventType)) {
          delete this._callbacks[key];
        }
      }
    }
    createRef(url, terms).off(eventType, snapshotCallback);
  }

  _onSnapshotCallback(callbackId, options, snapshot) {
    this._send({msg: 'callback', id: callbackId, args: [null, snapshotToJson(snapshot, options)]});
  }

  _onCancelCallback(callbackId, error) {
    delete this._callbacks[callbackId];
    this._send({msg: 'callback', id: callbackId, args: [errorToJson(error)]});
  }

  once({url, terms, eventType, options}) {
    return createRef(url, terms).once(eventType).then(
      snapshot => snapshotToJson(snapshot, options));
  }

  transaction({url, oldHash, newValue, options}) {
    const ref = createRef(url);
    let stale, currentValue, currentHash;

    return ref.transaction(value => {
      currentValue = value;
      currentHash = hashJson(value);
      stale = oldHash !== currentHash;
      if (stale) return;
      if (newValue === undefined && options.safeAbort) return value;
      return newValue;
    }, undefined, options.applyLocally).then(result => {
      if (stale) {
        return {stale, value: currentValue, hash: currentHash};
      } else {
        return {
          stale: false, committed: result.committed, snapshotJson: snapshotToJson(result.snapshot)
        };
      }
    }, error => {
      if (options.nonsequential && error.message === 'set') {
        return ref.once('value').then(
          value => ({stale: true, value: value, hash: hashJson(value)}));
      }
      return Promise.reject(error);
    });
  }

  onDisconnect({url, method, value}) {
    const onDisconnect = createRef(url).onDisconnect();
    return onDisconnect[method].call(onDisconnect, value);
  }

  static expose(fn) {
    if (Fireworker._exposed.hasOwnProperty(fn.name)) {
      throw new Error(`Function ${fn.name}() already exposed`);
    }
    if (Fireworker._firstMessageReceived) {
      throw new Error('Too late to expose function, worker in use');
    }
    Fireworker._exposed[fn.name] = fn;
  }
}

Fireworker._exposed = {};
Fireworker._firstMessageReceived = false;


function errorToJson(error) {
  const json = {name: error.name};
  const propertyNames = Object.getOwnPropertyNames(error);
  for (let propertyName of propertyNames) {
    json[propertyName] = error[propertyName];
  }
  return json;
}

function snapshotToJson(snapshot, options) {
  const url = snapshot.ref().toString();
  if (options && options.omitValue) {
    return {url, exists: snapshot.exists(), hasChildren: snapshot.hasChildren()};
  } else {
    const value = snapshot.val();
    let childrenKeys;
    if (options && options.orderChildren && typeof value === 'object') {
      for (let key in value) {
        if (!value.hasOwnProperty(key)) continue;
        // Non-enumerable properties won't be transmitted when sending.
        Object.defineProperty(value[key], '$key', {value: key});
      }
      childrenKeys = [];
      snapshot.forEach(child => {childrenKeys.push(child.$key);});
    }
    return {url, value, childrenKeys};
  }
}

function createRef(url, terms) {
  try {
    let ref = new Firebase(url);
    if (terms) {
      for (let term of terms) ref = ref[term[0]].apply(ref, term.slice(1));
    }
    return ref;
  } catch (e) {
    console.error(url, terms, e);
    throw e;
  }
}

function hashJson(json) {
  if (json === null) return null;
  const sha1 = CryptoJS.algo.SHA1.create();
  _hashJson(json, sha1);
  return 'sha1:' + sha1.finalize().toString();
}

function _hashJson(json, sha1) {
  let type = typeof json;
  if (type === 'object') {
    if (json === null) type = 'null';
    else if (Array.isArray(json)) type = 'array';
    else if (json instanceof Boolean) type = 'boolean';
    else if (json instanceof Number) type = 'number';
    else if (json instanceof String) type = 'string';
  }
  switch (type) {
    case 'undefined': sha1.update('u'); break;
    case 'null': sha1.update('n'); break;
    case 'boolean': sha1.update(json ? 't' : 'f'); break;
    case 'number': sha1.update('x' + json); break;
    case 'string': sha1.update('s' + json); break;
    case 'array':
      sha1.update('[');
      for (let i = 0; i < json.length; i++) _hashJson(json[i], sha1);
      sha1.update(']');
      break;
    case 'object':
      sha1.update('{');
      const keys = Object.keys(json);
      keys.sort();
      for (let i = 0; i < keys.length; i++) _hashJson(json[keys[i]], sha1);
      sha1.update('}');
      break;
    default:
      throw new Error('Unable to hash non-JSON data: ' + type);
  }
}

function acceptConnections() {
  if (typeof onconnect !== 'undefined') {
    self.onconnect = function(event) {
      fireworkers.push(new Fireworker(event.ports[0]));
    };
  } else {
    fireworkers.push(new Fireworker(self));
  }
  self.localStorage.flushPending();
}

const CONNECTION_CHECK_INTERVAL = 60 * 1000;
let lastConnectionCheck = Date.now();
setInterval(function findAbandonedConnections() {
  const now = Date.now(), gap = now - lastConnectionCheck - CONNECTION_CHECK_INTERVAL;
  lastConnectionCheck = now;
  fireworkers.forEach(worker => {
    if (!worker) return;
    if (gap >= 1000 && worker.lastTouched <= now - gap) worker.lastTouched += gap;
    if (now - worker.lastTouched >= 3 * CONNECTION_CHECK_INTERVAL) worker.destroy();
  });
  let k;
  while ((k = fireworkers.indexOf(null)) >= 0) fireworkers.splice(k, 1);
}, CONNECTION_CHECK_INTERVAL);

self.Fireworker = Fireworker;
self.window = self;
acceptConnections();

})();
