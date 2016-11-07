(function() {
'use strict';

/* globals window */

var worker;

var ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
var MIN_INT32 = 1 << 31, MAX_INT32 = -(1 << 31) - 1;


var Snapshot = function Snapshot(ref) {
  var url = ref.url;
  var childrenKeys = ref.childrenKeys;
  var value = ref.value;
  var exists = ref.exists;
  var hasChildren = ref.hasChildren;

  this._url = url.replace(/\/$/, '');
  this._childrenKeys = childrenKeys;
  this._value = value;
  this._exists = exists;
  this._hasChildren = hasChildren;
};

Snapshot.prototype.exists = function exists () {
  return this._exists;
};

Snapshot.prototype.val = function val () {
  this._checkValue();
  return this._value;
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
  return this._url.replace(/.*\//, '');
};

Snapshot.prototype.numChildren = function numChildren () {
  this._checkValue();
  return this._childrenKeys ? this._childrenKeys.length : 0;
};

Snapshot.prototype.ref = function ref () {
  return new Firebase(this._url);
};

Snapshot.prototype._checkValue = function _checkValue () {
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

var Query = function Query(url, terms) {
  if (!worker) { throw new Error('Worker not connected'); }
  if (url.slice(0, 8) !== 'https://') { throw new Error('Firebase URL must start with "https://"'); }
  this._url = url.replace(/\/$/, '');
  this._terms = terms;
};

Query.prototype.on = function on (eventType, callback, cancelCallback, context, options) {
  // options = {omitValue: boolean}
  if (context === 'undefined' && typeof cancelCallback !== 'function') {
    context = cancelCallback;
    cancelCallback = undefined;
  }
  worker.on(
    this.toString(), this._url, this._terms, eventType, callback, cancelCallback, context,
    options);
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
  return worker.once(
    this._url, this._terms, eventType, successCallback, failureCallback, context);
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
        queryTerm += '=' + encodeURIComponent(term.slice(1).join(','));
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
    Query.call(this, url);
    worker.trackServer(this.root()._url);
  }

  if ( Query ) Firebase.__proto__ = Query;
  Firebase.prototype = Object.create( Query && Query.prototype );
  Firebase.prototype.constructor = Firebase;

  Firebase.prototype.authWithCustomToken = function authWithCustomToken (authToken, onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(worker.authWithCustomToken(this._url, authToken, options), onComplete);
  };

  Firebase.prototype.authAnonymously = function authAnonymously (onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(worker.authAnonymously(this._url, options), onComplete);
  };

  Firebase.prototype.authWithOAuthToken = function authWithOAuthToken (provider, credentials, onComplete, options) {
    if (!options && typeof onComplete === 'object') {
      options = onComplete;
      onComplete = null;
    }
    return attachCallback(
      worker.authWithCustomToken(this._url, provider, credentials, options), onComplete);
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
    worker.onAuth(this.root()._url, onComplete, context);
  };

  Firebase.prototype.offAuth = function offAuth (onComplete, context) {
    worker.offAuth(this.root()._url, onComplete, context);
  };

  Firebase.prototype.getAuth = function getAuth () {
    return worker.getAuth(this.root()._url);
  };

  Firebase.prototype.child = function child (childPath) {
    return new Firebase(((this._url) + "/" + (childPath.split('/').map(encodeURIComponent).join('/'))));
  };

  Firebase.prototype.parent = function parent () {
    var k = this._url.lastIndexOf('/');
    return k >= 8 ? new Firebase(this._url.slice(0, k)) : null;
  };

  Firebase.prototype.root = function root () {
    var k = this._url.indexOf('/', 8);
    return k >= 8 ? new Firebase(this._url.slice(0, k)) : this;
  };

  Firebase.prototype.key = function key () {
    return this._url.replace(/.*\//, '');
  };

  Firebase.prototype.set = function set (value, onComplete) {
    return attachCallback(worker.set(this._url, value), onComplete);
  };

  Firebase.prototype.update = function update (value, onComplete) {
    return attachCallback(worker.update(this._url, value), onComplete);
  };

  Firebase.prototype.remove = function remove (onComplete) {
    return attachCallback(worker.set(this._url, null), onComplete);
  };

  Firebase.prototype.push = function push (value, onComplete) {
    var child = this.child(worker.generateUniqueKey(this.root()));
    if (!value) { return child; }
    var promise = attachCallback(worker.set(child, value), onComplete);
    child.then = promise.then.bind(promise);
    child.catch = promise.catch.bind(promise);
    if (promise.finally) { child.finally = promise.finally.bind(promise); }
    return child;
  };

  Firebase.prototype.transaction = function transaction (updateFunction, onComplete, applyLocally) {
    // TODO: implement
    throw new Error('Not implemented');
  };

  Firebase.connectWorker = function connectWorker (webWorker) {
    if (worker) { throw new Error('Worker already connected'); }
    worker = new FirebaseWorker(webWorker);
  };

  Firebase.goOnline = function goOnline () {
    throw new Error('Global goOnline() call must be made from within the worker process');
  };

  Firebase.goOffline = function goOffline () {
    throw new Error('Global goOffline() call must be made from within the worker process');
  };

  return Firebase;
}(Query));

Firebase.ServerValue = Object.freeze({TIMESTAMP: Object.freeze({'.sv': 'timestamp'})});


// jshint latedef:false
var FirebaseWorker = function FirebaseWorker(webWorker) {
  var this$1 = this;

  this._idCounter = 0;
  this._deferreds = {};
  this._online = true;
  this._servers = {};
  this._callbacks = {};
  this._port = webWorker.port || webWorker;
  this._port.onmessage = this.receive.bind(this);
  this._send({msg: 'init'}).then(function (exposedMethodNames) {
    var worker = window.Firebase.worker = {};
    for (var i = 0, list = exposedMethodNames; i < list.length; i += 1) {
      var name = list[i];

      worker[name] = this$1._bindExposedFunction(name);
    }
  });
  // TODO: ping
};

FirebaseWorker.prototype._send = function _send (message) {
    var this$1 = this;

  message.id = ++this._idCounter;
  var promise = new Promise(function (resolve, reject) {
    this$1._deferreds[message.id] = {resolve: resolve, reject: reject};
  });
  this._deferreds[message.id].promise = promise;
  this._port.postMessage(message);
  return promise;
};

FirebaseWorker.prototype._receive = function _receive (event) {
  this[event.data.msg](event.data);
};

FirebaseWorker.prototype._bindExposedFunction = function _bindExposedFunction (name) {
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
  deferred.reject(errorFromJson(message.error));
};

FirebaseWorker.prototype.trackServer = function trackServer (rootUrl) {
  if (this._servers.hasOwnProperty(rootUrl)) { return; }
  var server = this._servers[rootUrl] = {
    offset: 0, lastUniqueKeyTime: 0, lastRandomValues: [], authListeners: []
  };
  var authCallbackId = this._registerCallback(this._authCallback.bind(this, server));
  this.on((rootUrl + "/.info/serverTimeOffset"), {}, 'value', function (offset) {
    server.offset = offset;
  });
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
    prefix >>>= 6;
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
  listener(this.getAuth());
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
  var handle = {listenerKey: listenerKey, eventType: eventType, snapshotCallback: snapshotCallback, cancelCallback: cancelCallback, context: context};
  var callback = this._onCallback.bind(this, handle);
  handle.id = this._registerCallback(callback);
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
  return this._send({msg: 'off', url: url, terms: terms, eventType: eventType, callbackId: callbackId}).then(function () {
    for (var i = 0, list = idsToDeregister; i < list.length; i += 1) {
        var id = list[i];

        this$1._deregisterCallback(id);
      }
  });
};

FirebaseWorker.prototype._onCallback = function _onCallback (handle, error, snapshotOptions) {
  if (error) {
    this._deregisterCallback(handle.id);
    if (handle.cancelCallback) { handle.cancelCallback.call(handle.context, errorFromJson(error)); }
  } else {
    handle.snapshotCallback(new Snapshot(snapshotOptions));
  }
};

FirebaseWorker.prototype.callback = function callback (ref) {
    var id = ref.id;
    var args = ref.args;

  var callback = this._callbacks[id];
  if (!callback) { throw new Error('Unregistered callback: ' + id); }
  callback.apply(null, args);
};

FirebaseWorker.prototype._registerCallback = function _registerCallback (callback) {
  var id = 'c' + (++this._idCounter);
  this._callbacks[id] = callback;
  return id;
};

FirebaseWorker.prototype._nullifyCallback = function _nullifyCallback (id) {
  this._callbacks[id] = noop;
};

FirebaseWorker.prototype._deregisterCallback = function _deregisterCallback (id) {
  delete this._callbacks[id];
};


function attachCallback(promise, onComplete) {
  if (!onComplete) { return promise; }
  return promise.then(function (result) {onComplete(result);}, function (error) {onComplete(error);});
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

function noop() {}

// TODO: hook unload to remove all listeners

window.Firebase = Firebase;
})();
