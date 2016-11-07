(function() {
'use strict';

/* globals window */

let worker;

const ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const MIN_INT32 = 1 << 31, MAX_INT32 = -(1 << 31) - 1;


class Snapshot {
  constructor({url, childrenKeys, value, exists, hasChildren}) {
    this._url = url.replace(/\/$/, '');
    this._childrenKeys = childrenKeys;
    this._value = value;
    this._exists = exists;
    this._hasChildren = hasChildren;
  }

  exists() {
    return this._exists;
  }

  val() {
    this._checkValue();
    return this._value;
  }

  child(childPath) {
    const childPathParts = childPath.split('/');
    const child = this._getChildValue(childPathParts);
    return new Snapshot({
      url: `${this._url}/${childPathParts.map(encodeURIComponent).join('/')}`, value: child,
      exists: child !== undefined, hasChildren: typeof child === 'object'
    });
  }

  forEach(childAction) {
    this._checkValue();
    if (!this._hasChildren) return false;
    if (!this._childrenKeys) {
      this._childrenKeys = Object.keys(this._value);
      const sortValues = {};
      for (let key of this._childrenKeys) {
        if (/^[+-]?\d+$/.test(key)) {
          const n = parseInt(key, 10);
          if (n <= MAX_INT32 && n >= MIN_INT32) {
            sortValues[key] = n;
            continue;
          }
        }
        sortValues[key] = key;
      }
      this._childrenKeys.sort((a, b) => {
        a = sortValues[a];
        b = sortValues[b];
        const aNumber = typeof a === 'number', bNumber = typeof b === 'number';
        if (aNumber ^ bNumber) {
          return aNumber ? -1 : 1;
        } else {
          return a === b ? 0 : (a < b ? -1 : 1);
        }
      });
    }
    for (let key of this._childrenKeys) {
      const child = this._value[key];
      const childSnapshot = new Snapshot({
        url: `${this._url}/${key}`, value: child, exists: child !== undefined,
        hasChildren: typeof child === 'object'
      });
      if (childAction(childSnapshot) === true) return true;
    }
    return false;
  }

  hasChild(childPath) {
    return this._getChildValue(childPath.split('/')) !== null;
  }

  hasChildren() {
    return this._hasChildren;
  }

  key() {
    return this._url.replace(/.*\//, '');
  }

  numChildren() {
    this._checkValue();
    return this._childrenKeys ? this._childrenKeys.length : 0;
  }

  ref() {
    return new Firebase(this._url);
  }

  _checkValue() {
    if (this._value === undefined) throw new Error('Value omitted from snapshot');
  }

  _getChildValue(childPathParts) {
    this._checkValue();
    let result = this._value;
    for (let childKey of childPathParts) {
      if (result === null || result === undefined) break;
      result = result[childKey];
    }
    if (result === undefined) result = null;
    return result;
  }
}

class Query {
  constructor(url, terms) {
    if (!worker) throw new Error('Worker not connected');
    if (url.slice(0, 8) !== 'https://') throw new Error('Firebase URL must start with "https://"');
    this._url = url.replace(/\/$/, '');
    this._terms = terms;
  }

  on(eventType, callback, cancelCallback, context, options) {
    // options = {omitValue: boolean}
    if (context === 'undefined' && typeof cancelCallback !== 'function') {
      context = cancelCallback;
      cancelCallback = undefined;
    }
    worker.on(
      this.toString(), this._url, this._terms, eventType, callback, cancelCallback, context,
      options);
    return callback;
  }

  off(eventType, callback, context) {
    return worker.off(this.toString(), this._url, this._terms, eventType, callback, context);
  }

  once(eventType, successCallback, failureCallback, context) {
    if (context === 'undefined' && typeof failureCallback !== 'function') {
      context = failureCallback;
      failureCallback = undefined;
    }
    return worker.once(
      this._url, this._terms, eventType, successCallback, failureCallback, context);
  }

  ref() {
    return new Firebase(this._url);
  }

  toString() {
    let result = this._url;
    if (this._terms) {
      const queryTerms = this._terms.map(term => {
        let queryTerm = term[0];
        if (term.length > 1) {
          queryTerm += '=' + encodeURIComponent(term.slice(1).join(','));
        }
        return queryTerm;
      });
      queryTerms.sort();
      result += '?' + queryTerms.join('&');
    }
    return result;
  }
}

[
  'orderByChild', 'orderByKey', 'orderByValue', 'startAt', 'endAt', 'equalTo', 'limitToFirst',
  'limitToLast'
].forEach(methodName => {
  Query.prototype[methodName] = function() {
    const term = Array.prototype.slice.call(arguments);
    term.unshift(methodName);
    const terms = this._terms ? this._terms.slice() : [];
    terms.push(term);
    return new Query(this._url, terms);
  };
});


// jshint latedef:false
class Firebase extends Query {
// jshint latedef:nofunc
  constructor(url) {
    super(url);
    worker.trackServer(this.root()._url);
  }

  authWithCustomToken(authToken, onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(worker.authWithCustomToken(this._url, authToken, options), onComplete);
  }

  authAnonymously(onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(worker.authAnonymously(this._url, options), onComplete);
  }

  authWithOAuthToken(provider, credentials, onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(
      worker.authWithCustomToken(this._url, provider, credentials, options), onComplete);
  }

  authWithPassword() {
    throw new Error('Interactive auth not supported by Fireworker');
  }

  authWithOAuthPopup() {
    throw new Error('Interactive auth not supported by Fireworker');
  }

  authWithOAuthRedirect() {
    throw new Error('Interactive auth not supported by Fireworker');
  }

  unauth() {
    return worker.unauth(this._url);
  }

  onAuth(onComplete, context) {
    worker.onAuth(this.root()._url, onComplete, context);
  }

  offAuth(onComplete, context) {
    worker.offAuth(this.root()._url, onComplete, context);
  }

  getAuth() {
    return worker.getAuth(this.root()._url);
  }

  child(childPath) {
    return new Firebase(`${this._url}/${childPath.split('/').map(encodeURIComponent).join('/')}`);
  }

  parent() {
    const k = this._url.lastIndexOf('/');
    return k >= 8 ? new Firebase(this._url.slice(0, k)) : null;
  }

  root() {
    const k = this._url.indexOf('/', 8);
    return k >= 8 ? new Firebase(this._url.slice(0, k)) : this;
  }

  key() {
    return this._url.replace(/.*\//, '');
  }

  set(value, onComplete) {
    return attachCallback(worker.set(this._url, value), onComplete);
  }

  update(value, onComplete) {
    return attachCallback(worker.update(this._url, value), onComplete);
  }

  remove(onComplete) {
    return attachCallback(worker.set(this._url, null), onComplete);
  }

  push(value, onComplete) {
    const child = this.child(worker.generateUniqueKey(this.root()));
    if (!value) return child;
    const promise = attachCallback(worker.set(child, value), onComplete);
    child.then = promise.then.bind(promise);
    child.catch = promise.catch.bind(promise);
    if (promise.finally) child.finally = promise.finally.bind(promise);
    return child;
  }

  transaction(updateFunction, onComplete, applyLocally) {
    // TODO: implement
    throw new Error('Not implemented');
  }

  static connectWorker(webWorker) {
    if (worker) throw new Error('Worker already connected');
    worker = new FirebaseWorker(webWorker);
  }

  static goOnline() {
    throw new Error('Global goOnline() call must be made from within the worker process');
  }

  static goOffline() {
    throw new Error('Global goOffline() call must be made from within the worker process');
  }
}

Firebase.ServerValue = Object.freeze({TIMESTAMP: Object.freeze({'.sv': 'timestamp'})});


// jshint latedef:false
class FirebaseWorker {
// jshint latedef:nofunc
  constructor(webWorker) {
    this._idCounter = 0;
    this._deferreds = {};
    this._online = true;
    this._servers = {};
    this._callbacks = {};
    this._port = webWorker.port || webWorker;
    this._port.onmessage = this.receive.bind(this);
    this._send({msg: 'init'}).then(exposedMethodNames => {
      const worker = window.Firebase.worker = {};
      for (let name of exposedMethodNames) {
        worker[name] = this._bindExposedFunction(name);
      }
    });
    // TODO: ping
  }

  _send(message) {
    message.id = ++this._idCounter;
    const promise = new Promise((resolve, reject) => {
      this._deferreds[message.id] = {resolve, reject};
    });
    this._deferreds[message.id].promise = promise;
    this._port.postMessage(message);
    return promise;
  }

  _receive(event) {
    this[event.data.msg](event.data);
  }

  _bindExposedFunction(name) {
    return (function() {
      return this._send({msg: 'call', name, args: Array.prototype.slice(arguments)});
    }).bind(this);
  }

  resolve(message) {
    const deferred = this._deferreds[message.id];
    if (!deferred) throw new Error('fireworker received resolution to inexistent call');
    delete this._deferreds[message.id];
    deferred.resolve(message.result);
  }

  reject(message) {
    const deferred = this._deferreds[message.id];
    if (!deferred) throw new Error('fireworker received rejection of inexistent call');
    delete this._deferreds[message.id];
    deferred.reject(errorFromJson(message.error));
  }

  trackServer(rootUrl) {
    if (this._servers.hasOwnProperty(rootUrl)) return;
    const server = this._servers[rootUrl] = {
      offset: 0, lastUniqueKeyTime: 0, lastRandomValues: [], authListeners: []
    };
    const authCallbackId = this._registerCallback(this._authCallback.bind(this, server));
    this.on(`${rootUrl}/.info/serverTimeOffset`, {}, 'value', offset => {
      server.offset = offset;
    });
    this._send({msg: 'onAuth', url: rootUrl, callbackId: authCallbackId});
  }

  generateUniqueKey(rootUrl) {
    const server = this._servers[rootUrl];
    if (!server) {
      throw new Error('Internal assertion failure: server not initialized for ' + rootUrl);
    }
    const now = Date.now() + server.offset;
    const chars = new Array(20);
    let prefix = now;
    for (let i = 7; i >= 0; i--) {
      chars[i] = ALPHABET.charAt(prefix & 0x3f);
      prefix >>>= 6;
    }
    if (now === server.lastUniqueKeyTime) {
      let i = 11;
      while (i >= 0 && server.lastRandomValues[i] === 63) {
        server.lastRandomValues[i] = 0;
        i -= 1;
      }
      if (i === -1) {
        throw new Error('Internal assertion failure: ran out of unique IDs for this millisecond');
      }
      server.lastRandomValues[i] += 1;
    } else {
      for (let i = 0; i < 12; i++) {
        // Make sure to leave some space for incrementing in the top nibble.
        server.lastRandomValues[i] = Math.floor(Math.random() * (i ? 64 : 16));
      }
    }
    for (let i = 0; i < 12; i++) {
      chars[i + 8] = ALPHABET[server.lastRandomValues[i]];
    }
    return chars.join('');
  }

  _authCallback(server, auth) {
    server.auth = auth;
    for (let listener of server.authListeners) listener(auth);
  }

  onAuth(rootUrl, callback, context) {
    const listener = callback.bind(context);
    listener.callback = callback;
    listener.context = context;
    this._servers[rootUrl].authListeners.push(listener);
    listener(this.getAuth());
  }

  offAuth(rootUrl, callback, context) {
    const authListeners = this._servers[rootUrl].authListeners;
    for (let i = 0; i < authListeners.length; i++) {
      const listener = authListeners[i];
      if (listener.callback === callback && listener.context === context) {
        authListeners.splice(i, 1);
        break;
      }
    }
  }

  getAuth(rootUrl) {
    return this._servers[rootUrl].auth;
  }

  authWithCustomToken(url, authToken, options) {
    return this._send({msg: 'authWithCustomToken', url, authToken, options});
  }

  authAnonymously(url, options) {
    return this._send({msg: 'authAnonymously', url, options});
  }

  authWithOAuthToken(url, provider, credentials, options) {
    return this._send({msg: 'authWithOAuthToken', url, provider, credentials, options});
  }

  unauth(url) {
    return this._send({msg: 'unauth', url});
  }

  set(url, value) {return this._send({msg: 'set', url, value});}
  update(url, value) {return this._send({msg: 'update', url, value});}

  on(listenerKey, url, terms, eventType, snapshotCallback, cancelCallback, context, options) {
    const handle = {listenerKey, eventType, snapshotCallback, cancelCallback, context};
    const callback = this._onCallback.bind(this, handle);
    handle.id = this._registerCallback(callback);
    // Keep multiple IDs to allow the same snapshotCallback to be reused.
    snapshotCallback.__callbackIds = snapshotCallback.__callbackIds || [];
    snapshotCallback.__callbackIds.push(handle.id);
    this._send({
      msg: 'on', listenerKey, url, terms, eventType, callbackId: handle.id, options
    }).catch(error => {
      callback(error);
    });
  }

  off(listenerKey, url, terms, eventType, snapshotCallback, context) {
    const idsToDeregister = [];
    let callbackId;
    if (snapshotCallback) {
      if (snapshotCallback.__callbackIds) {
        let i = 0;
        while (i < snapshotCallback.__callbackIds.length) {
          const id = snapshotCallback.__callbackIds[i];
          const handle = this._callbacks[id];
          if (!handle) {
            snapshotCallback.__callbackIds.splice(i, 1);
            continue;
          }
          if (handle.listenerKey === listenerKey && handle.eventType === eventType &&
              handle.context === context) {
            callbackId = id;
            idsToDeregister.push(id);
            snapshotCallback.__callbackIds.splice(i, 1);
            break;
          }
          i += 1;
        }
      }
    } else {
      for (let id of Object.keys(this._callbacks)) {
        const handle = this._callbacks[id];
        if (handle.listenerKey === listenerKey && (!eventType || handle.eventType === eventType)) {
          idsToDeregister.push(id);
        }
      }
    }
    // Nullify callbacks first, then deregister after off() is complete.  We don't want any
    // callbacks in flight from the worker to be invoked while the off() is processing, but we don't
    // want them to throw an exception either.
    for (let id of idsToDeregister) this._nullifyCallback(id);
    return this._send({msg: 'off', url, terms, eventType, callbackId}).then(() => {
      for (let id of idsToDeregister) this._deregisterCallback(id);
    });
  }

  _onCallback(handle, error, snapshotOptions) {
    if (error) {
      this._deregisterCallback(handle.id);
      if (handle.cancelCallback) handle.cancelCallback.call(handle.context, errorFromJson(error));
    } else {
      handle.snapshotCallback(new Snapshot(snapshotOptions));
    }
  }

  callback({id, args}) {
    const callback = this._callbacks[id];
    if (!callback) throw new Error('Unregistered callback: ' + id);
    callback.apply(null, args);
  }

  _registerCallback(callback) {
    const id = 'c' + (++this._idCounter);
    this._callbacks[id] = callback;
    return id;
  }

  _nullifyCallback(id) {
    this._callbacks[id] = noop;
  }

  _deregisterCallback(id) {
    delete this._callbacks[id];
  }
}


function attachCallback(promise, onComplete) {
  if (!onComplete) return promise;
  return promise.then(result => {onComplete(result);}, error => {onComplete(error);});
}

function errorFromJson(json) {
  if (!json || json instanceof Error) return json;
  const error = new Error();
  for (let propertyName in json) {
    if (!json.hasOwnProperty(propertyName)) continue;
    error[propertyName] = json[propertyName];
  }
  return error;
}

function noop() {}

// TODO: hook unload to remove all listeners

window.Firebase = Firebase;
})();
