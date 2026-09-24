description: On the phone apps, every database request that finishes normally leaves a small cancellation hook behind on the caller's cancellation signal, so an app that runs for a long time with a long-lived signal slowly accumulates them.
files:
  - ../optimystic/packages/db-p2p/src/repo/client.ts (line ~91 — `AbortSignal.any([options.signal, deadlineController.signal])`, cleared by `clearTimeout(timer)` in `finally`)
  - packages/reference-app-rn/polyfills/hermes.js (`AbortSignal.any` polyfill — comment names this ticket)
  - packages/reference-app-ns/src/polyfills/abort.ts (NativeScript's `AbortSignal.any`, same shape)
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The growth is one small closure per successful request and only matters if callers pass a signal that lives for the whole session, which has not been confirmed for any caller.
----

## What happens

Neither phone runtime (Hermes under React Native, NativeScript) has `AbortSignal.any`, so both apps polyfill it. The polyfill adds an `abort` listener to every input signal and removes those listeners once the combined signal aborts. Browsers and Node do not need that removal step: the DOM spec holds combined signals weakly, so a combined signal that nobody references anymore is garbage-collected together with its hooks. A polyfill cannot do that without a garbage-collection callback (`FinalizationRegistry`), and neither runtime is known to provide one.

So when **none** of the inputs ever aborts, the listeners stay on the inputs for as long as those inputs live.

Optimystic's repo client does exactly that on its success path:

```ts
const deadlineController = new AbortController()
const timer = setTimeout(() => deadlineController.abort(new Error('RepoClient timeout')), deadlineMs)
const combinedSignal = options?.signal
	? AbortSignal.any([options.signal, deadlineController.signal])
	: deadlineController.signal
try { … } finally { clearTimeout(timer) }
```

When the RPC succeeds, the deadline controller is never aborted. The combined signal never aborts either, so one listener, holding the combined controller and its bookkeeping, stays on `options.signal` per request. If `options.signal` lives for a whole session (a node-lifetime shutdown signal, for example), these accumulate for as long as the app runs.

`p-wait-for`, the other caller named in the polyfill comments, is not affected: it pairs the caller's signal with `AbortSignal.timeout`, which always fires eventually.

## Confirming it

Not yet confirmed:
- Find which callers of `RepoClient` pass `options.signal`, and how long those signals live.
- On a device, or in a unit test using the React Native polyfill evaluated as in `test/polyfills/hermes-polyfills.spec.ts`, run N successful `AbortSignal.any([longLived, cleared])` combinations and count the listeners left on `longLived`. By reading the code, the count is N.

## Expected

A request that completes, whether it succeeds or fails, leaves nothing attached to the caller's signal, on every runtime. The fix most likely belongs at the call site, since the polyfill has no way to learn that a combination is finished. For example, the site could use a combination it can explicitly release (the `any-signal` package, which libp2p already uses, returns a signal with `clear()`), or abort the deadline controller in `finally`. Before choosing the second option, check what aborting after completion triggers downstream.
