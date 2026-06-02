description: Review the browser Sereus reference rebase — bare libp2p + @optimystic/demo MessageApp replaced by a real CadreNode → control network → signed open chat strand, with per-strand IndexedDB storage, solo authority self-genesis, and schema-signature verification. Phase 1 (solo single-node cadre).
prereq:
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/strand-storage.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/reference-app-web/src/lib/network.svelte.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Messages.svelte, packages/reference-app-web/src/Activity.svelte, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/src/App.svelte, packages/reference-app-web/package.json, packages/reference-app-web/README.md, packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/e2e/solo/, docs/architecture.md, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/schema-verification.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts
----

# Review: browser Sereus reference on a real CadreNode + strand

## What changed (Phase 1)

The web reference no longer instantiates a bare libp2p node driving
`@optimystic/demo`'s `MessageApp`. It now boots a real `CadreNode` from
`@serfab/cadre-core`, mirroring `reference-app-rn/src/cadre-phone.ts`:

```
CadreNode (transaction profile)
  → control network  control-<partyId>  (CadreControl schema)
  → solo authority self-genesis (cadre-cli start --authority path)
  → signed open chat strand (chat sApp, bootstrap mode → IndexedDB local transactor)
```

`src/lib/optimystic.ts` was **deleted**. New/changed lib files:

- **`cadre-web.ts`** (NEW) — CadreNode lifecycle: browser transports
  (WebSockets + circuit-relay + WebRTC + WebRTC-direct, same brand-skew
  `as unknown as TransportFactory` cast the old code used), IndexedDB storage
  provider, identity + party-id persistence on the control DB, solo authority
  self-genesis (`authorityKeyFromLibp2p` → `ensureAuthorityKey` →
  `initializeSeedBootstrap`, **fail-soft**), and `addChatStrand`.
- **`strand-storage.ts`** (NEW) — the KEY RISK bridge. `CadreNodeConfig.storage.provider`
  is a *synchronous* `(key) => IRawStorage`, but `IndexedDBRawStorage` wraps an
  *already-open* async handle with no per-key namespacing. Bridge: pre-open one
  IndexedDB database per key (`sereus-strand-<key>`, key = `'control'` or the
  strand id) **before** the sync provider is hit, return a cached
  `IndexedDBRawStorage` per key. Covers both the control network (`provider('control')`)
  and the explicit strand (`provider(strandId)`).
- **`chat-strand.ts`** (NEW) — chat `Member`/`Message` schema (matches
  `schemas/chat-simple.qsql` + the RN reference + the integration test) and a
  **signed** `SAppConfig` via `signSchema` with a bundled **demo** author keypair.
  Also exports `getTamperedChatSAppConfig()` for the gate test.
- **`store.svelte.ts`** — owns the CadreNode singleton; exposes status / peer id
  / party id / control connection / strand status / authority outcome; subscribes
  to `CadreNode.on(...)` and keeps a 50-deep event ring buffer for `/log`.
- **`messages.svelte.ts`** — reads/writes the strand DB via Quereus SQL
  (mirrors `chat-operations.ts`): insert-or-ignore member, insert message, list
  with the Member↔Message join; 4 s visibility-gated poll. Append-only (no
  edit/delete — that was MessageApp).
- **`network.svelte.ts`** — reduced to a Phase-2 seed-input placeholder.
- **`diagnostics.svelte.ts`** / **`Diagnostics.svelte`** — new **Cadre** card
  (party id, control connection + peer id, CadrePeer count, authority outcome,
  strand status / peers / latency / sApp id / error); existing transports / FRET
  / connection-path / storage / crypto panels retargeted to the control node.
- **`Home.svelte`** — cadre status surface; **`Activity.svelte`** — CadreNode
  event log; **`App.svelte`** — unchanged badge (`mode` is always `'solo'`).

`package.json`: added `@serfab/cadre-core` + `@quereus/quereus`, dropped
`@optimystic/demo`. README + `docs/architecture.md` updated (browser is now a
cadre reference alongside RN, not transport-only).

## How to validate

All run from `packages/reference-app-web`:

- `yarn typecheck` — **passes** (tsc --noEmit).
- `yarn build` — **passes** (`tsc --noEmit && vite build`); 2753 modules,
  cadre-core + db-p2p main entry (statically imports `@libp2p/tcp`) + quereus all
  bundle with only the existing `net`/`os`/`tls`/`stream`/`buffer` aliases. No
  new Node-built-in shim needed; no `crypto` shim.
- `npx svelte-check` — **0 errors, 0 warnings**.
- `yarn test:e2e` (Chromium) — **Tier 1 solo: 21/21 pass** (run locally this
  ticket). Tier 2 distributed: **deferred to Phase 2** (`global-setup.ts`
  `TIER2_DEFERRED_TO_PHASE2`), skips cleanly.

### Use cases the e2e covers (all green in real Chromium)

1. **Boot** — node → control connected → signed chat strand reaches `active`
   (bootstrap mode), peer id + party id present (`boot.spec.ts`).
2. **Identity/party persistence** — both survive reload; fresh context → fresh
   peer id.
3. **Schema-signature gate** — valid signed config verifies; a tampered schema
   throws `SchemaVerificationError` (`schema-signature-gate.spec.ts`, pure-Node,
   exercises the exact `assertSchemaSignature` call `StrandInstanceManager` runs).
4. **Chat round-trip** — send → renders with author; multiple messages keep
   ascending `Message.Id` order (`messages-roundtrip.spec.ts`).
5. **Reload persistence of strand DML** — messages survive reload (proves the
   bootstrap-mode `rawStorage` → IndexedDB wiring persists; `reload-persistence.spec.ts`).
6. **Transports canary** — exactly 4 transports, **no TCP leaked** into the
   browser bundle; control connected; strand active; **authority `genesis`/`existing`
   (never `error`)**; crypto sanity 7/7; storage backend `IndexedDBRawStorage`;
   recent-errors == 0 (`diagnostics.spec.ts`).
7. **Routing + connection-path classifier parity** — unchanged, still green.

Manual: `yarn dev`, open `:5173` — Home shows party/peer/control/strand;
Messages send/list; `/log` shows lifecycle events; `/diag` shows the Cadre card.

## Known gaps / what the reviewer should scrutinize (treat tests as a floor)

- **Solo-only (Phase 1).** Single-node cadre. No in-browser multi-peer / cross-tab
  / cross-party convergence — that's Phase 2. Multi-node strand replication is
  only covered by the Node integration test (`websocket-chat.integration.ts`),
  not in-browser.
- **Tier-2 distributed e2e is parked, not rewritten.** The 6 `e2e/distributed/`
  specs still reference the old MessageApp/mode-flip UI + `__optimystic` hook and
  are force-skipped via `global-setup.ts`. They will need a full rewrite onto the
  cadre model in Phase 2 — do **not** expect them to pass as-is.
- **Storage pre-open bridge is explicit-`addStrand` only.** A future
  control-*discovered* strand (Phase 2) would hit the sync provider for a strand
  id that was never pre-opened and throw. Documented fallback: a lazily-opening /
  namespaced enhancement to `@optimystic/db-p2p-storage-web`. Not blocking Phase 1.
- **Authority genesis is fail-soft.** A failure is surfaced on Home/Diagnostics
  (and recorded as an `authority:error` event), not fatal — the chat round-trip
  runs in bootstrap mode regardless. e2e confirms it reaches `genesis`/`existing`
  on a solo node, so the happy path works; the failure path is unexercised.
- **Demo author keypair is bundled in `chat-strand.ts`** (fixed Ed25519 pair,
  base64url). Documented as a demo identity, not a real sApp author. Confirm this
  is acceptable for a reference.
- **`connection-path.ts` duplicate.** The web app now depends on cadre-core, so
  the "deliberate duplicate" of cadre-core's classifier could be collapsed into a
  direct `@serfab/cadre-core` import (and its parity spec retired). Left in place
  per the ticket's "reused, unchanged" scoping; comments updated to flag the
  collapse as a follow-up. Reviewer's call whether to collapse now.
- **CadrePeer count is always 0 on a solo node** — cadre-core's `registerSelf`
  is a pre-existing no-op (TODO: signed self-registration), so the diagnostics
  count reads 0. Not introduced here.
- **Fixed strand id** (`sereus-web-chat`) for reload stability — single strand
  per browser in Phase 1.
- **Bundle size** ~3 MB minified (pre-existing chunk-size warning; not addressed).
- **In-browser strand bring-up latency** measured fast in tests (strand `active`
  well under 1 s on a fresh, empty IndexedDB), but warm-restart catalog hydration
  cost in-browser at larger data sizes is unmeasured.

## Notes

- No `tickets/.pre-existing-error.md` written — no unrelated test failures
  surfaced. cadre-core source was **not** modified (the bridge lives entirely in
  the reference app, as the ticket preferred).
- Build/typecheck/svelte-check/Tier-1-e2e all run and passing as of handoff.
