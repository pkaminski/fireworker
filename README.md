# fireworker
Firebase in a web worker

## Limitations
- Only support Firebase SDK 2.4.2.
- Interactive authentication methods don't work; calling `authWithPassword`, `authWithOAuthPopup`, or `authWithOAuthRedirect` will throw an exception.  Instead, use your own server for login and call `authWithCustomToken`.

## Differences
- Some methods that use to have an immediate effect (e.g., `off` or `unauth`) are now async and return a promise.
- Some exceptions that would normally be thrown synchronously (e.g., bad URL, bad combination of query methods) will make an operation fail asynchronously instead.  This should only affect development, and just means that you must always specify an error / failure callback (or catch a promise rejection).
- `goOnline` and `goOffline` are purposely not support on the client, since they would affect all clients of a shared web worker.  If you need to use these, call them from the worker side instead.
- `on` accepts an extra `options` argument (after `context`).  If you pass `{omitValue: true}` then it won't materialize or transmit the actual snapshot value from the worker to the client.  Your callback will still get a snapshot, but calling methods that rely on the value (like `val` or `forEach`) will throw an exception.
