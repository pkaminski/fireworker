(function() {
'use strict';

/* globals window, setImmediate, setTimeout, clearTimeout, setInterval */

var worker;
var errorCallbacks = [];
var slowCallbacks = {read: [], write: [], auth: [], onDisconnect: []};

var ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
var MIN_INT32 = 1 << 31, MAX_INT32 = -(1 << 31) - 1;


var Snapshot = function Snapshot(ref) {
  var url = ref.url;
  var childrenKeys = ref.childrenKeys;
  var value = ref.value;
  var valueError = ref.valueError;
  var exists = ref.exists;
  var hasChildren = ref.hasChildren;

  this._url = url.replace(/\/$/, '');
  this._childrenKeys = childrenKeys;
  this._value = value;
  this._valueError = errorFromJson(valueError);
  this._exists = value === undefined ? exists || false : value !== null;
  this._hasChildren = typeof value === 'object' || hasChildren || false;
};

Snapshot.prototype.exists = function exists () {
  return this._exists;
};

Snapshot.prototype.val = function val () {
  this._checkValue();
  return this._value;
};

Snapshot.prototype.exportVal = function exportVal () {
  return this.val();
};

Snapshot.prototype.child = function child (childPath) {
  var childPathParts = childPath.split('/');
  var child = this._getChildValue(childPathParts);
  return new Snapshot({
    url: ((this._url) + "/" + (childPathParts.map(encodeURIComponent).join('/'))), value: child,
    exists: child !== undefined, hasChildren: typeof child === 'object'
  });
};

Snapshot.prototype.forEach = function forEach (childAction) {
    var this$1 = this;

  this._checkValue();
  if (!this._hasChildren) { return false; }
  if (!this._childrenKeys) {
    this._childrenKeys = Object.keys(this._value);
    var sortValues = {};
    for (var i = 0, list = this._childrenKeys; i < list.length; i += 1) {
      var key = list[i];

        if (/^[+-]?\d+$/.test(key)) {
        var n = parseInt(key, 10);
        if (n <= MAX_INT32 && n >= MIN_INT32) {
          sortValues[key] = n;
          continue;
        }
      }
      sortValues[key] = key;
    }
    this._childrenKeys.sort(function (a, b) {
      a = sortValues[a];
      b = sortValues[b];
      var aNumber = typeof a === 'number', bNumber = typeof b === 'number';
      if (aNumber ^ bNumber) {
        return aNumber ? -1 : 1;
      } else {
        return a === b ? 0 : (a < b ? -1 : 1);
      }
    });
  }
  for (var i$1 = 0, list$1 = this._childrenKeys; i$1 < list$1.length; i$1 += 1) {
    var key$1 = list$1[i$1];

      var child = this$1._value[key$1];
    var childSnapshot = new Snapshot({
      url: ((this$1._url) + "/" + key$1), value: child, exists: child !== undefined,
      hasChildren: typeof child === 'object'
    });
    if (childAction(childSnapshot) === true) { return true; }
  }
  return false;
};

Snapshot.prototype.hasChild = function hasChild (childPath) {
  return this._getChildValue(childPath.split('/')) !== null;
};

Snapshot.prototype.hasChildren = function hasChildren () {
  return this._hasChildren;
};

Snapshot.prototype.key = function key () {
  if (this._key === undefined) { this._key = this._url.replace(/.*\//, ''); }
  return this._key;
};

Snapshot.prototype.numChildren = function numChildren () {
  this._checkValue();
  return this._childrenKeys ? this._childrenKeys.length : 0;
};

Snapshot.prototype.ref = function ref () {
  return new Firebase(this._url);
};

Snapshot.prototype._checkValue = function _checkValue () {
  if (this._valueError) { throw this._valueError; }
  if (this._value === undefined) { throw new Error('Value omitted from snapshot'); }
};

Snapshot.prototype._getChildValue = function _getChildValue (childPathParts) {
  this._checkValue();
  var result = this._value;
  for (var i = 0, list = childPathParts; i < list.length; i += 1) {
    var childKey = list[i];

      if (result === null || result === undefined) { break; }
    result = result[childKey];
  }
  if (result === undefined) { result = null; }
  return result;
};

var OnDisconnect = function OnDisconnect(url) {
  this._url = url;
};

OnDisconnect.prototype.set = function set (value, onComplete) {
  return attachCallback(worker.onDisconnect(this._url, 'set', value), onComplete, 'onDisconnect');
};

OnDisconnect.prototype.update = function update (value, onComplete) {
  return attachCallback(
    worker.onDisconnect(this._url, 'update', value), onComplete, 'onDisconnect');
};

OnDisconnect.prototype.remove = function remove (onComplete) {
  return attachCallback(worker.onDisconnect(this._url, 'remove'), onComplete, 'onDisconnect');
};

OnDisconnect.prototype.cancel = function cancel (onComplete) {
  return attachCallback(worker.onDisconnect(this._url, 'cancel'), onComplete, 'onDisconnect');
};

var Query = function Query(url, terms) {
  if (!worker) { throw new Error('Worker not connected'); }
  if (url.slice(0, 8) !== 'https://') { throw new Error('Firebase URL must start with "https://"'); }
  this._url = url.replace(/\/$/, '');
  this._terms = terms;
};

Query.prototype.on = function on (eventType, callback, cancelCallback, context) {
  if (typeof context === 'undefined' && typeof cancelCallback !== 'function') {
    context = cancelCallback;
    cancelCallback = undefined;
  }
  worker.on(
    this.toString(), this._url, this._terms, eventType, callback, cancelCallback, context,
    {omitValue: !!callback.omitSnapshotValue}
  );
  return callback;
};

Query.prototype.off = function off (eventType, callback, context) {
  return worker.off(this.toString(), this._url, this._terms, eventType, callback, context);
};

Query.prototype.once = function once (eventType, successCallback, failureCallback, context) {
  if (context === 'undefined' && typeof failureCallback !== 'function') {
    context = failureCallback;
    failureCallback = undefined;
  }
  return trackSlowness(worker.once(
    this._url, this._terms, eventType,
    {omitValue: !!(successCallback && successCallback.omitSnapshotValue)}
  ), 'read').then(function (snapshot) {
    if (successCallback) { successCallback.call(context, snapshot); }
    return snapshot;
  }, function (error) {
    if (failureCallback) { failureCallback.call(context, error); }
    return Promise.reject(error);
  });
};

Query.prototype.ref = function ref () {
  return new Firebase(this._url);
};

Query.prototype.toString = function toString () {
  var result = this._url;
  if (this._terms) {
    var queryTerms = this._terms.map(function (term) {
      var queryTerm = term[0];
      if (term.length > 1) {
        queryTerm +=
          '=' + encodeURIComponent(term.slice(1).map(function (x) { return JSON.stringify(x); }).join(','));
      }
      return queryTerm;
    });
    queryTerms.sort();
    result += '?' + queryTerms.join('&');
  }
  return result;
};

[
  'orderByChild', 'orderByKey', 'orderByValue', 'startAt', 'endAt', 'equalTo', 'limitToFirst',
  'limitToLast'
].forEach(function (methodName) {
  Query.prototype[methodName] = function() {
    var term = Array.prototype.slice.call(arguments);
    term.unshift(methodName);
    var terms = this._terms ? this._terms.slice() : [];
    terms.push(term);
    return new Query(this._url, terms);
  };
});


// jshint latedef:false
var Firebase = (function (Query) {
  function Firebase(url) {
    // TODO: support additional undocumented "environment" argument
    Query.call(this, url);
    worker.trackServer(getUrlRoot(url));
  }

  if ( Query ) Firebase.__proto__ = Query;
  Firebase.prototype = Object.create( Query && Query.prototype );
  Firebase.prototype.constructor = Firebase;

  Firebase.prototype.authWithCustomToken = function authWithCustomToken (authToken, onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(
      worker.authWithCustomToken(this._url, authToken, options), onComplete, 'auth');
  };

  Firebase.prototype.authAnonymously = function authAnonymously (onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(worker.authAnonymously(this._url, options), onComplete, 'auth');
  };

  Firebase.prototype.authWithOAuthToken = function authWithOAuthToken (provider, credentials, onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(
      worker.authWithCustomToken(this._url, provider, credentials, options), onComplete, 'auth');
  };

  Firebase.prototype.authWithPassword = function authWithPassword () {
    throw new Error('Interactive auth not supported by Fireworker');
  };

  Firebase.prototype.authWithOAuthPopup = function authWithOAuthPopup () {
    throw new Error('Interactive auth not supported by Fireworker');
  };

  Firebase.prototype.authWithOAuthRedirect = function authWithOAuthRedirect () {
    throw new Error('Interactive auth not supported by Fireworker');
  };

  Firebase.prototype.unauth = function unauth () {
    return worker.unauth(this._url);
  };

  Firebase.prototype.onAuth = function onAuth (onComplete, context) {
    worker.onAuth(getUrlRoot(this._url), onComplete, context);
  };

  Firebase.prototype.offAuth = function offAuth (onComplete, context) {
    worker.offAuth(getUrlRoot(this._url), onComplete, context);
  };

  Firebase.prototype.getAuth = function getAuth () {
    return worker.getAuth(getUrlRoot(this._url));
  };

  Firebase.prototype.child = function child (childPath) {
    return new Firebase(((this._url) + "/" + (childPath.split('/').map(encodeURIComponent).join('/'))));
  };

  Firebase.prototype.parent = function parent () {
    var k = this._url.lastIndexOf('/');
    return k >= 8 ? new Firebase(this._url.slice(0, k)) : null;
  };

  Firebase.prototype.root = function root () {
    var rootUrl = getUrlRoot(this._url);
    return this._url === rootUrl ? this : new Firebase(rootUrl);
  };

  Firebase.prototype.key = function key () {
    return this._url.replace(/.*\//, '');
  };

  Firebase.prototype.set = function set (value, onComplete) {
    return attachCallback(worker.set(this._url, value), onComplete, 'write');
  };

  Firebase.prototype.update = function update (value, onComplete) {
    return attachCallback(worker.update(this._url, value), onComplete, 'write');
  };

  Firebase.prototype.remove = function remove (onComplete) {
    return attachCallback(worker.set(this._url, null), onComplete, 'write');
  };

  Firebase.prototype.push = function push (value, onComplete) {
    var child = this.child(worker.generateUniqueKey(this.root()));
    if (!value) { return child; }
    var promise = child.set(value, onComplete);
    child.then = promise.then.bind(promise);
    child.catch = promise.catch.bind(promise);
    if (promise.finally) { child.finally = promise.finally.bind(promise); }
    return child;
  };

  Firebase.prototype.transaction = function transaction (updateFunction, onComplete, applyLocally) {
    var this$1 = this;

    var options = {
      applyLocally: applyLocally === undefined ? updateFunction.applyLocally : applyLocally
    };
    ['nonsequential', 'safeAbort'].forEach(function (key) { return options[key] = updateFunction[key]; });
    for (var key in options) {
      if (options.hasOwnProperty(key) && options[key] === undefined) {
        options[key] = Firebase.DefaultTransactionOptions[key];
      }
    }

    // Hold the ref value live until transaction complete, otherwise it'll keep retrying on a null
    // value.
    this.on('value', noop);  // No error handling -- if this fails, so will the transaction.
    return trackSlowness(
      worker.transaction(this._url, updateFunction, options), 'write'
    ).then(function (result) {
      this$1.off('value', noop);
      if (onComplete) { onComplete(null, result.committed, result.snapshot); }
      return result;
    }, function (error) {
      this$1.off('value', noop);
      if (onComplete) { onComplete(error); }
      return Promise.reject(error);
    });
  };

  Firebase.prototype.onDisconnect = function onDisconnect () {
    return new OnDisconnect(this._url);
  };

  Firebase.connectWorker = function connectWorker (webWorker) {
    if (worker) { throw new Error('Worker already connected'); }
    worker = new FirebaseWorker(webWorker);
    return worker.init();
  };

  Firebase.preExpose = function preExpose (functionName) {
    Firebase.worker[functionName] = worker.bindExposedFunction(functionName);
  };

  Firebase.goOnline = function goOnline () {
    worker.activate(true);
  };

  Firebase.goOffline = function goOffline () {
    worker.activate(false);
  };

  Firebase.bounceConnection = function bounceConnection () {
    return worker.bounceConnection();
  };

  Firebase.enableLogging = function enableLogging () {
    throw new Error('Global enableLogging() call must be made from within the worker process');
  };

  Firebase.onError = function onError (callback) {
    errorCallbacks.push(callback);
    return callback;
  };

  Firebase.offError = function offError (callback) {
    var k = errorCallbacks.indexOf(callback);
    if (k !== -1) { errorCallbacks.splice(k, 1); }
  };

  Firebase.onSlow = function onSlow (operationKind, timeout, callback) {
    var kinds = operationKind === 'all' ? Object.keys(slowCallbacks) : [operationKind];
    for (var i = 0, list = kinds; i < list.length; i += 1) {
      var kind = list[i];

      slowCallbacks[kind].push({timeout: timeout, callback: callback, count: 0});
    }
    return callback;
  };

  Firebase.offSlow = function offSlow (operationKind, callback) {
    var kinds = operationKind === 'all' ? Object.keys(slowCallbacks) : [operationKind];
    for (var i$1 = 0, list = kinds; i$1 < list.length; i$1 += 1) {
      var kind = list[i$1];

      var records = slowCallbacks[kind];
      for (var i = 0; i < records.length; i++) {
        if (records[i].callback === callback) {
          records.splice(i, 1);
          break;
        }
      }
    }
  };

  Firebase.debugPermissionDeniedErrors = function debugPermissionDeniedErrors (simulatedTokenGenerator, maxSimulationDuration, callFilter) {
    return worker.debugPermissionDeniedErrors(
      simulatedTokenGenerator, maxSimulationDuration, callFilter);
  };

  return Firebase;
}(Query));

Firebase.ServerValue = Object.freeze({TIMESTAMP: Object.freeze({'.sv': 'timestamp'})});
Firebase.DefaultTransactionOptions = Object.seal({
  applyLocally: true, nonsequential: false, safeAbort: false
});
Firebase.ABORT_TRANSACTION_NOW = Object.create(null);
Firebase.worker = {};


var SlownessTracker = function SlownessTracker(record) {
  this.record = record;
  this.counted = false;
  this.canceled = false;
  this.handle = setTimeout(this.handleTimeout.bind(this), record.timeout);
};

SlownessTracker.prototype.handleTimeout = function handleTimeout () {
  if (this.canceled) { return; }
  this.counted = true;
  this.record.callback(++this.record.count, 1, this.record.timeout);
};

SlownessTracker.prototype.handleDone = function handleDone () {
  this.canceled = true;
  if (this.counted) {
    this.record.callback(--this.record.count, -1, this.record.timeout);
  } else {
    clearTimeout(this.handle);
  }
};


// jshint latedef:false
var FirebaseWorker = function FirebaseWorker(webWorker) {
  var this$1 = this;

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
  window.addEventListener('unload', function () {this$1._send({msg: 'destroy'});});
  setInterval(function () {this$1._send({msg: 'ping'});}, 60 * 1000);
};

FirebaseWorker.prototype.init = function init () {
    var this$1 = this;

  var items = [];
  try {
    var storage = window.localStorage || window.sessionStorage;
    if (!storage) { return; }
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      items.push({key: key, value: storage.getItem(key)});
    }
  } catch (e) {
    // Some browsers don't like us accessing local storage -- nothing we can do.
  }
  return this._send({msg: 'init', storage: items}).then(
    function (ref) {
        var exposedFunctionNames = ref.exposedFunctionNames;
        var firebaseSdkVersion = ref.firebaseSdkVersion;

      Firebase.SDK_VERSION =
        firebaseSdkVersion + " (over " + (this$1._shared ? 'shared ' : '') + "fireworker)";
      for (var i = 0, list = exposedFunctionNames; i < list.length; i += 1) {
        var name = list[i];

          Firebase.worker[name] = this$1.bindExposedFunction(name);
      }
    }
  );
};

FirebaseWorker.prototype.activate = function activate (enabled) {
  if (this._active === enabled) { return; }
  this._active = enabled;
  if (enabled) {
    this._receiveMessages(this._inboundMessages);
    this._inboundMessages = [];
    if (this._outboundMessages.length) { setImmediate(this._flushMessageQueue); }
  }
};

FirebaseWorker.prototype.debugPermissionDeniedErrors = function debugPermissionDeniedErrors (simulatedTokenGenerator, maxSimulationDuration, callFilter) {
  this._simulatedTokenGenerator = simulatedTokenGenerator;
  if (maxSimulationDuration !== undefined) { this._maxSimulationDuration = maxSimulationDuration; }
  this._simulatedCallFilter = callFilter || function() {return true;};
};

FirebaseWorker.prototype._send = function _send (message) {
    var this$1 = this;

  message.id = ++this._idCounter;
  var promise = new Promise(function (resolve, reject) {
    this$1._deferreds[message.id] = {resolve: resolve, reject: reject};
  });
  var deferred = this._deferreds[message.id];
  deferred.promise = promise;
  for (var name in message) { if (message.hasOwnProperty(name)) { deferred[name] = message[name]; } }
  if (!this._outboundMessages.length && this._active) { setImmediate(this._flushMessageQueue); }
  this._outboundMessages.push(message);
  return promise;
};

FirebaseWorker.prototype._flushMessageQueue = function _flushMessageQueue () {
  // console.log('send', this._outboundMessages);
  this._port.postMessage(this._outboundMessages);
  this._outboundMessages = [];
};

FirebaseWorker.prototype._receive = function _receive (event) {
  // console.log('receive', event.data);
  if (this._active) {
    this._receiveMessages(event.data);
  } else {
    this._inboundMessages = this._inboundMessages.concat(event.data);
  }
};

FirebaseWorker.prototype._receiveMessages = function _receiveMessages (messages) {
    var this$1 = this;

  for (var i = 0, list = messages; i < list.length; i += 1) {
    var message = list[i];

      var fn = this$1[message.msg];
    if (typeof fn !== 'function') { throw new Error('Unknown message: ' + message.msg); }
    fn.call(this$1, message);
  }
};

FirebaseWorker.prototype.bindExposedFunction = function bindExposedFunction (name) {
  return (function() {
    return this._send({msg: 'call', name: name, args: Array.prototype.slice(arguments)});
  }).bind(this);
};

FirebaseWorker.prototype.resolve = function resolve (message) {
  var deferred = this._deferreds[message.id];
  if (!deferred) { throw new Error('fireworker received resolution to inexistent call'); }
  delete this._deferreds[message.id];
  deferred.resolve(message.result);
};

FirebaseWorker.prototype.reject = function reject (message) {
  var deferred = this._deferreds[message.id];
  if (!deferred) { throw new Error('fireworker received rejection of inexistent call'); }
  delete this._deferreds[message.id];
  this._hydrateError(message.error, deferred).then(function (error) {
    deferred.reject(error);
    emitError(error);
  });
};

FirebaseWorker.prototype._hydrateError = function _hydrateError (json, props) {
  var error = errorFromJson(json);
  var code = json.code || json.message;
  if (code && code.toLowerCase() === 'permission_denied') {
    return this._simulateCall(props).then(function (securityTrace) {
      if (securityTrace) {
        error.extra = error.extra || {};
        error.extra.debug = securityTrace;
      }
      return error;
    });
  } else {
    return Promise.resolve(error);
  }
};

FirebaseWorker.prototype._simulateCall = function _simulateCall (props) {
    var this$1 = this;

  if (!(this._simulatedTokenGenerator && this._maxSimulationDuration > 0)) {
    return Promise.resolve();
  }
  var simulatedCalls = [];
  switch (props.msg) {
    case 'set':
    case 'update':
      simulatedCalls.push({method: 'set', url: props.url, args: [props.value]});
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
  var auth = this.getAuth(getUrlRoot(props.url));
  var simulationPromise = this._simulatedTokenGenerator(auth && auth.uid).then(function (token) {
    return Promise.all(simulatedCalls.map(function (message) {
      message.msg = 'simulate';
      message.token = token;
      return this$1._send(message);
    }));
  }).then(function (securityTraces) {
    if (securityTraces.every(function (trace) { return trace === null; })) {
      return 'Unable to reproduce error in simulation';
    }
    return securityTraces.filter(function (trace) { return trace; }).join('\n\n');
  }).catch(function (e) {
    return 'Error running simulation: ' + e;
  });
  var timeoutPromise = new Promise(function (resolve) {
    setTimeout(resolve.bind(null, 'Simulated call timed out'), this$1._maxSimulationDuration);
  });
  return Promise.race([simulationPromise, timeoutPromise]);
};

FirebaseWorker.prototype.updateLocalStorage = function updateLocalStorage (items) {
  try {
    var storage = window.localStorage || window.sessionStorage;
    for (var item in items) {
      if (item.value === null) {
        storage.removeItem(item.key);
      } else {
        storage.setItem(item.key, item.value);
      }
    }
  } catch (e) {
    // If we're denied access, there's nothing we can do.
  }
};

FirebaseWorker.prototype.trackServer = function trackServer (rootUrl) {
  if (this._servers.hasOwnProperty(rootUrl)) { return; }
  var server = this._servers[rootUrl] = {
    offset: 0, lastUniqueKeyTime: 0, lastRandomValues: [], authListeners: []
  };
  var authCallbackId = this._registerCallback(this._authCallback.bind(this, server));
  var offsetUrl = rootUrl + "/.info/serverTimeOffset";
  this.on(offsetUrl, offsetUrl, [], 'value', function (offset) {server.offset = offset.val();});
  this._send({msg: 'onAuth', url: rootUrl, callbackId: authCallbackId});
};

FirebaseWorker.prototype.generateUniqueKey = function generateUniqueKey (rootUrl) {
  var server = this._servers[rootUrl];
  if (!server) {
    throw new Error('Internal assertion failure: server not initialized for ' + rootUrl);
  }
  var now = Date.now() + server.offset;
  var chars = new Array(20);
  var prefix = now;
  for (var i = 7; i >= 0; i--) {
    chars[i] = ALPHABET.charAt(prefix & 0x3f);
    prefix = Math.floor(prefix / 64);
  }
  if (now === server.lastUniqueKeyTime) {
    var i$1 = 11;
    while (i$1 >= 0 && server.lastRandomValues[i$1] === 63) {
      server.lastRandomValues[i$1] = 0;
      i$1 -= 1;
    }
    if (i$1 === -1) {
      throw new Error('Internal assertion failure: ran out of unique IDs for this millisecond');
    }
    server.lastRandomValues[i$1] += 1;
  } else {
    for (var i$2 = 0; i$2 < 12; i$2++) {
      // Make sure to leave some space for incrementing in the top nibble.
      server.lastRandomValues[i$2] = Math.floor(Math.random() * (i$2 ? 64 : 16));
    }
  }
  for (var i$3 = 0; i$3 < 12; i$3++) {
    chars[i$3 + 8] = ALPHABET[server.lastRandomValues[i$3]];
  }
  return chars.join('');
};

FirebaseWorker.prototype._authCallback = function _authCallback (server, auth) {
  server.auth = auth;
  for (var i = 0, list = server.authListeners; i < list.length; i += 1) {
      var listener = list[i];

      listener(auth);
    }
};

FirebaseWorker.prototype.onAuth = function onAuth (rootUrl, callback, context) {
  var listener = callback.bind(context);
  listener.callback = callback;
  listener.context = context;
  this._servers[rootUrl].authListeners.push(listener);
  listener(this.getAuth(rootUrl));
};

FirebaseWorker.prototype.offAuth = function offAuth (rootUrl, callback, context) {
  var authListeners = this._servers[rootUrl].authListeners;
  for (var i = 0; i < authListeners.length; i++) {
    var listener = authListeners[i];
    if (listener.callback === callback && listener.context === context) {
      authListeners.splice(i, 1);
      break;
    }
  }
};

FirebaseWorker.prototype.getAuth = function getAuth (rootUrl) {
  return this._servers[rootUrl].auth;
};

FirebaseWorker.prototype.authWithCustomToken = function authWithCustomToken (url, authToken, options) {
  return this._send({msg: 'authWithCustomToken', url: url, authToken: authToken, options: options});
};

FirebaseWorker.prototype.authAnonymously = function authAnonymously (url, options) {
  return this._send({msg: 'authAnonymously', url: url, options: options});
};

FirebaseWorker.prototype.authWithOAuthToken = function authWithOAuthToken (url, provider, credentials, options) {
  return this._send({msg: 'authWithOAuthToken', url: url, provider: provider, credentials: credentials, options: options});
};

FirebaseWorker.prototype.unauth = function unauth (url) {
  return this._send({msg: 'unauth', url: url});
};

FirebaseWorker.prototype.set = function set (url, value) {return this._send({msg: 'set', url: url, value: value});};
FirebaseWorker.prototype.update = function update (url, value) {return this._send({msg: 'update', url: url, value: value});};

FirebaseWorker.prototype.on = function on (listenerKey, url, terms, eventType, snapshotCallback, cancelCallback, context, options) {
  var handle = {
    listenerKey: listenerKey, eventType: eventType, snapshotCallback: snapshotCallback, cancelCallback: cancelCallback, context: context, msg: 'on', url: url, terms: terms,
    timeouts: slowCallbacks.read.map(function (record) { return new SlownessTracker(record); })
  };
  var callback = this._onCallback.bind(this, handle);
  this._registerCallback(callback, handle);
  // Keep multiple IDs to allow the same snapshotCallback to be reused.
  snapshotCallback.__callbackIds = snapshotCallback.__callbackIds || [];
  snapshotCallback.__callbackIds.push(handle.id);
  this._send({
    msg: 'on', listenerKey: listenerKey, url: url, terms: terms, eventType: eventType, callbackId: handle.id, options: options
  }).catch(function (error) {
    callback(error);
  });
};

FirebaseWorker.prototype.off = function off (listenerKey, url, terms, eventType, snapshotCallback, context) {
    var this$1 = this;

  var idsToDeregister = [];
  var callbackId;
  if (snapshotCallback) {
    if (snapshotCallback.__callbackIds) {
      var i = 0;
      while (i < snapshotCallback.__callbackIds.length) {
        var id = snapshotCallback.__callbackIds[i];
        var handle = this$1._callbacks[id];
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
    if (!callbackId) { return; }// no-op, callback never registered or already deregistered
  } else {
    for (var i$1 = 0, list = Object.keys(this._callbacks); i$1 < list.length; i$1 += 1) {
      var id$1 = list[i$1];

        var handle$1 = this$1._callbacks[id$1];
      if (handle$1.listenerKey === listenerKey && (!eventType || handle$1.eventType === eventType)) {
        idsToDeregister.push(id$1);
      }
    }
  }
  // Nullify callbacks first, then deregister after off() is complete.We don't want any
  // callbacks in flight from the worker to be invoked while the off() is processing, but we don't
  // want them to throw an exception either.
  for (var i$2 = 0, list$1 = idsToDeregister; i$2 < list$1.length; i$2 += 1) {
      var id$2 = list$1[i$2];

      this$1._nullifyCallback(id$2);
    }
  return this._send({msg: 'off', listenerKey: listenerKey, url: url, terms: terms, eventType: eventType, callbackId: callbackId}).then(function () {
    for (var i = 0, list = idsToDeregister; i < list.length; i += 1) {
        var id = list[i];

        this$1._deregisterCallback(id);
      }
  });
};

FirebaseWorker.prototype._onCallback = function _onCallback (handle, error, snapshotJson) {
  if (handle.timeouts) {
    for (var i = 0, list = handle.timeouts; i < list.length; i += 1) {
        var timeout = list[i];

        timeout.handleDone();
      }
  }
  if (error) {
    this._deregisterCallback(handle.id);
    this._hydrateError(error, handle).then(function (error) {
      if (handle.cancelCallback) { handle.cancelCallback.call(handle.context, error); }
      emitError(error);
    });
  } else {
    handle.snapshotCallback.call(handle.context, new Snapshot(snapshotJson));
  }
};

FirebaseWorker.prototype.once = function once (url, terms, eventType, options) {
  return this._send({msg: 'once', url: url, terms: terms, eventType: eventType, options: options}).then(function (snapshotJson) {
    return new Snapshot(snapshotJson);
  });
};

FirebaseWorker.prototype.transaction = function transaction (url, updateFunction, options) {
    var this$1 = this;

  var tries = 0;

  var attemptTransaction = function (oldValue, oldHash) {
    if (tries++ >= 25) { return Promise.reject(new Error('maxretry')); }
    var newValue;
    try {
      newValue = updateFunction(oldValue);
    } catch (e) {
      return Promise.reject(e);
    }
    if (newValue === Firebase.ABORT_TRANSACTION_NOW ||
        newValue === undefined && !options.safeAbort) {
      return {committed: false, snapshot: new Snapshot({url: url, value: oldValue})};
    }
    return this$1._send({msg: 'transaction', url: url, oldHash: oldHash, newValue: newValue, options: options}).then(function (result) {
      if (result.stale) {
        return attemptTransaction(result.value, result.hash);
      } else {
        return {committed: result.committed, snapshot: new Snapshot(result.snapshotJson)};
      }
    });
  };

  return attemptTransaction(null, null);
};

FirebaseWorker.prototype.onDisconnect = function onDisconnect (url, method, value) {
  return this._send({msg: 'onDisconnect', url: url, method: method, value: value});
};

FirebaseWorker.prototype.bounceConnection = function bounceConnection () {
  return this._send({msg: 'bounceConnection'});
};

FirebaseWorker.prototype.callback = function callback (ref) {
    var id = ref.id;
    var args = ref.args;

  var handle = this._callbacks[id];
  if (!handle) { throw new Error('Unregistered callback: ' + id); }
  handle.callback.apply(null, args);
};

FirebaseWorker.prototype._registerCallback = function _registerCallback (callback, handle) {
  handle = handle || {};
  handle.callback = callback;
  handle.id = "cb" + (++this._idCounter);
  this._callbacks[handle.id] = handle;
  return handle.id;
};

FirebaseWorker.prototype._nullifyCallback = function _nullifyCallback (id) {
  var handle = this._callbacks[id];
  if (handle.timeouts) {
    for (var i = 0, list = handle.timeouts; i < list.length; i += 1) {
        var timeout = list[i];

        timeout.handleDone();
      }
  }
  this._callbacks[id].callback = noop;
};

FirebaseWorker.prototype._deregisterCallback = function _deregisterCallback (id) {
  delete this._callbacks[id];
};


function attachCallback(promise, onComplete, operationKind) {
  promise = trackSlowness(promise, operationKind);
  if (!onComplete) { return promise; }
  return promise.then(
    function (result) {onComplete(null, result); return result;},
    function (error) {onComplete(error); return Promise.reject(error);}
  );
}

function trackSlowness(promise, operationKind) {
  var records = slowCallbacks[operationKind];
  if (!records.length) { return promise; }

  var timeouts = records.map(function (record) { return new SlownessTracker(record); });

  function opDone() {
    for (var i = 0, list = timeouts; i < list.length; i += 1) {
      var timeout = list[i];

      timeout.handleDone();
    }
  }

  promise = promise.then(function (result) {
    opDone();
    return result;
  }, function (error) {
    opDone();
    return Promise.reject(error);
  });

  return promise;
}

function errorFromJson(json) {
  if (!json || json instanceof Error) { return json; }
  var error = new Error();
  for (var propertyName in json) {
    if (!json.hasOwnProperty(propertyName)) { continue; }
    error[propertyName] = json[propertyName];
  }
  return error;
}

function emitError(error) {
  if (errorCallbacks.length) {
    setTimeout(function () {
      for (var i = 0, list = errorCallbacks; i < list.length; i += 1) {
        var callback = list[i];

        callback(error);
      }
    }, 0);
  }
}

function getUrlRoot(url) {
  var k = url.indexOf('/', 8);
  return k >= 8 ? url.slice(0, k) : url;
}

function noop() {}
noop.skipCallback = true;

window.Firebase = Firebase;
})();
