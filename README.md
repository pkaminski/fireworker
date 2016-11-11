# fireworker
Firebase in a web worker

## Limitations
- Only supports Firebase SDK 2.4.2.  Could probably be adapted to SDK 3.x but it's going to be harder since its source code is not available.
- Interactive authentication methods don't work; calling `authWithPassword`, `authWithOAuthPopup`, or `authWithOAuthRedirect` will throw an exception.  Instead, use your own server for login and call `authWithCustomToken`.
- Item priority is not currently implemented.  Because priority is stored out-of-band it's difficult to support it efficiently, and Firebase folks have indicated that it's essentially deprecated anyway.

## Installation
The package has two components: a script to include in the main client, and a script to load in the worker.  They come in three flavors:
1. ES2015 (also compatible with Buble with `dangerousForOf` turned on) in `src/client.js` and `src/worker.js`.
2. ES5 in `dist/client.js` and `dist/worker.js`.
3. Minified ES5 in `dist/client.min.js` and `dist/worker.min.js`.

The two components have different dependencies, but since they're both distributed in the same package the dependencies are not declared.  You'll have to add them in manually:
- client: [setimmediate](https://github.com/YuzuJS/setImmediate)
- worker: [Firebase 2.4.x](https://www.npmjs.com/package/firebase), [setimmediate](https://github.com/YuzuJS/setImmediate), [crypto-js](https://github.com/brix/crypto-js) (specifically the `core.js` and `sha1.js` modules).  The Firebase SDK must be loaded _after_ `worker.js`, even though the dependency is the other way around.

## Differences
- Some methods that used to have an immediate effect (e.g., `off` or `unauth`) are now async and return a promise.
- Some exceptions that would normally be thrown synchronously (e.g., bad URL, bad combination of query methods) will make an operation fail asynchronously instead.  This should only affect development, and just means that you should always specify an error / failure callback (or catch a promise rejection).
- `goOnline` and `goOffline` are purposely not support on the client, since they would affect all clients of a shared web worker.  If you need to use these, call them from the worker side instead.
- For `on` and `once`, if you set `callback.omitSnapshotValue = true` then the actual snapshot value won't be materialized and transmitted from the worker to the client.  Your callback (or promise, for `once`) will still get a snapshot, but calling methods that rely on the value &mdash; like `val` or `forEach` &mdash; will throw an exception.
- Errors thrown by a `transaction`'s `updateFunction` will be caught and returned as an error on the transaction, instead of propagating to the top level (and possibly getting ignored).

## Extra features
- For `transaction`, you can set some extra flags on the `updateFunction`.  Setting `safeAbort` to `true` will change any `undefined` return value to the original value passed into the transaction, to force Firebase to validate that it is still current against the server instead of aborting immediately.  Setting `nonsequential` to `true` will keep retrying the transaction in the face of interfering non-transactional operations, up to the usual max number of retries.  You can also set global defaults for all these flags (including the traditional `applyLocally`) on `Firebase.DefaultTransactionOptions`.  `applyLocally` starts out as `true` and the others as `false`.
