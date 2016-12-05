(function() {
'use strict';

/* globals window, setImmediate, setTimeout, clearTimeout, setInterval */

let worker;
const errorCallbacks = [];
const slowCallbacks = {read: [], write: [], auth: [], onDisconnect: []};

const ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const MIN_INT32 = 1 << 31, MAX_INT32 = -(1 << 31) - 1;


class Snapshot {
  constructor({url, childrenKeys, value, valueError, exists, hasChildren}) {
    this._url = url.replace(/\/$/, '');
    this._childrenKeys = childrenKeys;
    this._value = value;
    this._valueError = errorFromJson(valueError);
    this._exists = value === undefined ? exists || false : value !== null;
    this._hasChildren = typeof value === 'object' || hasChildren || false;
  }

  exists() {
    return this._exists;
  }

  val() {
    this._checkValue();
    return this._value;
  }

  exportVal() {
    return this.val();
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
    if (this._key === undefined) this._key = this._url.replace(/.*\//, '');
    return this._key;
  }

  numChildren() {
    this._checkValue();
    return this._childrenKeys ? this._childrenKeys.length : 0;
  }

  ref() {
    return new Firebase(this._url);
  }

  _checkValue() {
    if (this._valueError) throw this._valueError;
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

class OnDisconnect {
  constructor(url) {
    this._url = url;
  }

  set(value, onComplete) {
    return attachCallback(worker.onDisconnect(this._url, 'set', value), onComplete, 'onDisconnect');
  }

  update(value, onComplete) {
    return attachCallback(
      worker.onDisconnect(this._url, 'update', value), onComplete, 'onDisconnect');
  }

  remove(onComplete) {
    return attachCallback(worker.onDisconnect(this._url, 'remove'), onComplete, 'onDisconnect');
  }

  cancel(onComplete) {
    return attachCallback(worker.onDisconnect(this._url, 'cancel'), onComplete, 'onDisconnect');
  }
}

class Query {
  constructor(url, terms) {
    if (!worker) throw new Error('Worker not connected');
    if (url.slice(0, 8) !== 'https://') throw new Error('Firebase URL must start with "https://"');
    this._url = url.replace(/\/$/, '');
    this._terms = terms;
  }

  on(eventType, callback, cancelCallback, context) {
    if (typeof context === 'undefined' && typeof cancelCallback !== 'function') {
      context = cancelCallback;
      cancelCallback = undefined;
    }
    worker.on(
      this.toString(), this._url, this._terms, eventType, callback, cancelCallback, context,
      {omitValue: !!callback.omitSnapshotValue}
    );
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
    return trackSlowness(worker.once(
      this._url, this._terms, eventType,
      {omitValue: !!(successCallback && successCallback.omitSnapshotValue)}
    ), 'read').then(snapshot => {
      if (successCallback) successCallback.call(context, snapshot);
      return snapshot;
    }, error => {
      if (failureCallback) failureCallback.call(context, error);
      return Promise.reject(error);
    });
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
          queryTerm +=
            '=' + encodeURIComponent(term.slice(1).map(x => JSON.stringify(x)).join(','));
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
    // TODO: support additional undocumented "environment" argument
    super(url);
    worker.trackServer(getUrlRoot(url));
  }

  authWithCustomToken(authToken, onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(
      worker.authWithCustomToken(this._url, authToken, options), onComplete, 'auth');
  }

  authAnonymously(onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(worker.authAnonymously(this._url, options), onComplete, 'auth');
  }

  authWithOAuthToken(provider, credentials, onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(
      worker.authWithCustomToken(this._url, provider, credentials, options), onComplete, 'auth');
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
    worker.onAuth(getUrlRoot(this._url), onComplete, context);
  }

  offAuth(onComplete, context) {
    worker.offAuth(getUrlRoot(this._url), onComplete, context);
  }

  getAuth() {
    return worker.getAuth(getUrlRoot(this._url));
  }

  child(childPath) {
    return new Firebase(`${this._url}/${childPath.split('/').map(encodeURIComponent).join('/')}`);
  }

  parent() {
    const k = this._url.lastIndexOf('/');
    return k >= 8 ? new Firebase(this._url.slice(0, k)) : null;
  }

  root() {
    const rootUrl = getUrlRoot(this._url);
    return this._url === rootUrl ? this : new Firebase(rootUrl);
  }

  key() {
    return this._url.replace(/.*\//, '');
  }

  set(value, onComplete) {
    return attachCallback(worker.set(this._url, value), onComplete, 'write');
  }

  update(value, onComplete) {
    return attachCallback(worker.update(this._url, value), onComplete, 'write');
  }

  remove(onComplete) {
    return attachCallback(worker.set(this._url, null), onComplete, 'write');
  }

  push(value, onComplete) {
    const child = this.child(worker.generateUniqueKey(this.root()));
    if (!value) return child;
    const promise = child.set(value, onComplete);
    child.then = promise.then.bind(promise);
    child.catch = promise.catch.bind(promise);
    if (promise.finally) child.finally = promise.finally.bind(promise);
    return child;
  }

  transaction(updateFunction, onComplete, applyLocally) {
    const options = {
      applyLocally: applyLocally === undefined ? updateFunction.applyLocally : applyLocally
    };
    ['nonsequential', 'safeAbort'].forEach(key => options[key] = updateFunction[key]);
    for (let key in options) {
      if (options.hasOwnProperty(key) && options[key] === undefined) {
        options[key] = Firebase.DefaultTransactionOptions[key];
      }
    }

    // Hold the ref value live until transaction complete, otherwise it'll keep retrying on a null
    // value.
    this.on('value', noop);  // No error handling -- if this fails, so will the transaction.
    return trackSlowness(
      worker.transaction(this._url, updateFunction, options), 'write'
    ).then(result => {
      this.off('value', noop);
      if (onComplete) onComplete(null, result.committed, result.snapshot);
      return result;
    }, error => {
      this.off('value', noop);
      if (onComplete) onComplete(error);
      return Promise.reject(error);
    });
  }

  onDisconnect() {
    return new OnDisconnect(this._url);
  }

  static connectWorker(webWorker) {
    if (worker) throw new Error('Worker already connected');
    worker = new FirebaseWorker(webWorker);
    return worker.init();
  }

  static preExpose(functionName) {
    Firebase.worker[functionName] = worker.bindExposedFunction(functionName);
  }

  static goOnline() {
    worker.activate(true);
  }

  static goOffline() {
    worker.activate(false);
  }

  static bounceConnection() {
    return worker.bounceConnection();
  }

  static enableLogging() {
    throw new Error('Global enableLogging() call must be made from within the worker process');
  }

  static onError(callback) {
    errorCallbacks.push(callback);
    return callback;
  }

  static offError(callback) {
    var k = errorCallbacks.indexOf(callback);
    if (k !== -1) errorCallbacks.splice(k, 1);
  }

  static onSlow(operationKind, timeout, callback) {
    const kinds = operationKind === 'all' ? Object.keys(slowCallbacks) : [operationKind];
    for (let kind of kinds) slowCallbacks[kind].push({timeout, callback, count: 0});
    return callback;
  }

  static offSlow(operationKind, callback) {
    const kinds = operationKind === 'all' ? Object.keys(slowCallbacks) : [operationKind];
    for (let kind of kinds) {
      const records = slowCallbacks[kind];
      for (let i = 0; i < records.length; i++) {
        if (records[i].callback === callback) {
          records.splice(i, 1);
          break;
        }
      }
    }
  }

  static debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    return worker.debugPermissionDeniedErrors(
      simulatedTokenGenerator, maxSimulationDuration, callFilter);
  }
}

Firebase.ServerValue = Object.freeze({TIMESTAMP: Object.freeze({'.sv': 'timestamp'})});
Firebase.DefaultTransactionOptions = Object.seal({
  applyLocally: true, nonsequential: false, safeAbort: false
});
Firebase.ABORT_TRANSACTION_NOW = Object.create(null);
Firebase.worker = {};


class SlownessTracker {
  constructor(record) {
    this.record = record;
    this.counted = false;
    this.canceled = false;
    this.handle = setTimeout(this.handleTimeout.bind(this), record.timeout);
  }

  handleTimeout() {
    if (this.canceled) return;
    this.counted = true;
    this.record.callback(++this.record.count, 1, this.record.timeout);
  }

  handleDone() {
    this.canceled = true;
    if (this.counted) {
      this.record.callback(--this.record.count, -1, this.record.timeout);
    } else {
      clearTimeout(this.handle);
    }
  }
}


// jshint latedef:false
class FirebaseWorker {
// jshint latedef:nofunc
  constructor(webWorker) {
    this._idCounter = 0;
    this._deferreds = {};
    this._active = true;
    this._servers = {};
    this._callbacks = {};
    this._simulatedTokenGenerator = null;
    this._maxSimulationDuration = 5000;
    this._simulatedCallFilter = null;
    this._inboundMessages = [];
    this._outboundMessages = [];
    this._flushMessageQueue = this._flushMessageQueue.bind(this);
    this._port = webWorker.port || webWorker;
    this._shared = !!webWorker.port;
    this._port.onmessage = this._receive.bind(this);
    window.addEventListener('unload', () => {this._send({msg: 'destroy'});});
    setInterval(() => {this._send({msg: 'ping'});}, 60 * 1000);
  }

  init() {
    const items = [];
    try {
      const storage = window.localStorage || window.sessionStorage;
      if (!storage) return;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        items.push({key, value: storage.getItem(key)});
      }
    } catch (e) {
      // Some browsers don't like us accessing local storage -- nothing we can do.
    }
    return this._send({msg: 'init', storage: items}).then(
      ({exposedFunctionNames, firebaseSdkVersion}) => {
        Firebase.SDK_VERSION =
          `${firebaseSdkVersion} (over ${this._shared ? 'shared ' : ''}fireworker)`;
        for (let name of exposedFunctionNames) {
          Firebase.worker[name] = this.bindExposedFunction(name);
        }
      }
    );
  }

  activate(enabled) {
    if (this._active === enabled) return;
    this._active = enabled;
    if (enabled) {
      this._receiveMessages(this._inboundMessages);
      this._inboundMessages = [];
      if (this._outboundMessages.length) setImmediate(this._flushMessageQueue);
    }
  }

  debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    this._simulatedTokenGenerator = simulatedTokenGenerator;
    if (maxSimulationDuration !== undefined) this._maxSimulationDuration = maxSimulationDuration;
    this._simulatedCallFilter = callFilter || function() {return true;};
  }

  _send(message) {
    message.id = ++this._idCounter;
    const promise = new Promise((resolve, reject) => {
      this._deferreds[message.id] = {resolve, reject};
    });
    const deferred = this._deferreds[message.id];
    deferred.promise = promise;
    for (let name in message) if (message.hasOwnProperty(name)) deferred[name] = message[name];
    if (!this._outboundMessages.length && this._active) setImmediate(this._flushMessageQueue);
    this._outboundMessages.push(message);
    return promise;
  }

  _flushMessageQueue() {
    // console.log('send', this._outboundMessages);
    this._port.postMessage(this._outboundMessages);
    this._outboundMessages = [];
  }

  _receive(event) {
    // console.log('receive', event.data);
    if (this._active) {
      this._receiveMessages(event.data);
    } else {
      this._inboundMessages = this._inboundMessages.concat(event.data);
    }
  }

  _receiveMessages(messages) {
    for (let message of messages) {
      const fn = this[message.msg];
      if (typeof fn !== 'function') throw new Error('Unknown message: ' + message.msg);
      fn.call(this, message);
    }
  }

  bindExposedFunction(name) {
    return (function() {
      return this._send({msg: 'call', name, args: Array.prototype.slice.call(arguments)});
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
    this._hydrateError(message.error, deferred).then(error => {
      deferred.reject(error);
      emitError(error);
    });
  }

  _hydrateError(json, props) {
    const error = errorFromJson(json);
    const code = json.code || json.message;
    if (code && code.toLowerCase() === 'permission_denied') {
      return this._simulateCall(props).then(securityTrace => {
        if (securityTrace) {
          error.extra = error.extra || {};
          error.extra.debug = securityTrace;
        }
        return error;
      });
    } else {
      return Promise.resolve(error);
    }
  }

  _simulateCall(props) {
    if (!(this._simulatedTokenGenerator && this._maxSimulationDuration > 0)) {
      return Promise.resolve();
    }
    let simulatedCalls = [];
    switch (props.msg) {
      case 'set':
        simulatedCalls.push({method: 'set', url: props.url, args: [props.value]});
        break;
      case 'update':
        simulatedCalls.push({method: 'update', url: props.url, args: [props.value]});
        break;
      case 'on':
      case 'once':
        simulatedCalls.push({method: 'once', url: props.url, args: ['value']});
        break;
      case 'transaction':
        simulatedCalls.push({method: 'once', url: props.url, args: ['value']});
        simulatedCalls.push({method: 'set', url: props.url, args: [props.newValue]});
        break;
    }
    if (!simulatedCalls.length || !this._simulatedCallFilter(props.msg, props.url)) {
      return Promise.resolve();
    }
    const auth = this.getAuth(getUrlRoot(props.url));
    const simulationPromise = this._simulatedTokenGenerator(auth && auth.uid).then(token => {
      return Promise.all(simulatedCalls.map(message => {
        message.msg = 'simulate';
        message.token = token;
        return this._send(message);
      }));
    }).then(securityTraces => {
      if (securityTraces.every(trace => trace === null)) {
        return 'Unable to reproduce error in simulation';
      }
      return securityTraces.filter(trace => trace).join('\n\n');
    }).catch(e => {
      return 'Error running simulation: ' + e;
    });
    const timeoutPromise = new Promise(resolve => {
      setTimeout(resolve.bind(null, 'Simulated call timed out'), this._maxSimulationDuration);
    });
    return Promise.race([simulationPromise, timeoutPromise]);
  }

  updateLocalStorage(items) {
    try {
      const storage = window.localStorage || window.sessionStorage;
      for (let item in items) {
        if (item.value === null) {
          storage.removeItem(item.key);
        } else {
          storage.setItem(item.key, item.value);
        }
      }
    } catch (e) {
      // If we're denied access, there's nothing we can do.
    }
  }

  trackServer(rootUrl) {
    if (this._servers.hasOwnProperty(rootUrl)) return;
    const server = this._servers[rootUrl] = {
      offset: 0, lastUniqueKeyTime: 0, lastRandomValues: [], authListeners: []
    };
    const authCallbackId = this._registerCallback(this._authCallback.bind(this, server));
    const offsetUrl = `${rootUrl}/.info/serverTimeOffset`;
    this.on(offsetUrl, offsetUrl, [], 'value', offset => {server.offset = offset.val();});
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
      prefix = Math.floor(prefix / 64);
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
    listener(this.getAuth(rootUrl));
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
    const handle = {
      listenerKey, eventType, snapshotCallback, cancelCallback, context, msg: 'on', url, terms,
      timeouts: slowCallbacks.read.map(record => new SlownessTracker(record))
    };
    const callback = this._onCallback.bind(this, handle);
    this._registerCallback(callback, handle);
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
      if (!callbackId) return;  // no-op, callback never registered or already deregistered
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
    return this._send({msg: 'off', listenerKey, url, terms, eventType, callbackId}).then(() => {
      for (let id of idsToDeregister) this._deregisterCallback(id);
    });
  }

  _onCallback(handle, error, snapshotJson) {
    if (handle.timeouts) {
      for (let timeout of handle.timeouts) timeout.handleDone();
    }
    if (error) {
      this._deregisterCallback(handle.id);
      this._hydrateError(error, handle).then(error => {
        if (handle.cancelCallback) handle.cancelCallback.call(handle.context, error);
        emitError(error);
      });
    } else {
      handle.snapshotCallback.call(handle.context, new Snapshot(snapshotJson));
    }
  }

  once(url, terms, eventType, options) {
    return this._send({msg: 'once', url, terms, eventType, options}).then(snapshotJson => {
      return new Snapshot(snapshotJson);
    });
  }

  transaction(url, updateFunction, options) {
    let tries = 0;

    const attemptTransaction = (oldValue, oldHash) => {
      if (tries++ >= 25) return Promise.reject(new Error('maxretry'));
      let newValue;
      try {
        newValue = updateFunction(oldValue);
      } catch (e) {
        return Promise.reject(e);
      }
      if (newValue === Firebase.ABORT_TRANSACTION_NOW ||
          newValue === undefined && !options.safeAbort) {
        return {committed: false, snapshot: new Snapshot({url, value: oldValue})};
      }
      return this._send({msg: 'transaction', url, oldHash, newValue, options}).then(result => {
        if (result.stale) {
          return attemptTransaction(result.value, result.hash);
        } else {
          return {committed: result.committed, snapshot: new Snapshot(result.snapshotJson)};
        }
      });
    };

    return attemptTransaction(null, null);
  }

  onDisconnect(url, method, value) {
    return this._send({msg: 'onDisconnect', url, method, value});
  }

  bounceConnection() {
    return this._send({msg: 'bounceConnection'});
  }

  callback({id, args}) {
    const handle = this._callbacks[id];
    if (!handle) throw new Error('Unregistered callback: ' + id);
    handle.callback.apply(null, args);
  }

  _registerCallback(callback, handle) {
    handle = handle || {};
    handle.callback = callback;
    handle.id = `cb${++this._idCounter}`;
    this._callbacks[handle.id] = handle;
    return handle.id;
  }

  _nullifyCallback(id) {
    const handle = this._callbacks[id];
    if (handle.timeouts) {
      for (let timeout of handle.timeouts) timeout.handleDone();
    }
    this._callbacks[id].callback = noop;
  }

  _deregisterCallback(id) {
    delete this._callbacks[id];
  }
}


function attachCallback(promise, onComplete, operationKind) {
  promise = trackSlowness(promise, operationKind);
  if (!onComplete) return promise;
  return promise.then(
    result => {onComplete(null, result); return result;},
    error => {onComplete(error); return Promise.reject(error);}
  );
}

function trackSlowness(promise, operationKind) {
  const records = slowCallbacks[operationKind];
  if (!records.length) return promise;

  const timeouts = records.map(record => new SlownessTracker(record));

  function opDone() {
    for (let timeout of timeouts) timeout.handleDone();
  }

  promise = promise.then(result => {
    opDone();
    return result;
  }, error => {
    opDone();
    return Promise.reject(error);
  });

  return promise;
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

function emitError(error) {
  if (errorCallbacks.length) {
    setTimeout(() => {
      for (let callback of errorCallbacks) callback(error);
    }, 0);
  }
}

function getUrlRoot(url) {
  const k = url.indexOf('/', 8);
  return k >= 8 ? url.slice(0, k) : url;
}

function noop() {}
noop.skipCallback = true;

window.Firebase = Firebase;
})();
