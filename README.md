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
if (!WorkerClass) throw new Error('Browser doesn\'t support web workers -- panic!');
Firebase.connectWorker(new WorkerClass('/path/to/worker/code.js'));
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
if (!window.firebaseWorker) throw new Error('Browser doesn\'t support web workers -- panic!');
Firebase.connectWorker(window.firebaseWorker);
```

You don't need to do anything special on the worker side.


## Differences

- Some methods that used to have an immediate effect (e.g., `off` or `unauth`) are now async and return a promise.
- Some exceptions that would normally be thrown synchronously (e.g., bad URL, bad combination of query methods) will make an operation fail asynchronously instead.  This should only affect development, and just means that you should always specify an error / failure callback (or catch a promise rejection).
- `goOnline` and `goOffline` are purposely not support on the client, since they would affect all clients of a shared web worker.  If you need to use these, call them from the worker side instead.
- Errors thrown by a `transaction`'s `updateFunction` will be caught and returned as an error on the transaction, instead of propagating to the top level (and possibly getting ignored).


## Extra features

For `on` and `once`, you can set extra flags on the callback function:
  - `omitSnapshotValue`: if truthy, the actual snapshot value won't be materialized and transmitted from the worker to the client.  Your callback (or promise, for `once`) will still get a snapshot, but calling methods that rely on the value &mdash; like `val` or `forEach` &mdash; will throw an exception.
  - `skipCallback`: if truthy, your callback won't be invoked at all &mdash; this is useful for keeping a value synced for the benefit of other transient listeners without the overhead of creating and transmitting snapshots to the client.

For `transaction`, you can set some extra flags on the `updateFunction`:
  - `safeAbort`: if truthy, any `undefined` value returned by your update function will be substituted with the original value passed into the transaction, to force Firebase to validate that it is still current against the server instead of aborting immediately.  (You can also return `Firebase.ABORT_TRANSACTION_NOW` from `updateFunction` to override this on case-by-case basis.)
  - `nonsequential`: if truthy, will keep retrying the transaction in the face of interfering non-transactional operations, up to the usual max number of retries.
You can also set global defaults for all these flags (including the traditional `applyLocally`) on `Firebase.DefaultTransactionOptions`.  `applyLocally` starts out as `true` and the others as `false`.

- TODO: document exposing custom worker functions

