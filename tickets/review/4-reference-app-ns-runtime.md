description: Review the new @serfab/reference-app-ns (NativeScript Core) package that proves the cadre/db-p2p/Quereus/Optimystic stack bundles + parses under NS V8/JSC. Bundle resolution (incl. the critical @libp2p/crypto browser rewrite) is agent-verified; runtime/device boot of the solo smoke is NOT — it needs an emulator with the native SQLite/WebSocket plugins.
prereq:
files: packages/reference-app-ns/webpack.config.js, packages/reference-app-ns/scripts/bundle-check.js, packages/reference-app-ns/src/polyfills/, packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/solo-smoke.ts, packages/reference-app-ns/app/app.ts, packages/reference-app-ns/package.json, package.json (root resolutions), packages/reference-app-rn/metro.config.js, ../optimystic/packages/db-p2p-storage-ns/
----

## What landed

New workspace package **`@serfab/reference-app-ns`** — a **NativeScript Core** (plain TS + XML)
app whose sole purpose is runtime validation of the Sereus/Optimystic stack on NS's V8/JSC
engine. This ticket is the *solo/forming-mode* milestone (create a local chat strand, insert +
echo a message, no drone, no network). Chat-connect UI lands in `reference-app-ns-chat` (seq 5),
e2e in `reference-app-ns-e2e` (seq 6) — both already in `implement/`, chained via `prereq`.

Package layout (all new unless noted):

```
packages/reference-app-ns/
  package.json              @serfab/reference-app-ns, hoistingLimits:workspaces, deps + scripts
  nativescript.config.ts    id org.gotchoices.sereus.chat.ns, appPath app, App_Resources
  tsconfig.json             moduleResolution bundler + customConditions [react-native, browser]
  references.d.ts           @nativescript/types
  webpack.config.js         node shims + node:-strip + conditions + @libp2p/crypto browser rewrite
                            + esbuild downlevel + exportsPresence:warn
  scripts/bundle-check.js   webpack-only compile gate (the agent/CI-runnable test:bundle)
  App_Resources/            harvested from @nativescript/template-blank-ts (Android + iOS)
  app/app.ts                ENTRY: polyfills + @valor/nativescript-websockets FIRST, audit, run
  app/app-root.xml, app/main/*  minimal bootable page that drives the solo smoke
  src/polyfills/            hermes, event, intl-pluralrules, node-crypto, node-os, buffer-global,
                            registry, audit, index (barrel), types/ungap-structured-clone.d.ts
  src/ns-storage.ts         makeLazyNsStorage(strandId) — lazy IRawStorage proxy over async open
  src/cadre-phone.ts        CadreNode singleton (NS storage provider, WS transports, SQLite identity)
  src/chat-strand.ts        ported verbatim from reference-app-rn (pure TS)
  src/chat-operations.ts    ported verbatim from reference-app-rn (pure TS)
  src/solo-smoke.ts         startSolo → createChatStrand → insertMessage → queryMessages
README.md                   layout, scripts table, device-smoke steps, storage notes
package.json (root)         + resolutions["@optimystic/db-p2p-storage-ns"] = link:...
```

All "Resolved design decisions" from the plan ticket were implemented as written: NS Core (not
Svelte Native), reuse `@optimystic/db-p2p-storage-ns`, lazy storage proxy for the sync→async
mismatch, V8/JSC-re-audited polyfill set (dropped `getRandomValues`, kept `subtle.digest`),
`@valor/nativescript-websockets`, webpack node-shimming + `react-native`/`browser` conditions +
the @libp2p/crypto browser rewrite.

## Agent-verified (these passed; treat as the floor, not the ceiling)

- `yarn install` (root) — resolves the NS toolchain + polyfill deps. Pinned NS 8.9 line
  (core 8.9.9, android 8.9.2, types 8.9.1, webpack 5.0.35) to match the installed `ns` CLI 8.9.2.
- `yarn workspace @serfab/reference-app-ns typecheck` → **exit 0**. Types compose across
  cadre-core, db-p2p (rn condition), db-p2p-storage-ns, quereus, libp2p. No `any`.
- `yarn eslint packages/reference-app-ns/{src,app}` → **0 problems**.
- `yarn workspace @serfab/reference-app-ns test:bundle` → **exit 0**, "whole import graph compiled
  with 0 errors (22 warnings)". This is `scripts/bundle-check.js` = a webpack-only compile (the
  analog of reference-app-rn's `expo export`). Verified via module-list inspection of the build:
  - **db-p2p resolves `dist/src/rn.js`** (the TCP-free entrypoint); **zero `@libp2p/tcp` modules**
    bundled (the one `@libp2p/tcp` string in the bundle is a code comment).
  - **@libp2p/crypto browser variants ARE selected**: `ed25519/secp256k1/rsa/ecdh/index.browser.js`,
    `hmac/index.browser.js`, `webcrypto/webcrypto.browser.js` — **zero** node-crypto `index.js`
    variants bundled. This is the riskiest correctness point (see gaps).
  - ES2022 `async #method` in bundled deps (peer-store, circuit-relay-v2) is downleveled by esbuild
    so the NS-8.x parser accepts it.

## NOT verified — deferred to device/emulator or CI (the real gaps)

The agent has no Android emulator + the native `@nativescript-community/sqlite` /
`@valor/nativescript-websockets` plugins, so **nothing below was actually executed at runtime**:

1. **The solo smoke itself** — `runSoloSmoke()` (startSolo → createChatStrand → insertMessage →
   queryMessages, expect echo + stable PeerId across cold launches). Code-complete, never run.
   This is *the* runtime-validation goal of the ticket and is the single most important thing a
   reviewer/device-run should confirm.
2. **The @libp2p/crypto browser rewrite at runtime.** Bundle-level selection is proven, but whether
   `generateKeyPair('Ed25519')` actually succeeds on V8/JSC (vs. throwing "undefined cannot be used
   as a constructor") is unproven. If the rewrite regressed, peer-identity creation is the first
   thing that breaks at boot.
3. **The at-boot polyfill audit** (`src/polyfills/audit.ts`) — logs a native/polyfilled/missing
   table. Never seen on a real device; the native-vs-polyfilled split for NS 8.9's V8/JSC is
   asserted from the plan ticket's audit, not observed.
4. **The lazy NS storage proxy** (`src/ns-storage.ts`) — the sync-factory→async-open bridge is
   logic-/type-verified only. Its per-strand isolation and the shared `openOptimysticNSDb` cache
   are untested against the real SQLite plugin.
5. **`ns prepare android` full native build** (`test:bundle:native`) — runs webpack (✓ green) then
   a gradle native-plugin build that needs the Android SDK + a gradle wrapper on PATH. In the agent
   env it fails at `gradlew.bat` building `@nativescript-community/sqlite`. This is the out-of-band
   device tooling the plan flagged; `ns build android|ios` likewise.

## Risks / things a reviewer should probe

- **esbuild downlevel breadth.** `webpack.config.js` runs `esbuild-loader` (target es2020) over
  *all* of `node_modules` except `@nativescript/*`. It's the fix for NS 8.x's toolchain parsing
  bundled deps below ES2022 (`async #method` → "Unexpected token"). Broad, but esbuild only
  downlevels syntax. Alternative considered: NS 9.x (ESM output) likely avoids the downlevel — a
  reviewer may prefer that over the esbuild rule. Not device-tested.
- **22 webpack warnings are an upstream version skew, not app code.** `exportsPresence:'warn'`
  downgrades 4 distinct missing exports to warnings (so the build matches Metro's tolerance):
  `StrictSign` / `StrictNoSign` / `TopicValidatorResult` ← `@libp2p/interface`, and `streamMessage`
  ← `protons-runtime`. They come from `@optimystic/db-p2p`'s nested `@chainsafe/libp2p-gossipsub`
  / `@libp2p/autonat` / `@libp2p/dcutr` expecting older peer versions. Tolerated at runtime by the
  RN app too, but if a reviewer wants these gone it's an optimystic-repo dep-alignment task (a
  candidate fix/backlog ticket), out of scope here.
- **`test:bundle` is webpack-only by design.** This NS version couples webpack with gradle inside
  `ns prepare`, so the agent/CI gate is the standalone webpack compile (`scripts/bundle-check.js`),
  which prints a benign `[@nativescript/webpack] Warn: Cannot find NativeScript CLI path` — that
  only skips CLI-derived copy-rules, not graph resolution (verified: same modules, same 0 errors as
  the in-`ns prepare` webpack pass). `test:bundle:native` is the full prep.
- **node-builtin stubs.** Many node builtins are mapped to `false` (net/tls/http/https/dns/fs/
  cluster/…) as dead-on-the-rn-path. If a *live* code path ever reaches one, it silently no-ops.
  os/crypto are real shims (`node-os.ts` networkInterfaces→{}, `node-crypto.ts` createHash via
  @noble/hashes); stream→readable-stream; buffer/events/util/process/string_decoder resolve to npm
  polyfills.
- **`node:`-scheme strip + crypto rewrite plugins** are home-grown webpack plugins — worth a read.
  The crypto rewrite re-derives the package root per-resolution so it covers every `@libp2p/crypto`
  copy (local + nested optimystic).
- **App_Resources** were harvested from `@nativescript/template-blank-ts@9.0.0` (binary icons
  included). `__PACKAGE__` / `@string/app_name` are filled by `ns prepare`; not reviewed on-device.

## How to validate (use cases)

Agent/CI (no device needed):
```
yarn workspace @serfab/reference-app-ns typecheck      # tsc --noEmit, exit 0
yarn eslint packages/reference-app-ns/src packages/reference-app-ns/app   # 0 problems
yarn workspace @serfab/reference-app-ns test:bundle    # webpack compile, exit 0, 0 errors
```

Device/emulator (the real runtime gate — NOT run by the agent):
```
yarn workspace @serfab/reference-app-ns test:bundle:native   # ns prepare android (needs Android SDK/gradle)
ns run android   # or: ns run ios   (needs emulator + native plugins)
```
Then: watch the boot console for the polyfill-audit table (expect no `✗` before libp2p loads),
tap **Run solo smoke**, expect `✓ Local echo OK — 1 message(s)` with a PeerId, relaunch cold and
confirm the **same PeerId** (identity persisted in the SQLite `kv` table under `peer-private-key`).

## Review-stage suggestions

- Minor findings (typos, comment/style, tighter types): fix inline.
- Major findings worth their own ticket rather than blocking:
  - optimystic db-p2p dep version skew (the 22 warnings) — fix/ or backlog/.
  - NS 8.x esbuild-downlevel vs. NS 9.x ESM-output decision — plan/ if the team wants to revisit.
  - a device-run/CI harness that actually executes the solo smoke (overlaps `reference-app-ns-e2e`).
