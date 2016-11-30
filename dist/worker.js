(function() {
'use strict';

/* globals Firebase, CryptoJS, setImmediate, setInterval, self */

var fireworkers = [];
var simulationQueue = Promise.resolve(), consoleIntercepted = false, simulationConsoleLogs;


var LocalStorage = function LocalStorage() {
  this._items = [];
  this._pendingItems = [];
  this._initialized = false;
  this._flushPending = this.flushPending.bind(this);
};

var prototypeAccessors = { length: {} };

LocalStorage.prototype.init = function init (items) {
  if (!this._initialized) {
    this._items = items;
    this._initialized = true;
  }
};

LocalStorage.prototype._update = function _update (item) {
  if (!this._pendingItems.length) { setImmediate(this._flushPending); }
  this._pendingItems.push(item);
};

LocalStorage.prototype.flushPending = function flushPending () {
  if (!fireworkers.length) { return; }
  fireworkers[0]._send({msg: 'updateLocalStorage', items: this._pendingItems});
  this._pendingItems = [];
};

prototypeAccessors.length.get = function () {return this._items.length;};

LocalStorage.prototype.key = function key (n) {
  return this._items[n].key;
};

LocalStorage.prototype.getItem = function getItem (key) {
  for (var i = 0, list = this._items; i < list.length; i += 1) {
    var item = list[i];

      if (item.key === key) { return item.value; }
  }
  return null;
};

LocalStorage.prototype.setItem = function setItem (key, value) {
  var targetItem;
  for (var i = 0, list = this._items; i < list.length; i += 1) {
    var item = list[i];

      if (item.key === key) {
      targetItem = item;
      item.value = value;
      break;
    }
  }
  if (!targetItem) {
    targetItem = {key: key, value: value};
    this._items.push(targetItem);
  }
  this._update(targetItem);
};

LocalStorage.prototype.removeItem = function removeItem (key) {
    var this$1 = this;

  for (var i = 0; i < this._items.length; i++) {
    if (this$1._items[i].key === key) {
      this$1._items.splice(i, 1);
      this$1._update({key: key, value: null});
      break;
    }
  }
};

LocalStorage.prototype.clear = function clear () {
    var this$1 = this;

  for (var item in this._items) {
    this$1._update({key: item.key, value: null});
  }
  this._items = [];
};

Object.defineProperties( LocalStorage.prototype, prototypeAccessors );

self.localStorage = new LocalStorage();


var Fireworker = function Fireworker(port) {
  this.ping();
  this._port = port;
  this._callbacks = {};
  this._messages = [];
  this._flushMessageQueue = this._flushMessageQueue.bind(this);
  port.onmessage = this._receive.bind(this);
};

Fireworker.prototype.init = function init (ref) {
    var storage = ref.storage;
    var url = ref.url;

  if (storage) { self.localStorage.init(storage); }
  if (url) { new Firebase(url); }
  return {
    exposedFunctionNames: Object.keys(Fireworker._exposed),
    firebaseSdkVersion: Firebase.SDK_VERSION
  };
};

Fireworker.prototype.destroy = function destroy () {
    var this$1 = this;

  for (var key in this._callbacks) {
    var callback = this$1._callbacks[key];
    if (callback.cancel) { callback.cancel(); }
  }
  this._callbacks = {};
  this._port.onmessage = null;
  this._messages = [];
  var k = fireworkers.indexOf(this);
  if (k >= 0) { fireworkers[k] = null; }
};

Fireworker.prototype.ping = function ping () {
  this.lastTouched = Date.now();
};

Fireworker.prototype.bounceConnection = function bounceConnection () {
  Firebase.goOffline();
  Firebase.goOnline();
};

Fireworker.prototype._receive = function _receive (event) {
    var this$1 = this;

  Fireworker._firstMessageReceived = true;
  this.lastTouched = Date.now();
  for (var i = 0, list = event.data; i < list.length; i += 1) {
      var message = list[i];

      this$1._receiveMessage(message);
    }
};

Fireworker.prototype._receiveMessage = function _receiveMessage (message) {
    var this$1 = this;

  var promise;
  try {
    var fn = this[message.msg];
    if (typeof fn !== 'function') { throw new Error('Unknown message: ' + message.msg); }
    promise = Promise.resolve(fn.call(this, message));
  } catch(e) {
    promise = Promise.reject(e);
  }
  if (!message.oneWay) {
    promise.then(function (result) {
      this$1._send({msg: 'resolve', id: message.id, result: result});
    }, function (error) {
      this$1._send({msg: 'reject', id: message.id, error: errorToJson(error)});
    });
  }
};

Fireworker.prototype._send = function _send (message) {
  if (!this._messages.length) { setImmediate(this._flushMessageQueue); }
  this._messages.push(message);
};

Fireworker.prototype._flushMessageQueue = function _flushMessageQueue () {
  this._port.postMessage(this._messages);
  this._messages = [];
};

Fireworker.prototype.call = function call (ref) {
    var name = ref.name;
    var args = ref.args;

  try {
    return Promise.resolve(Fireworker._exposed[name].apply(null, args));
  } catch (e) {
    return Promise.reject(e);
  }
};

Fireworker.prototype.authWithCustomToken = function authWithCustomToken (ref) {
    var url = ref.url;
    var authToken = ref.authToken;
    var options = ref.options;

  return createRef(url).authWithCustomToken(authToken, options);
};

Fireworker.prototype.authAnonymously = function authAnonymously (ref) {
    var url = ref.url;
    var options = ref.options;

  return createRef(url).authAnonymously(options);
};

Fireworker.prototype.authWithOAuthToken = function authWithOAuthToken (ref) {
    var url = ref.url;
    var provider = ref.provider;
    var credentials = ref.credentials;
    var options = ref.options;

  return createRef(url).authWithOAuthToken(provider, credentials, options);
};

Fireworker.prototype.unauth = function unauth (ref) {
    var url = ref.url;

  return createRef(url).unauth();
};

Fireworker.prototype.onAuth = function onAuth (ref) {
    var url = ref.url;
    var callbackId = ref.callbackId;

  var authCallback = this._callbacks[callbackId] = this._onAuthCallback.bind(this, callbackId);
  authCallback.cancel = this._offAuth.bind(this, url, authCallback);
  createRef(url).onAuth(authCallback);
};

Fireworker.prototype._offAuth = function _offAuth (url, authCallback) {
  createRef(url).offAuth(authCallback);
};

Fireworker.prototype._onAuthCallback = function _onAuthCallback (callbackId, auth) {
  this._send({msg: 'callback', id: callbackId, args: [auth]});
};

Fireworker.prototype.set = function set (ref) {
    var url = ref.url;
    var value = ref.value;

  return createRef(url).set(value);
};

Fireworker.prototype.update = function update (ref) {
    var url = ref.url;
    var value = ref.value;

  return createRef(url).update(value);
};

Fireworker.prototype.on = function on (ref) {
    var listenerKey = ref.listenerKey;
    var url = ref.url;
    var terms = ref.terms;
    var eventType = ref.eventType;
    var callbackId = ref.callbackId;
    var options = ref.options;

  options = options || {};
  options.orderChildren = false;
  if (terms) {
    for (var i = 0, list = terms; i < list.length; i += 1) {
      var term = list[i];

        if (term[0] === 'orderByChild' || term[0] === 'orderByValue') {
        options.orderChildren = true;
        break;
      }
    }
  }
  var snapshotCallback = this._callbacks[callbackId] =
    this._onSnapshotCallback.bind(this, callbackId, options);
  snapshotCallback.listenerKey = listenerKey;
  snapshotCallback.eventType = eventType;
  snapshotCallback.cancel = this.off.bind(this, {listenerKey: listenerKey, url: url, terms: terms, eventType: eventType, callbackId: callbackId});
  var cancelCallback = this._onCancelCallback.bind(this, callbackId);
  createRef(url, terms).on(eventType, snapshotCallback, cancelCallback);
};

Fireworker.prototype.off = function off (ref) {
    var this$1 = this;
    var listenerKey = ref.listenerKey;
    var url = ref.url;
    var terms = ref.terms;
    var eventType = ref.eventType;
    var callbackId = ref.callbackId;

  var snapshotCallback;
  if (callbackId) {
    // Callback IDs will not be reused across on() calls, so it's safe to just delete it.
    snapshotCallback = this._callbacks[callbackId];
    delete this._callbacks[callbackId];
  } else {
    for (var i = 0, list = Object.keys(this._callbacks); i < list.length; i += 1) {
      var key = list[i];

        if (!this$1._callbacks.hasOwnProperty(key)) { continue; }
      var callback = this$1._callbacks[key];
      if (callback.listenerKey === listenerKey &&
          (!eventType || callback.eventType === eventType)) {
        delete this$1._callbacks[key];
      }
    }
  }
  createRef(url, terms).off(eventType, snapshotCallback);
};

Fireworker.prototype._onSnapshotCallback = function _onSnapshotCallback (callbackId, options, snapshot) {
  try {
    this._send({
      msg: 'callback', id: callbackId, args: [null, snapshotToJson(snapshot, options)]
    });
  } catch (e) {
    this._callbacks[callbackId].cancel();
    this._send({msg: 'callback', id: callbackId, args: [errorToJson(e)]});
  }
};

Fireworker.prototype._onCancelCallback = function _onCancelCallback (callbackId, error) {
  delete this._callbacks[callbackId];
  this._send({msg: 'callback', id: callbackId, args: [errorToJson(error)]});
};

Fireworker.prototype.once = function once (ref) {
    var url = ref.url;
    var terms = ref.terms;
    var eventType = ref.eventType;
    var options = ref.options;

  return createRef(url, terms).once(eventType).then(
    function (snapshot) { return snapshotToJson(snapshot, options); });
};

Fireworker.prototype.transaction = function transaction (ref$1) {
    var url = ref$1.url;
    var oldHash = ref$1.oldHash;
    var newValue = ref$1.newValue;
    var options = ref$1.options;

  var ref = createRef(url);
  var stale, currentValue, currentHash;

  return ref.transaction(function (value) {
    currentValue = value;
    currentHash = hashJson(value);
    stale = oldHash !== currentHash;
    if (stale) { return; }
    if (newValue === undefined && options.safeAbort) { return value; }
    return newValue;
  }, undefined, options.applyLocally).then(function (result) {
    if (stale) {
      return {stale: stale, value: currentValue, hash: currentHash};
    } else {
      return {
        stale: false, committed: result.committed, snapshotJson: snapshotToJson(result.snapshot)
      };
    }
  }, function (error) {
    if (options.nonsequential && error.message === 'set') {
      return ref.once('value').then(
        function (value) { return ({stale: true, value: value, hash: hashJson(value)}); });
    }
    return Promise.reject(error);
  });
};

Fireworker.prototype.onDisconnect = function onDisconnect (ref) {
    var url = ref.url;
    var method = ref.method;
    var value = ref.value;

  var onDisconnect = createRef(url).onDisconnect();
  return onDisconnect[method].call(onDisconnect, value);
};

Fireworker.prototype.simulate = function simulate (ref) {
    var token = ref.token;
    var method = ref.method;
    var url = ref.url;
    var args = ref.args;

  interceptConsoleLog();
  var simulatedFirebase;
  return (simulationQueue = simulationQueue.catch(function () {}).then(function () {
    simulationConsoleLogs = [];
    simulatedFirebase = createRef(url, null, 'permission_denied_simulator');
    simulatedFirebase.unauth();
    return simulatedFirebase.authWithCustomToken(token, function() {}, {remember: 'none'});
  }).then(function () {
    return simulatedFirebase[method].apply(simulatedFirebase, args);
  }).then(function () {
    return null;
  }, function (e) {
    var code = e.code || e.message;
    if (code && code.toLowerCase() === 'permission_denied') {
      return simulationConsoleLogs.join('\n');
    } else {
      return 'Got a different error in simulation: ' + e;
    }
  }));
};

Fireworker.expose = function expose (fn) {
  if (Fireworker._exposed.hasOwnProperty(fn.name)) {
    throw new Error(("Function " + (fn.name) + "() already exposed"));
  }
  if (Fireworker._firstMessageReceived) {
    throw new Error('Too late to expose function, worker in use');
  }
  Fireworker._exposed[fn.name] = fn;
};

Fireworker._exposed = {};
Fireworker._firstMessageReceived = false;


function interceptConsoleLog() {
  if (consoleIntercepted) { return; }
  var originalLog = console.log;
  var lastTestIndex;
  console.log = function() {
    var message = Array.prototype.join.call(arguments, ' ');
    if (!/^(FIREBASE: \n?)+/.test(message)) { return originalLog.apply(console, arguments); }
    message = message
      .replace(/^(FIREBASE: \n?)+/, '')
      .replace(/^\s+([^.]*):(?:\.(read|write|validate):)?.*/g, function(match, g1, g2) {
        g2 = g2 || 'read';
        return ' ' + g2 + ' ' + g1;
      });
    if (/^\s+/.test(message)) {
      var match = message.match(/^\s+=> (true|false)/);
      if (match) {
        simulationConsoleLogs[lastTestIndex] =
          (match[1] === 'true' ? ' \u2713' : ' \u2717') + simulationConsoleLogs[lastTestIndex];
        lastTestIndex = undefined;
      } else {
        if (lastTestIndex === simulationConsoleLogs.length - 1) { simulationConsoleLogs.pop(); }
        simulationConsoleLogs.push(message);
        lastTestIndex = simulationConsoleLogs.length - 1;
      }
    } else if (/^\d+:\d+: /.test(message)) {
      simulationConsoleLogs.push('   ' + message);
    } else {
      if (lastTestIndex === simulationConsoleLogs.length - 1) { simulationConsoleLogs.pop(); }
      simulationConsoleLogs.push(message);
      lastTestIndex = undefined;
    }
  };
  consoleIntercepted = true;
}

function errorToJson(error) {
  var json = {name: error.name};
  var propertyNames = Object.getOwnPropertyNames(error);
  for (var i = 0, list = propertyNames; i < list.length; i += 1) {
    var propertyName = list[i];

    json[propertyName] = error[propertyName];
  }
  return json;
}

function snapshotToJson(snapshot, options) {
  var url = snapshot.ref().toString();
  if (options && options.omitValue) {
    return {url: url, exists: snapshot.exists(), hasChildren: snapshot.hasChildren()};
  } else {
    var value = snapshot.val();
    var childrenKeys;
    if (options && options.orderChildren && typeof value === 'object') {
      for (var key in value) {
        if (!value.hasOwnProperty(key)) { continue; }
        // Non-enumerable properties won't be transmitted when sending.
        Object.defineProperty(value[key], '$key', {value: key});
      }
      childrenKeys = [];
      snapshot.forEach(function (child) {childrenKeys.push(child.$key);});
    }
    return {url: url, value: value, childrenKeys: childrenKeys};
  }
}

function createRef(url, terms, context) {
  try {
    var ref = new Firebase(url, context);
    if (terms) {
      for (var i = 0, list = terms; i < list.length; i += 1) {
        var term = list[i];

        ref = ref[term[0]].apply(ref, term.slice(1));
      }
    }
    return ref;
  } catch (e) {
    console.error(url, terms, e);
    throw e;
  }
}

function hashJson(json) {
  if (json === null) { return null; }
  var sha1 = CryptoJS.algo.SHA1.create();
  _hashJson(json, sha1);
  return 'sha1:' + sha1.finalize().toString();
}

function _hashJson(json, sha1) {
  var type = typeof json;
  if (type === 'object') {
    if (json === null) { type = 'null'; }
    else if (Array.isArray(json)) { type = 'array'; }
    else if (json instanceof Boolean) { type = 'boolean'; }
    else if (json instanceof Number) { type = 'number'; }
    else if (json instanceof String) { type = 'string'; }
  }
  switch (type) {
    case 'undefined': sha1.update('u'); break;
    case 'null': sha1.update('n'); break;
    case 'boolean': sha1.update(json ? 't' : 'f'); break;
    case 'number': sha1.update('x' + json); break;
    case 'string': sha1.update('s' + json); break;
    case 'array':
      sha1.update('[');
      for (var i = 0; i < json.length; i++) { _hashJson(json[i], sha1); }
      sha1.update(']');
      break;
    case 'object':
      sha1.update('{');
      var keys = Object.keys(json);
      keys.sort();
      for (var i$1 = 0; i$1 < keys.length; i$1++) { _hashJson(json[keys[i$1]], sha1); }
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

var CONNECTION_CHECK_INTERVAL = 60 * 1000;
var lastConnectionCheck = Date.now();
setInterval(function findAbandonedConnections() {
  var now = Date.now(), gap = now - lastConnectionCheck - CONNECTION_CHECK_INTERVAL;
  lastConnectionCheck = now;
  fireworkers.forEach(function (worker) {
    if (!worker) { return; }
    if (gap >= 1000 && worker.lastTouched <= now - gap) { worker.lastTouched += gap; }
    if (now - worker.lastTouched >= 3 * CONNECTION_CHECK_INTERVAL) { worker.destroy(); }
  });
  var k;
  while ((k = fireworkers.indexOf(null)) >= 0) { fireworkers.splice(k, 1); }
}, CONNECTION_CHECK_INTERVAL);

self.Fireworker = Fireworker;
self.window = self;
acceptConnections();

})();
