(function() {
'use strict';

/* globals Firebase, self */

// TODO: emulate localStorage via indexedDB and communication with client
// TODO: scan fireworkers regularly and destroy any that haven't been pinged in a while


var Fireworker = function Fireworker(port) {
  this._port = port;
  this._callbacks = {};
  port.onmessage = this._receive.bind(this);
};

Fireworker.prototype.destroy = function destroy () {
    var this$1 = this;

  for (var key in this._callbacks) {
    var callback = this$1._callbacks[key];
    if (callback.cancel) { callback.cancel(); }
  }
  this._callbacks = {};
  this._port.onmessage = null;
};

Fireworker.prototype._receive = function _receive (event) {
    var this$1 = this;

  Fireworker._firstMessageReceived = true;
  var promise;
  try {
    promise = Promise.resolve(this[event.data.msg](event.data));
  } catch(e) {
    promise = Promise.reject(e);
  }
  promise.then(function (result) {
    this$1._send({msg: 'resolve', id: event.data.id, result: result});
  }, function(error) {
    this._send({msg: 'reject', id: event.data.id, error: errorToJson(error)});
  });
};

Fireworker.prototype._send = function _send (message) {
  this._port.postMessage(message);
};

Fireworker.prototype.init = function init () {
  return Object.keys(Fireworker._exposed);
};

Fireworker.prototype.call = function call (ref) {
    var name = ref.name;
    var args = ref.args;

  try {
    return Promise.resolve(this._exposed[name].apply(null, args));
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

Fireworker.prototype.unauth = function unauth (url) {
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

  options.orderChildren = false;
  for (var i = 0, list = terms; i < list.length; i += 1) {
    var term = list[i];

      if (term[0] === 'orderByChild' || term[0] === 'orderByValue') {
      options.orderChildren = true;
      break;
    }
  }
  var snapshotCallback = this._callbacks[callbackId] =
    this._onSnapshotCallback.bind(this, callbackId, options);
  snapshotCallback.listenerKey = listenerKey;
  snapshotCallback.eventType = eventType;
  snapshotCallback.cancel = this.off.bind({listenerKey: listenerKey, url: url, terms: terms, eventType: eventType, callbackId: callbackId});
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
  var value = options.omitValue ? undefined : snapshot.val();
  var exists = snapshot.exists();
  var hasChildren = snapshot.hasChildren();
  var childrenKeys;
  if (!options.omitValue && options.orderChildren && hasChildren) {
    childrenKeys = [];
    snapshot.forEach(function (child) {
      for (var key in value) { if (value[key] === child) { childrenKeys.push(key); } }
    });
  }
  this._send({msg: 'callback', id: callbackId, args: [
    null, {url: snapshot.ref().toString(), childrenKeys: childrenKeys, value: value, exists: exists, hasChildren: hasChildren}
  ]});
};

Fireworker.prototype._onCancelCallback = function _onCancelCallback (callbackId, error) {
  delete this._callbacks[callbackId];
  this._send({msg: 'callback', id: callbackId, args: [errorToJson(error)]});
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


function errorToJson(error) {
  var json = {name: error.name};
  var propertyNames = Object.getOwnPropertyNames(error);
  for (var i = 0, list = propertyNames; i < list.length; i += 1) {
    var propertyName = list[i];

    json[propertyName] = error[propertyName];
  }
  return json;
}

function createRef(url, terms) {
  var ref = new Firebase(url);
  if (terms) {
    for (var i = 0, list = terms; i < list.length; i += 1) {
      var term = list[i];

      ref = ref[term[0]].apply(ref, term.slice(1));
    }
  }
  return ref;
}

var fireworkers = [];

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
acceptConnections();

})();
