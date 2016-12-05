# fireworker
Firebase in a web worker

## Limitations

- Only supports Firebase SDK 2.4.2.  Could probably be adapted to SDK 3.x but it's going to be harder since the source code is not available.
- Interactive authentication methods don't work; calling `authWithPassword`, `authWithOAuthPopup`, or `authWithOAuthRedirect` will throw an exception.  Instead, use your own server for login and call `authWithCustomToken`.
- Item priority is not currently implemented.  Because priority is stored out of band it's difficult to support efficiently, and Firebase folks have indicated that it's essentially deprecated anyway.


## Installation

The package has two components: a script to include in the main client, and a script to load in the worker.  They come in three flavors:
1. ES2015 in `src/client.js` and `src/worker.js`.  (Also compatible with Bublé's ES2015 subset with `dangerousForOf` turned on.)
2. ES5 in `dist/client.js` and `dist/worker.js`.
3. Minified ES5 in `dist/client.min.js` and `dist/worker.min.js`.

The two components have different dependencies, but since they're both distributed in the same package the dependencies are not declared.  You'll have to package them in manually:
- client: [setimmediate](https://github.com/YuzuJS/setImmediate), and a `Promise` polyfill if you're targeting older browsers.
- worker: [Firebase 2.4.x](https://www.npmjs.com/package/firebase), [setimmediate](https://github.com/YuzuJS/setImmediate), [crypto-js](https://github.com/brix/crypto-js) (specifically the `core.js` and `sha1.js` modules), and a `Promise` polyfill if you're targeting older browsers.  The Firebase SDK must be loaded _after_ `worker.js`, even though the dependency is the other way around.


## Initialization

On the client side, you need to create the worker and connect it to the client, like so:
```js
var WorkerClass = window.SharedWorker || window.Worker;
if (!WorkerClass) throw new Error("Browser doesn't support web workers -- panic!");
Firebase.connectWorker(new WorkerClass("/path/to/worker/code.js"));
```

Optionally, you can optimize your startup performance by initializing the worker early, then connecting it to the `Firebase` shim later, when your code has loaded.  This will let the worker connect to Firebase and authenticate the user (if there's a saved session) while your main page is loading.  Put this script early on your page:

```
<script async>
  var WorkerClass = window.SharedWorker || window.Worker;
  if (WorkerClass) {
    window.firebaseWorker = new WorkerClass('/path/to/worker/code.js');
    var storage = window.localStorage || window.sessionStorage;
    var items = [];
    for (var i = 0; i < storage.length; i++) {
      items.push({key: storage.key(i), value: storage.getItem(storage.key(i))});
    }
    (window.firebaseWorker.port || window.firebaseWorker).postMessage([{
      msg: 'init', oneWay: true, storage: items,
      url: 'https://YOUR_FIREBASE_NAME.firebaseio.com'
    }]);
  }
</script>
```

Then in your app, you connect the worker like this:

```js
if (!window.firebaseWorker) throw new Error("Browser doesn't support web workers -- panic!");
Firebase.connectWorker(window.firebaseWorker);
```

You don't need to do anything special on the worker side.


## Differences

- Some methods that used to have an immediate effect (e.g., `off` or `unauth`) are now async and return a promise.
- Some exceptions that would normally be thrown synchronously (e.g., bad URL, bad combination of query methods) will make an operation fail asynchronously instead.  This should only affect development, and just means that you should always specify an error / failure callback (or catch a promise rejection).
- `goOffline` will only prevent the client from communicating with the worker, preventing any reads and writes from being executed until `goOnline` is invoked.  Unlike in normal Firebase writes _will not_ be applied locally while "offline", and the connection to Firebase will not be closed.  If needed, you can call `goOffline` from within the worker for the original semantics (affecting all clients), or use `Firebase.bounceConnection()` to execute a `goOffline()` / `goOnline()` pair that will force Firebase to reconnect to the server.
- `enableLogging` can only be called from within the worker.
- Errors thrown by a `transaction`'s `updateFunction` will be caught and returned as an error on the transaction, instead of propagating to the top level (and possibly getting ignored).


## Extra features

### Snapshot control
For `on` and `once`, you can set extra flags on the callback function:
  - `omitSnapshotValue`: if truthy, the actual snapshot value won't be materialized and transmitted from the worker to the client.  Your callback (or promise, for `once`) will still get a snapshot, but calling methods that rely on the value &mdash; like `val` or `forEach` &mdash; will throw an exception.
And these flags are only applicable to `on`:
  - `skipCurrent`: if truthy, your callback won't be invoked for any currently cached values, only for values that arrive from the server in the future.
  - `skipCallback`: if truthy, your callback won't be invoked at all &mdash; this is useful for keeping a value synced for the benefit of other transient listeners without the overhead of creating and transmitting snapshots to the client.

### Transaction tweaks
For `transaction`, you can set some extra flags on the `updateFunction`:
  - `safeAbort`: if truthy, any `undefined` value returned by your update function will be substituted with the original value passed into the transaction, to force Firebase to validate that it is still current against the server instead of aborting immediately.  (You can also return `Firebase.ABORT_TRANSACTION_NOW` from `updateFunction` to override this on case-by-case basis.)
  - `nonsequential`: if truthy, will keep retrying the transaction in the face of interfering non-transactional operations, up to the usual max number of retries.
You can also set global defaults for all these flags (including the traditional `applyLocally`) on `Firebase.DefaultTransactionOptions`.  `applyLocally` starts out as `true` and the others as `false`.

### Global error listener
You can use `Firebase.onError(callback)` to attach a handler that will be invoked for any error emitted by a Firebase function, and `Firebase.offError(callback)` to detach it.

The callback will be invoked through `setTimeout` so you'll have a chance to catch the error locally first, and perhaps set a flag on it to indicate that it's been dealt with.  This mechanism is essentially equivalent to the unhandled promise rejection handler that some browsers support, but specialized to only functions that you call on the worker.

### Global slow operation listeners
You can get a callback whenever any read or write operation takes too long.  Use `Firebase.onSlow(operationKind, timeout, callback)` to attach a handler, where `operationKind` is one of `'read'`, `'write'`, `'auth'`, `'onDisconnect'`, or `'all'`, and `timeout` is the duration in milliseconds after which to invoke the callback if the operation has not yet been acknowledged by the Firebase server.  Use `Firebase.offSlow(operationKind, callback)` to detach the handler.

The callback will be invoked with three arguments:
- `outstandingCount`, the current number of outstanding slow operations (for the given timeout).
- `delta`, which indicates whether the count just increased or decreased with +1 and -1 respectively.
- `timeout`, the timeout value specified for this handler.

### Permission denied debugging
You can have any operations that failed due to a permission denied error retried automatically to provide more details about which security rule failed.  The details are attached to the `error` as `error.extra.debug`.  You'll need to have a server to issue a special short-term auth token with the `simulated` and `debug` flags set.  To set this up, call `Firebase.debugPermissionDeniedErrors(simulatedTokenGenerator, maxSimulationDuration, callFilter)` with:
- `simulatedTokenGenerator`, a function that given a `uid` returns a promise that resolve to a Firebase auth token for that user with `simulated` and `debug` set to true.  You can generate such a token in Node.js like this, for example:
```js
const FirebaseTokenGenerator = require('firebase-token-generator');
const tokenGenerator = new FirebaseTokenGenerator('<YOUR_FIREBASE_SECRET>');
const token = tokenGenerator.createToken({uid: uid}, {simulate: true, debug: true});
```
- `maxSimulationDuration`, the maximum duration in milliseconds to allow for the debug token to be issued and the simulated call(s) to complete.  The callback and promise on the original failing call won't be resolved until the simulation finishes one way or another.  Defaults to 5 seconds.
- `callFilter`, a function that decides which "permission denied" failed calls to debug.  It gets passed the method name (which may not match the original you called precisely, e.g. `remove` and `push` both show up as `set`) and the url, and returns true to simulate the call.  Returns true by default.

### Custom worker functions
Sometimes you need to augment the worker directly with extra code that needs to run on the original Firebase SDK (e.g., [Firecrypt](https://github.com/pkaminski/firecrypt)), and expose some means of configuring or controlling this code to the client.  You can do this calling `Fireworker.expose(myCustomFunction, name)` for each function you'd like to make callable from the client; you must do this before any client has connected &mdash; basically when the worker script is loading.  (The `name` is optional and defaults to the function's name, but can be useful if you minify your code.)

On the client, you can then call `Firebase.worker.myCustomFunction()`.  You can pass simple arguments (not callback functions, though!) and will get a promise in return, that will resolve to the return value of the original function executing in the worker.  These exposed functions are only available once the client's connection has been initialized, as indicated by the promise returned from `Firebase.connectWorker()` resolving.

Sometimes, you need to make sure that a custom function gets invoked before any Firebase operation takes place.  You can accomplish this like so:
```
Firebase.connectWorker(firebaseWorker);
Firebase.preExpose('myCustomFunction');
Firebase.worker.myCustomFunction();
```
Note that if `myCustomFunction` isn't actually exposed by the worker code, the function call will fail (asychronously).

