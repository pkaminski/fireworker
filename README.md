# fireworker
Firebase in a web worker

## Limitations
- Only supports Firebase SDK 2.4.2.  Could probably be adapted to SDK 3.x but it's going to be harder since its source code is not available.
- Interactive authentication methods don't work; calling `authWithPassword`, `authWithOAuthPopup`, or `authWithOAuthRedirect` will throw an exception.  Instead, use your own server for login and call `authWithCustomToken`.
- Item priority is not currently implemented.  Because priority is stored out-of-band it's difficult to support it efficiently, and Firebase folks have indicated that it's essentially deprecated anyway.

## Differences
- Some methods that used to have an immediate effect (e.g., `off` or `unauth`) are now async and return a promise.
- Some exceptions that would normally be thrown synchronously (e.g., bad URL, bad combination of query methods) will make an operation fail asynchronously instead.  This should only affect development, and just means that you should always specify an error / failure callback (or catch a promise rejection).
- `goOnline` and `goOffline` are purposely not support on the client, since they would affect all clients of a shared web worker.  If you need to use these, call them from the worker side instead.
- For `on` and `once`, if you set `callback.omitSnapshotValue = true` then the actual snapshot value won't be materialized and transmitted from the worker to the client.  Your callback (or promise, for `once`) will still get a snapshot, but calling methods that rely on the value &mdash; like `val` or `forEach` &mdash; will throw an exception.
