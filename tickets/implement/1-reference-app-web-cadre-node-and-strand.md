----
description: Re-base the web reference on a real CadreNode + control network + an open strand (chat sApp) with schema-signature verification, replacing the bare-libp2p + @optimystic/demo MessageApp wiring
prereq:
files: packages/reference-app-web/package.json, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/src/lib/network.svelte.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/reference-app-web/src/Messages.svelte, packages/reference-app-web/src/Activity.svelte, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/README.md, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/chat-operations.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/schema-verification.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, docs/architecture.md
----

# Phase 1 — bring up the Sereus cadre stack in the browser

The web reference currently instantiates a **bare libp2p node** and drives
`@optimystic/demo`'s `MessageApp` through a `Local`/`NetworkTransactor`
(`src/lib/optimystic.ts`, `src/lib/messages.svelte.ts`). It validates the
Optimystic transport/storage layer in a browser but instantiates **none** of
the Sereus primitives (`CadreNode`, control network, strand lifecycle, sApp
schema-signature verification). This phase replaces that wiring with a real
`CadreNode` from `@serfab/cadre-core`, mirroring what
`packages/reference-app-rn/src/cadre-phone.ts` + `chat-strand.ts` +
`chat-operations.ts` already do for React Native, so the browser becomes a
genuine **Sereus web reference** rather than an Optimystic-in-a-browser demo.

Phase 1 scope mirrors (and lightly extends) the RN reference's *current*
coverage: bring up the control network, add an **open** strand directly via
`addStrand`, verify the sApp schema signature, and back the existing
Messages/Activity UI with the strand's Quereus database. The
consent/invitation strand-formation flow, closed-strand membership, RBAC
demonstration, and cross-node/cross-party convergence are **Phase 2**
(`reference-app-web-strand-formation-consent-rbac`).

## Why Option A (not "document the bypass")

The ticket offered two outcomes: (A) exercise the cadre path in the browser, or
(B) document that the browser is intentionally scoped to the Optimystic
transport. Option A is chosen because AGENTS.md mandates "Think cross-platform
(browser, node, RN, etc.)" and the product's cross-platform claims rest on the
cadre/strand/control-network stack working on the web. cadre-core is already
browser-clean (see "Browser-compatibility" below), so Option B would
permanently understate a capability the codebase already has. The README and
`docs/architecture.md` are updated to reflect the browser now exercises the
real stack.

## Target architecture

```
src/lib/
  cadre-web.ts        # NEW — CadreNode lifecycle for the browser
                      #   (mirrors reference-app-rn/src/cadre-phone.ts)
  strand-storage.ts   # NEW — per-strand IndexedDB IRawStorage provider
  chat-strand.ts      # NEW — chat sApp schema + signed SAppConfig + addStrand
                      #   (mirrors reference-app-rn/src/chat-strand.ts)
  messages.svelte.ts  # CHANGED — reads/writes the strand DB, not MessageApp
  store.svelte.ts     # CHANGED — wraps the CadreNode singleton
  network.svelte.ts   # CHANGED — control-network bootstrap input (party/seed)
  diagnostics.svelte.ts  # CHANGED — surface CadreNode/control/strand state
  ice-config.ts       # REUSED  — ICE servers from manifest (unchanged)
  connection-path.ts  # REUSED  — relayed-vs-direct classification (unchanged)
optimystic.ts         # REMOVED (or reduced to the storage/identity helpers
                      #   that cadre-web.ts still needs)
```

### CadreNode wiring (`cadre-web.ts`)

Mirror `cadre-phone.ts`, swapping RN storage/transports for the browser's. The
web app already imports the browser identity + storage helpers from
`@optimystic/db-p2p-storage-web` (`openOptimysticWebDb`,
`loadOrCreateBrowserPeerKey`, `IndexedDBRawStorage`).

```typescript
import { CadreNode, type CadreNodeConfig } from '@serfab/cadre-core';

const config: CadreNodeConfig = {
  privateKey,                       // loadOrCreateBrowserPeerKey(controlDbHandle)
  controlNetwork: {
    partyId,                        // persisted in IndexedDB kv, generated on first run
    bootstrapNodes: [],             // solo bring-up; Phase 2 adds cadre bootstrap
  },
  profile: 'transaction',           // browser is an edge node, like the phone
  storage: { provider: strandStorageProvider },   // see strand-storage.ts below
  network: {
    transports: [
      webSockets(),
      circuitRelayTransport(),
      webRTC({ rtcConfiguration: { iceServers } }) as unknown as TransportFactory,
      webRTCDirect() as unknown as TransportFactory,
    ],
    listenAddrs: [],                // solo; Phase 2 sets ['/p2p-circuit','/webrtc']
  },
  strandFilter: { mode: 'all' },
  hibernation: { enabled: false },
};
const node = new CadreNode(config);
await node.start();
```

Notes:
- Reuse the `TransportFactory` brand-skew cast already documented in
  `optimystic.ts:58-71,205-211` — `CadreNodeConfig.network.transports`
  (`Libp2pTransports`) takes the same factory element type, so the webRTC
  factories need the identical `as unknown as TransportFactory` bridge. Confirm
  the cast compiles against cadre-core's `Libp2pTransports` type; if the element
  type differs, adapt the cast rather than pinning transitive libp2p packages.
- Identity persistence: keep `loadOrCreateBrowserPeerKey` and the
  `identity-first-seen` tracking — `CadreNode` accepts `privateKey?: PrivateKey`,
  so identity continuity across reloads is preserved exactly as today.
- Solo authority self-genesis: for a single-node cadre, the node must seed
  itself as the authority before it can write to the control DB. Follow the
  `cadre-cli start` path: `initializeSeedBootstrap(authorityPrivateKeyB64)` then
  ensure the genesis `AuthorityKey` row exists (see
  `packages/cadre-cli/src/commands/start.ts` and
  `cadre-node.ts:645-664`). Verify the exact genesis call the CLI uses and
  reproduce it; do not invent a new bootstrap path.

### Per-strand IndexedDB storage provider (`strand-storage.ts`) — KEY RISK

`CadreNodeConfig.storage.provider` is a **synchronous** factory
`(strandId: string) => IRawStorage`, and cadre-core partitions each strand's
data by strand id. But `IndexedDBRawStorage`
(`optimystic/packages/db-p2p-storage-web/src/indexeddb-storage.ts:16-17`) takes
an **already-open** `OptimysticWebDBHandle` (async `openOptimysticWebDb`) and
has **no per-strand namespacing** — all block keys share one DB. RN sidesteps
this because `LevelDBRawStorage`/`openOptimysticRNDb` open a fresh per-strand
LevelDB file synchronously; the web handle is async.

Bridge it inside the reference app (preferred — do not fork
`db-p2p-storage-web` unless genuinely necessary):

1. Pre-open one `OptimysticWebDBHandle` per strand via
   `openOptimysticWebDb('sereus-strand-' + strandId)` **before** calling
   `addStrand`, stash handles in a `Map<strandId, handle>`, and have the sync
   provider return `new IndexedDBRawStorage(handles.get(strandId)!)`. Because
   the reference app drives `addStrand` explicitly (Phase 1 has no
   control-discovered strands), strand ids are known ahead of the factory call.
2. Verify whether the **control network** also goes through this same provider
   (it is a distinct Optimystic network — `control-${partyId}`). Check how
   `CadreNode.start()` obtains raw storage for the control DB: if it calls the
   provider with a control "strandId", pre-open a handle for that key too; if it
   wires control storage separately, satisfy that path. Read
   `cadre-node.ts` start path before assuming.
3. Close handles in `stopNode()` to mirror today's `db.close()` teardown.

If pre-opening proves insufficient for a future control-discovered-strand path,
the fallback is a small enhancement to `db-p2p-storage-web` (a
sync-constructable, lazily-opening handle, or a `prefix`/namespace option on
`IndexedDBRawStorage`). Park that as a follow-up rather than blocking Phase 1 —
the pre-open approach covers the explicit-`addStrand` Phase 1 surface.

### Chat strand (`chat-strand.ts`) + schema-signature verification

Mirror `packages/reference-app-rn/src/chat-strand.ts`, but **sign the schema**
so the browser exercises the schema-signature gate that the RN app currently
skips (RN's `getChatSAppConfig()` omits `signature`). Follow the integration
test's signed pattern (`websocket-chat.integration.ts:41-50`):

```typescript
import { signSchema } from '@serfab/cadre-core';
// CHAT_SCHEMA: same Member/Message DDL as the RN reference (schemas/chat-simple.qsql)
const sAppConfig: SAppConfig = {
  id: CHAT_AUTHOR_PUBLIC_KEY,            // ed25519 pubkey (base64url) of schema author
  version: '0.1.0',
  schema: CHAT_SCHEMA,
  signature: signSchema(CHAT_SCHEMA, '0.1.0', CHAT_AUTHOR_PRIVATE_KEY),
  latencyHint: 'interactive',
};
await node.addStrand({ strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' }, sAppConfig });
```

`StrandInstanceManager` calls `assertSchemaSignature(sAppConfig)` on strand
start (`strand-instance-manager.ts:154-156`), so a tampered schema/signature
throws `SchemaVerificationError` — this is the schema-signature verification the
ticket requires. For a reference demo the author keypair can be a fixed
bundled demo identity (document that it is a demo author key, not a real
identity); the point is that the gate is *exercised*, not bypassed.

The strand starts in `bootstrap` mode for a solo node (auto-selected from
`CadrePeer` membership — see `docs/architecture.md` "Strand Mode") so DML lands
on the strand's IndexedDB-backed local transactor with no peers needed.

### Strand-backed messages (`messages.svelte.ts`)

Replace the `MessageApp` transactor calls with Quereus SQL against the strand
database, mirroring `reference-app-rn/src/chat-operations.ts`:

- Acquire the DB once the strand is active:
  `const db = node.getStrand(strandId)?.database?.getDatabase()`.
- Register a member: `insert or ignore into App.Member (Id, Name) values (?, ?)`.
- Send: `insert into App.Message (Id, MemberId, Content, Timestamp) values (?, ?, ?, ?)`.
- List: `select M.Id, M.MemberId, M.Content, M.Timestamp, Mem.Name as MemberName
  from App.Message M left join App.Member Mem on Mem.Id = M.MemberId
  order by M.Id asc`.
- Keep the existing 4s visibility-gated poll for refresh.

The **Activity** page (`/log`) was backed by `MessageApp.activity` (a
`Diary<Activity>`), which the chat schema has no equivalent for. Repurpose it as
a **cadre/strand event log** fed by `CadreNode.on(...)` events
(`strand:started|stopped|error`, `control:connected|disconnected`,
`seed:applied`, etc. — `types.ts:402-417`), or drop the route. Document the
choice in the README. (Repurposing is preferred — it keeps the diagnostics
value and surfaces real cadre lifecycle state.)

### Diagnostics

Extend `/diag` to show the new stack: party id, control-network connection
state + peer id, control `CadrePeer` count, per-strand status
(`StrandInstance.status`), strand `connectedPeers`, latency hint, and any strand
error. Keep the existing transports canary (no TCP in the browser bundle),
identity-persistence badge, connection-path classification, FRET, and storage
panels — `connection-path.ts` works on any libp2p node, and `CadreNode`
exposes `getConnectionPaths()` (`cadre-node.ts:144-147`) plus
`getControlNode()` for the underlying libp2p node.

### Browser-compatibility (already verified — no blocker)

`packages/cadre-core/src` has **zero** `node:fs|os|net|tls|crypto` imports;
`strand-instance-manager.ts:66-82` guards its only `path` use behind
`typeof process !== 'undefined'`; the `CadreControl` schema is an embedded code
constant (no file read). All direct deps (`@libp2p/*`, `@optimystic/db-p2p`,
`@optimystic/quereus-plugin-crypto`, `uint8arrays`, `@multiformats/multiaddr`,
`debug`) are browser-safe. The existing `polyfills.ts` (Buffer + timer
`.ref/.unref`) and `vite.config.ts` aliases (`os`/`net`/`tls` → empty,
`stream` → `readable-stream`) already cover db-p2p's needs; watch for any
*additional* Node built-in a cadre-core transitive dep reaches for at bundle
time and add it to the existing alias/polyfill surface (never add a `crypto`
shim — surface it as a real bug, per the README rule).

## Package dependency

Add `"@serfab/cadre-core": "*"` to `packages/reference-app-web/package.json`
dependencies. Keep `@optimystic/db-p2p-storage-web`, the libp2p transport deps,
`buffer`, `idb`, `readable-stream`, `svelte`. `@optimystic/demo` can be dropped
once `MessageApp` is gone (confirm nothing else imports it first).

## Docs

- Rewrite `packages/reference-app-web/README.md`'s opening + "Modes" sections:
  the app is the **browser Sereus reference** exercising
  `CadreNode` → control network (`CadreControl`) → signed open chat strand, not
  an Optimystic transport demo. Keep the diagnostics, polyfill, and vite-config
  sections (still accurate). Note Phase-2 items (consent formation, RBAC,
  cross-party convergence) as forthcoming.
- Update `docs/architecture.md` reference-app coverage notes so the browser is
  listed alongside RN as a cadre reference, not transport-only.

## Key tests (TDD intent — expected outputs)

- **Solo strand round-trip (e2e Tier 1, extend `e2e/solo/`)**: boot → control
  network up → open chat strand active → send a message → it appears in the
  list → reload → message + identity persist. Expected: strand
  `StrandInstance.status === 'active'`, `App.Message` row readable after reload.
- **Schema-signature gate (unit or e2e)**: feeding a `SAppConfig` whose
  `signature` does not match `schema`/`version` causes `addStrand` to reject
  with `SchemaVerificationError`; the valid signed config starts the strand.
  Expected: tampered schema → strand never reaches `active`, error surfaced in
  `/diag`.
- **Transports canary (existing solo e2e)**: Transports list still shows only
  WebSockets + circuit-relay + the two WebRTC entries — no TCP leaked by
  cadre-core into the browser bundle.
- **Typecheck/build**: `yarn workspace @serfab/reference-app-web typecheck` and
  `build` pass (the `tsc --noEmit && vite build` script). Stream output with
  `2>&1 | tee` per the long-running-command rule.

The existing Tier-2 distributed e2e (two-tab Optimystic convergence against a
reference-peer fixture) assumes membership-free convergence on a shared
Optimystic network, which no longer holds once data lives inside a cadre strand
cohort. **Disable / mark Tier-2 pending** in Phase 1 and re-establish
cross-node/cross-party convergence in Phase 2 (it requires control-network
membership or strand formation). Document the deferral in the README rather than
leaving a silently-broken suite.

## TODO

### Phase 1a — CadreNode + storage + strand bring-up
- [ ] Add `@serfab/cadre-core` dependency; confirm `@optimystic/demo` can be removed.
- [ ] Write `src/lib/strand-storage.ts`: pre-open per-strand `OptimysticWebDBHandle`s and a synchronous `(strandId) => IndexedDBRawStorage` provider; verify the control-network storage path and cover it; close handles on teardown.
- [ ] Write `src/lib/cadre-web.ts` mirroring `cadre-phone.ts`: `CadreNode` config (browser transports + webRTC cast, IndexedDB storage provider, transaction profile, identity reuse), `start/stop`, solo authority self-genesis (reproduce the `cadre-cli start` genesis call), getters for node/strand/control state.
- [ ] Write `src/lib/chat-strand.ts`: chat `Member`/`Message` schema + **signed** `SAppConfig` (bundled demo author keypair, `signSchema`), `addStrand` of an open strand.

### Phase 1b — UI + store rewire
- [ ] Rewrite `store.svelte.ts` to own the `CadreNode` singleton (replacing the libp2p-node store).
- [ ] Rewrite `messages.svelte.ts` to read/write the strand DB via Quereus SQL (mirror `chat-operations.ts`); keep visibility-gated polling.
- [ ] Repurpose `Activity.svelte`/`/log` as a CadreNode-event log (or drop it; document the choice).
- [ ] Rework `network.svelte.ts`/`Home.svelte`: party-id display, control-network status; the old optimystic bootstrap input is repurposed/disabled until Phase 2.
- [ ] Extend `diagnostics.svelte.ts`/`Diagnostics.svelte` with party id, control state, `CadrePeer` count, per-strand status/peers/latency/error.

### Phase 1c — docs + tests + validation
- [ ] Rewrite `README.md` opening/Modes; update `docs/architecture.md` reference-app coverage.
- [ ] Extend `e2e/solo/` with the strand round-trip + schema-signature gate; keep the transports canary; mark Tier-2 distributed pending with a documented reason.
- [ ] Run `yarn workspace @serfab/reference-app-web typecheck` and `build` (stream with `tee`); fix fallout. Run the solo e2e if a Chromium fixture is available, else document that CI runs it.
- [ ] If any non-web test fails for reasons outside this diff, write `tickets/.pre-existing-error.md` per the stage rules and continue.
