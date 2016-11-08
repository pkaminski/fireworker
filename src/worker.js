(function() {
'use strict';

/* globals Firebase, self */

// TODO: emulate localStorage via indexedDB and communication with client
// TODO: scan fireworkers regularly and destroy any that haven't been pinged in a while


class Fireworker {
  constructor(port) {
    this._port = port;
    this._callbacks = {};
    port.onmessage = this._receive.bind(this);
  }

  destroy() {
    for (let key in this._callbacks) {
      const callback = this._callbacks[key];
      if (callback.cancel) callback.cancel();
    }
    this._callbacks = {};
    this._port.onmessage = null;
  }

  _receive(event) {
    Fireworker._firstMessageReceived = true;
    let promise;
    try {
      const fn = this[event.data.msg];
      if (!fn) throw new Error('Unknown message token: ' + event.data.msg);
      promise = Promise.resolve(fn.call(this, event.data));
    } catch(e) {
      promise = Promise.reject(e);
    }
    promise.then(result => {
      this._send({msg: 'resolve', id: event.data.id, result: result});
    }, error => {
      this._send({msg: 'reject', id: event.data.id, error: errorToJson(error)});
    });
  }

  _send(message) {
    this._port.postMessage(message);
  }

  init() {
    return {
      exposedMethodNames: Object.keys(Fireworker._exposed),
      firebaseSdkVersion: Firebase.SDK_VERSION
    };
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

  unauth(url) {
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
  const value = options.omitValue ? undefined : snapshot.val();
  const exists = snapshot.exists();
  const hasChildren = snapshot.hasChildren();
  let childrenKeys;
  if (!options.omitValue && options.orderChildren && hasChildren) {
    for (let key in value) {
      if (!value.hasOwnProperty(key)) continue;
      // Non-enumerable properties won't be transmitted when sending.
      Object.defineProperty(value[key], '$key', {value: key});
    }
    childrenKeys = [];
    snapshot.forEach(child => {childrenKeys.push(child.$key);});
  }
  return {url: snapshot.ref().toString(), childrenKeys, value, exists, hasChildren};
}

function createRef(url, terms) {
  let ref = new Firebase(url);
  if (terms) {
    for (let term of terms) ref = ref[term[0]].apply(ref, term.slice(1));
  }
  return ref;
}

const fireworkers = [];

function acceptConnections() {
  if (typeof onconnect !== 'undefined') {
    self.onconnect = function(event) {
      fireworkers.push(new Fireworker(event.ports[0]));
    };
  } else {
    fireworkers.push(new Fireworker(self));
  }
}

self.Fireworker = Fireworker;
self.window = self;
acceptConnections();

})();
