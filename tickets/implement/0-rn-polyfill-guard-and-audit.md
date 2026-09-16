description: The phone's fix for "it cannot connect to anything" is a handful of small web APIs added by hand, and nothing fails today if someone deletes them or a library starts needing another one. Add tests that catch that, tidy two small leaks in the new code, and write down which other web APIs the phone is still missing.
files:
  - packages/reference-app-rn/polyfills/hermes.js (the three additions to guard; the AbortSignal cleanup arm)
  - packages/reference-app-rn/test/metro-babel/async-generator-cleanup.spec.ts (the pattern this spec follows)
  - packages/reference-app-rn/vitest.config.ts (adds a fourth project)
  - packages/reference-app-rn/index.js (where a boot audit would be called)
  - packages/reference-app-ns/src/polyfills/audit.ts (the probe-list pattern to mirror)
  - docs/reference-app-rn.md (§ Key Dependencies — record the audited surface)
difficulty: medium
repro: verified
----

# Guard the Hermes polyfills, and write down what is still missing

Commit `7a0fd6c` added three web APIs to `packages/reference-app-rn/polyfills/hermes.js` — `AbortSignal.timeout`, `AbortSignal.any`, and a `WebSocket.prototype.bufferedAmount` getter — after a device session on 2026-09-16 in which the phone could not open a connection to any other machine. With them, Dial Peer connected in 1.6 s, the phone held a relay reservation for the first time, and a cross-party `formStrand` completed through that relay.

Two things are still missing, and this ticket is both of them.

## Why there is no test today

Nothing in the repo fails if those three additions are deleted. The failure only appears on a phone, and it appears as a ten-second silence: `@libp2p/websockets` reads `websocket.bufferedAmount`, gets `undefined`, concludes the socket is full (`undefined < 4194304` is `false`), and waits for a drain that never comes, so libp2p's dial timeout fires with `AbortError: The operation was aborted` and no indication of the cause.

`test/metro-babel/async-generator-cleanup.spec.ts` is the precedent: a headless spec that reproduces a phone-only defect in Node by reconstructing the phone's conditions. The same approach works here.

## What the audit found

The three APIs were found one at a time by hitting them. Sweeping the dependency tree for the globals a Hermes bundle might not have turns up the following. Everything below was read from installed sources in `node_modules`; no device was involved, so each item says how far it was actually established.

**Not gaps — confirmed provided.**

- `queueMicrotask` (used by `@libp2p/utils`, `@libp2p/circuit-relay-v2`, `@libp2p/webrtc`) is installed by React Native's own startup, `Libraries/Core/setUpTimers.js`.
- `performance.now` (used by `p-retry`) is installed by `Libraries/Core/setUpPerformance.js`.
- `BroadcastChannel` is **not** needed. `@libp2p/peer-store` pulls `mortice`, whose `browser` build does need it — but `mortice@3.3.1` also ships `dist/src/react-native.js` and declares it in its package.json `react-native` field, and that variant is a bare `TypedEventEmitter` with no channel at all. Metro's default `resolverMainFields` puts `react-native` first, so the phone gets that one. (The NativeScript app resolves the `browser` variant instead, which is why it polyfills `BroadcastChannel` and this app does not.)
- `WebAssembly` is not reached. `@chainsafe/as-sha256` and `@chainsafe/as-chacha20poly1305` are pulled in by `@chainsafe/libp2p-noise`, but its package.json `browser` field maps `crypto/index.js` to `crypto/index.browser.js`, which re-exports `pureJsCrypto` from `crypto/js.js` — noble ciphers and hashes, no WebAssembly. This relies on Metro applying the `browser` field to an internal relative import, the same mechanism `mortice` depends on; `metro.config.js` hand-rewrites that field only for `@libp2p/crypto` and `@libp2p/webrtc`, so if a bundle ever fails to resolve `@chainsafe/as-*`, this is the mechanism that slipped.

**Real gaps, both to document rather than fix here.**

- **`crypto.subtle` provides only `digest`.** The polyfill file defines a `crypto.subtle` object with a single `digest` method. `@libp2p/crypto`'s `keys/index.js` calls `crypto.subtle.importKey` and `exportKey` for ECDSA and RSA keys, and `@libp2p/keychain` calls the AES-GCM surface (`encrypt`, `decrypt`, `deriveKey`) through `ciphers/aes-gcm.browser.js`. None of those exist, so any of them throws a `TypeError` the moment it is reached. The phone does not reach them: it uses Ed25519, whose browser variant is pure noble, and it does not use the libp2p keychain. This is a dormant path, not a working one — it is broken the moment anything asks for another key type, and the documentation should say so plainly rather than implying WebCrypto works.
- **`navigator.userAgent` is undefined.** React Native's `setUpNavigator.js` creates `global.navigator` with only `product: 'ReactNative'`. `libp2p/dist/src/user-agent.browser.js` interpolates `globalThis.navigator.userAgent` with no guard, so the phone announces itself in identify as `js-libp2p/<version> browser/undefined`. It does not throw (`navigator` itself exists), and remote peers see the odd string in their logs. Cosmetic; worth a line in the docs so nobody chases it as a bug later.

**One question a headless test cannot answer.** `libp2p/dist/src/connection-manager/dial-queue.js:250` does `throw new AggregateError(errors, 'All multiaddr dials failed')` when every address for a peer fails, and `@libp2p/logger` branches on `err instanceof AggregateError`. Whether Hermes (`hermes-2025-06-04-RNv0.79.3`, per `react-native/sdks/.hermesversion`) provides `AggregateError` was not determined — there is no Hermes VM in the tree, only the `hermesc` compiler, so it cannot be probed from here. If it is absent, a completely failed dial raises a `ReferenceError` from the throw statement itself and the per-address causes are lost, which would look exactly like the silence this ticket is about. This is what the on-device audit below is for.

## Two leaks in the committed polyfill

Both are in code that `7a0fd6c` added, and both were left alone deliberately: the committed version is the one verified on the device, and there was no phone available to re-verify a change against.

**`AbortSignal.any` never detaches its listeners.** It attaches an `abort` listener to every input signal and removes none of them when the combined signal settles. The `{ once: true }` option only removes the listener that actually fired; listeners on the signals that did *not* abort stay attached for as long as those signals live. The real caller on the phone is Optimystic's repo client (`../optimystic/packages/db-p2p/src/repo/client.ts:91`), which combines the caller's signal — potentially a long-lived shutdown or component signal — with a fresh per-request deadline controller on every remote block RPC. `p-wait-for` (pulled in by `libp2p`, `@libp2p/websockets`, `@libp2p/circuit-relay-v2`, `@libp2p/webrtc` and `@libp2p/tcp`) combines the same way at `index.js:79`. So on a phone left running, one listener accumulates on the long-lived signal per RPC. Note that libp2p's own internals mostly use the `any-signal` package instead, which removes its listeners on abort and offers a `clear()` — so the accumulation is driven by our sibling code and `p-wait-for`, not by libp2p directly.

The fix: when the combined signal aborts, remove the `abort` listener from every input; and return early without registering anything when an input is already aborted.

**`AbortSignal.timeout` leaves its timer running.** The returned signal's timer keeps running after the operation completes, then aborts a signal nobody is listening to. Bounded by the timeout (10 s for a dial), so this is a small cost rather than a growing one — but the same shape, and worth closing while the file is open.

While fixing it, correct the comment above it. It says the call deliberately uses "the raw timer: this runs before the `.ref()`/`.unref()` wrapper below". That is wrong: the polyfill body resolves the bare identifier `setTimeout` against the global at *call* time, and by the time any dial happens, the bottom of the same file has already replaced `globalThis.setTimeout` with the wrapper. The call gets the wrapper, and the handle it returns is an object, which matters for whatever clears it.

## Shape of the guard

Follow `test/metro-babel/async-generator-cleanup.spec.ts`: give it its own Vitest project rather than folding it into the `node` project. The reason is the same one that file records — the `node` project's `globalSetup` is the stale-build guard over compiled sibling output, and this spec runs none of it, so it should stay runnable while a sibling's `dist` is stale.

The polyfill file cannot simply be imported from a spec. Three obstacles, all solvable the way the Babel spec solves its own:

- It `require`s `react-native-get-random-values`, which requires `react-native` at module scope and fails in Node.
- It reads `__DEV__`, a Metro prelude global that does not exist in Node.
- It assigns to bare `Promise`, `AbortSignal` and `Symbol`, so importing it in-process would patch the test runner's own globals and the assertions would prove nothing.

Evaluate it instead in a controlled scope, exactly as the Babel spec builds its probe: read the file and wrap it in `new Function('require', 'module', 'exports', 'globalThis', 'Promise', 'AbortSignal', 'AbortController', 'Symbol', 'process', 'console', '__DEV__', source)`. Each of those names is then a parameter the spec supplies — a fake globals object that looks like Hermes plus React Native (no `AbortSignal.timeout`, no `AbortSignal.any`, a `WebSocket` class with no `bufferedAmount` anywhere on it), and a `require` that returns an empty object for `react-native-get-random-values` and delegates everything else to a `createRequire` rooted at the app's package.json.

What the spec should then assert, in rough order of value:

- The one that reproduces the outage: drive `@libp2p/websockets`' own `webSocketToMaConn` (`dist/src/websocket-to-conn.js`) over a fake socket that has no `bufferedAmount`, and assert `sendData(...)` reports `canSendMore: true`. Without the getter it reports `false` and the connection stalls, which is the actual device failure. This also fails usefully if a future `@libp2p/websockets` changes how it reads the property. If its `AbstractMultiaddrConnection` base turns out to need more setup than a fake socket can provide, say so in the spec's header comment rather than silently substituting a weaker check.
- `AbortSignal.timeout(ms)` aborts within a deadline, with `reason.name === 'TimeoutError'`.
- `AbortSignal.any([a, b])` aborts with the first input's reason, and returns an already-aborted signal when an input is already aborted.
- `AbortSignal.any` has detached its listener from the input that did *not* abort, once the combined signal aborts. This is the regression assertion for the leak arm above.
- Instances of the fake `WebSocket` read `bufferedAmount === 0`.

## Shape of the drift guard

The second spec is the one that catches the *next* missing API rather than these three. Scan a listed set of dependency `dist` directories for references to a fixed set of global names, and fail on any name that is neither provided by React Native's startup, nor installed by `polyfills/`, nor on an explicit allowlist that carries a one-line reason (the "not gaps" list above is that allowlist's starting content).

Be honest in the spec's header about what it is: a source grep over a hand-listed set of packages, not a walk of Metro's real module graph. A dependency nobody listed is invisible to it, and a global reached only through a computed property name is invisible to it. It narrows the window; it does not close it.

## Shape of the on-device audit

`packages/reference-app-ns/src/polyfills/audit.ts` already does this for the NativeScript app: a list of dotted global paths, each resolved against `globalThis` at boot and reported as `native`, `polyfilled` or `MISSING`, with a loud warning if anything is missing. It distinguishes `native` from `polyfilled` through a small registry (`registry.ts`) that each polyfill calls as it patches.

Add the equivalent for this app and call it from `index.js` after the polyfill imports, under `__DEV__` so release bundles carry nothing. This is what answers the `AggregateError` question, and it is the only thing that will notice when a React Native upgrade starts — or stops — providing one of these natively.

Do not try to share the probe list with the NativeScript app. The two runtimes have genuinely different surfaces (the NativeScript list probes `AbortController` itself, which Hermes has and NativeScript does not), so a shared list would need per-runtime exceptions and would be harder to read than two lists. Say that in a comment in both files so the duplication reads as a decision rather than an oversight.

## TODO

- Add a `polyfills` Vitest project to `packages/reference-app-rn/vitest.config.ts` covering `test/polyfills/**/*.spec.ts`, with no `globalSetup`, and extend the `node` project's `exclude` to match. Document the reasoning in the config's header comment alongside the existing three.
- Write `test/polyfills/hermes-polyfills.spec.ts`: evaluate `polyfills/hermes.js` in a controlled scope against a fake Hermes/React Native global surface, then assert the behaviours listed under "Shape of the guard".
- In `polyfills/hermes.js`, make `AbortSignal.any` remove its `abort` listener from every input once the combined signal aborts, and register nothing when an input is already aborted.
- In `polyfills/hermes.js`, clear `AbortSignal.timeout`'s timer once the signal has aborted, and replace the inaccurate "raw timer" comment with what actually happens.
- Write `test/polyfills/dependency-globals.spec.ts`: the drift guard, with its allowlist seeded from the "not gaps" findings above and a header comment that states its limits.
- Add `packages/reference-app-rn/polyfills/audit.js` plus the small registry the polyfills mark themselves in, mirroring the NativeScript pair, and call it from `index.js` under `__DEV__`.
- Record in `docs/reference-app-rn.md` § Key Dependencies: the three APIs and why the phone could not dial without them; that `crypto.subtle` provides only `digest` and which key operations therefore do not work; that `navigator.userAgent` is undefined and shows up in the identify agent version; and that `queueMicrotask`, `performance.now`, `BroadcastChannel` and `WebAssembly` were checked and are not gaps, with the reason for each.
- Run `yarn workspace @serfab/reference-app-rn test` and `yarn workspace @serfab/reference-app-rn typecheck`, plus `yarn lint`.
- Next device session (no device in this pipeline): confirm the boot audit reports no `MISSING` rows, and note what it says about `AggregateError` — if Hermes lacks it, a failed dial is reporting a `ReferenceError` instead of its real causes and needs its own ticket.
