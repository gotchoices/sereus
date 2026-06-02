description: NativeScript Core reference app (@serfab/reference-app-ns) proving the cadre/db-p2p/Quereus/Optimystic stack bundles + parses under NS V8/JSC. Solo/forming-mode milestone. Bundle resolution (incl. the @libp2p/crypto browser rewrite) is agent-verified; device/emulator runtime boot is NOT (needs native SQLite/WebSocket plugins).
files: packages/reference-app-ns/webpack.config.js, packages/reference-app-ns/scripts/bundle-check.js, packages/reference-app-ns/src/polyfills/, packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/solo-smoke.ts, packages/reference-app-ns/app/, packages/reference-app-ns/package.json, packages/reference-app-ns/README.md, package.json (root resolutions)
----

## What landed

New workspace package **`@serfab/reference-app-ns`** — a NativeScript Core (plain
TS + XML) app whose sole purpose is runtime validation of the Sereus/Optimystic
stack on NS's V8/JSC engine. Solo/forming-mode milestone (local chat strand, insert
+ echo a message; no drone, no network). Chat-connect UI (`reference-app-ns-chat`,
seq 5) and e2e (`reference-app-ns-e2e`, seq 6) are downstream in `implement/`.

See the implement commit `6ab4bee` for the full file inventory. Core pieces:
webpack config (node shims, `node:`-strip, `react-native`/`browser` conditions,
@libp2p/crypto browser rewrite, esbuild ES2022 downlevel, `exportsPresence:'warn'`),
re-audited V8/JSC polyfill set, lazy async→sync SQLite storage proxy, CadreNode
phone singleton, ported pure-TS chat strand/operations, and the solo smoke.

## Review findings

### What was checked

- **Read the full implement diff** (`6ab4bee`) with fresh eyes before the handoff:
  every `src/` and `app/` TS file, `webpack.config.js`, `scripts/bundle-check.js`,
  `package.json` (pkg + root resolutions), `tsconfig.json`, `nativescript.config.ts`,
  `README.md`, and the XML/CSS. App_Resources binaries and `yarn.lock` skimmed only.
- **Re-ran all three agent gates — all green:**
  - `typecheck` (`tsc --noEmit`) → **exit 0**. Because `LazyNsRawStorage implements
    IRawStorage` type-checks, the proxy is provably **complete** — no `IRawStorage`
    method is unproxied (the interface has no `close()`, so the never-close storage
    cache is by-design, not a leak).
  - `eslint packages/reference-app-ns/{src,app}` → **0 problems**.
  - `test:bundle` (webpack compile) → **exit 0**, 0 errors, **22 warnings**.
- **Verified the 22 warnings are exactly the documented upstream skew** (re-derived
  from the build): 4 distinct missing exports — `StrictSign` / `StrictNoSign` /
  `TopicValidatorResult` (`@libp2p/interface`) and `streamMessage` (`protons-runtime`).
  Not app code; downgraded to warnings via `exportsPresence:'warn'` to match Metro.
- **Confirmed the new `@optimystic/db-p2p-storage-ns` link + exports** resolve:
  `openOptimysticNSDb`, `SqliteRawStorage`, `loadOrCreateNSPeerKey` all present;
  root `resolutions` entry added correctly.
- **Diffed the two "ported verbatim" files** (`chat-strand.ts`, `chat-operations.ts`)
  against the RN originals: identical logic; only whitespace (tabs per `.editorconfig`
  vs RN spaces) + an added doc line differ. Claim is accurate.
- **Storage cache lifecycle:** the module-level `openByDbName` cache reuses one
  SQLite connection per strand. Reviewed against CadreNode's storage model — reuse
  is correct (no `close()` on the contract); the peer-identity DB *is* explicitly
  opened/closed in `loadOrCreatePhoneKey`. No cleanup bug for this milestone.
- **Polyfill set vs RN/web parity:** each shim is `typeof`-guarded (no-ops where NS
  is native), the boot audit reports native/polyfilled/missing, and entry order
  (polyfills → websockets → audit → run) is correct.

### Minor — fixed inline this pass

- **README scripts table was factually wrong:** it labeled `test:bundle` as
  `ns prepare android` and omitted `test:bundle:native`. Corrected — `test:bundle`
  is the webpack-only `node scripts/bundle-check.js`; added a `test:bundle:native`
  (`ns prepare android`) row. Now matches `package.json` and the handoff.

### Major — filed as new ticket(s)

- **`tickets/backlog/optimystic-db-p2p-libp2p-dep-skew.md`** — the 22-warning
  upstream version skew in `@optimystic/db-p2p`'s nested gossipsub/autonat/dcutr.
  Resolving it upstream lets the NS app drop `exportsPresence:'warn'` and restore
  strict missing-export detection. Out of scope here (optimystic-repo dep work);
  not covered by any downstream NS ticket, so captured so it isn't lost.

### Considered, not ticketed (deliberate)

- **NS 8.x esbuild-downlevel-over-all-node_modules vs. NS 9.x ESM output** — the
  broad esbuild rule is a notable but working hack. Revisiting before the stack is
  even device-validated is premature; the team can weigh NS 9.x after a green
  device run. Documented here rather than spun into a speculative plan ticket.
- **A device/CI harness that actually executes the solo smoke** — already the remit
  of `reference-app-ns-e2e` (seq 6, in `implement/`). Not duplicated.

### Not verified — inherent device-tooling gaps (unchanged from handoff, honest)

The agent has no Android emulator nor the native `@nativescript-community/sqlite` /
`@valor/nativescript-websockets` plugins, so **nothing below ran at runtime**. These
are the genuine open risks; the downstream e2e ticket is where they get executed:

1. `runSoloSmoke()` end-to-end (createChatStrand → insertMessage → queryMessages,
   echo + stable PeerId across cold launches). Code-complete, never run.
2. The @libp2p/crypto browser rewrite **at runtime** — bundle-level selection is
   proven; whether `generateKeyPair('Ed25519')` actually succeeds on V8/JSC is not.
3. The at-boot polyfill audit table (the native-vs-polyfilled split for NS 8.9).
4. The lazy NS storage proxy against the real SQLite plugin.
5. `ns prepare android` full native/gradle build and `ns run android|ios`.

**Disposition: complete.** Code quality, types, lint, and whole-graph bundle
resolution are sound and re-verified. The remaining risk is purely runtime/device
execution, which is structurally out of the agent's reach and owned by the seq-6
e2e ticket. One doc fix applied inline; one upstream dep-skew ticket filed.

## How to validate

Agent/CI (no device):
```
yarn workspace @serfab/reference-app-ns typecheck      # exit 0
yarn eslint packages/reference-app-ns/src packages/reference-app-ns/app   # 0 problems
yarn workspace @serfab/reference-app-ns test:bundle    # webpack compile, 0 errors (22 warnings)
```

Device/emulator (the real runtime gate — NOT run by the agent):
```
yarn workspace @serfab/reference-app-ns test:bundle:native   # ns prepare android (needs Android SDK/gradle)
ns run android   # or ns run ios — needs emulator + native plugins
```
Then watch the boot console for the polyfill-audit table (no `✗` before libp2p),
tap **Run solo smoke**, expect `✓ Local echo OK — 1 message(s)` with a PeerId, and
relaunch cold to confirm the **same PeerId** (identity in the SQLite `kv` table).
