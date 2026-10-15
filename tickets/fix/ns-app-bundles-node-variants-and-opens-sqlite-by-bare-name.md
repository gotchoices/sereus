description: Two NativeScript defects reported from a chat app built on `reference-app-ns`: webpack bundles `main-event`'s Node variant, which throws and catches a TypeError on every abort signal (~2% of a join's CPU on a Galaxy S7), and the app opens SQLite by bare name, which can fail at launch before an activity exists (GitHub #45, points 1 and 2).
files: packages/reference-app-ns/webpack.config.js (the `@libp2p/crypto` rewrite ~13-33 and ~97-123 is the template), packages/reference-app-ns/src/cadre-phone.ts (~127, `openOptimysticNSDb('sereus-peer-identity')`), packages/reference-app-ns/src/ns-storage.ts (~56), docs/reference-app-ns.md
----

# NativeScript: Node-variant bundles and SQLite opened by bare name

From kjeib's comment on gotchoices/sereus#45 (NativeScript 8.9, V8, sereus 1.15, Galaxy S7 and an emulator).

## 1. `main-event` bundled as its Node variant

`@nativescript/webpack` does not apply a package's `browser` map to its internal relative imports (the config's own comment, ~82-87, says so for `@libp2p/crypto`). `main-event`'s Node `setMaxListeners` calls the bundled `events` 3.3.0's static `setMaxListeners`, which does not exist, inside `try/catch`; libp2p calls it once per abort signal.

Fix: redirect `main-event/dist/src/events.js` to `events.browser.js` with a `NormalModuleReplacementPlugin`, the same mechanism as the crypto rewrite. Do not rewrite every Node variant: libp2p's browser user agent reads `navigator.userAgent`. The reporter lists other Node variants bundled (libp2p connection-manager constants, gater, user agent; `mortice`; `weald`; `@libp2p/utils` thin-waist; `multiformats` sha2); leave those unless one is measured to cost something.

## 2. SQLite opened by bare name

`@nativescript-community/sqlite` 3.x opens a bare name through `Application.android.foregroundActivity || startActivity`; a node started at launch sometimes fails with `Cannot read properties of undefined (reading 'openOrCreateDatabase')`. Pass `openOptimysticNSDb` a full path from `Utils.android.getApplicationContext().getDatabasePath(name)` (the opener's doc, `../optimystic/packages/db-p2p-storage-ns/src/ns-opener.ts` ~35-37, allows a full path).

## Not here

- The sqlite 4.x upgrade (native blob copies) is gated by `db-p2p-storage-ns`'s `^3.5.0` peer range: Optimystic's.
- WebSocket send coalescing: `backlog/feat-websocket-sends-coalesced-per-turn`.
- `@valor/nativescript-websockets`' per-byte `send()` copy is upstream (valor-software/nativescript-plugins#26). Its first fix leaked a JNI global reference per send; any shared NativeScript code that hands Java a fresh `ArrayBuffer` per message has the same problem.
