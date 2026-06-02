description: COMPLETE — browser Sereus reference rebased onto a real CadreNode → control network → signed open chat strand (Phase 1, solo single-node cadre). Reviewed; one minor doc-staleness fix applied inline.
prereq:
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/strand-storage.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/reference-app-web/src/lib/network.svelte.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Messages.svelte, packages/reference-app-web/src/Activity.svelte, packages/reference-app-web/src/App.svelte, packages/reference-app-web/e2e/solo/, docs/architecture.md
----

# Complete: browser Sereus reference on a real CadreNode + signed strand (Phase 1)

The web reference no longer drives `@optimystic/demo`'s `MessageApp` over a bare
libp2p node. It now boots a real `CadreNode` (transaction profile) → control
network (`CadreControl`) → solo authority self-genesis → **signed** open chat
strand (bootstrap mode → per-key IndexedDB). `src/lib/optimystic.ts` deleted.
Architecture, mechanism, and known gaps are as described in the implement
handoff — that summary is accurate and was verified end-to-end during review.

## Review findings

Adversarial pass over commit `f87aa23`. Read the implement diff first, then the
handoff. Scrutinized for SPP/DRY/modularity, error handling, resource cleanup,
type safety, doc accuracy, and test coverage (happy/edge/error/regression).

### Validation re-run independently (all green)
- `yarn typecheck` → exit 0.
- `npx svelte-check` → 0 errors, 0 warnings (668 files).
- `yarn build` → exit 0 (only the pre-existing ~3 MB chunk-size warning; no new
  Node-built-in shim; no TCP at runtime).
- `yarn test:e2e --project=chromium` (full suite, not just solo) → **21 passed,
  8 skipped, 0 failed**. The Tier-2 `e2e/distributed/*` specs skip *cleanly* via
  the `global-setup.ts` fixture-state gate + `requireFixture` (`testInfo.skip`) —
  confirmed they do not error at collection/import. Solo Tier-1 covers boot,
  identity/party persistence + fresh-context isolation, schema-signature gate
  (valid passes / tampered → `SchemaVerificationError`), chat round-trip,
  ascending-Id ordering, reload persistence of strand DML, the transports/crypto/
  authority diagnostics canary, and routing/connection-path parity.

### Cross-checks against cadre-core (the integration boundary)
- All cadre-core symbols the web app calls exist with matching signatures:
  `authorityKeyFromLibp2p`, `signSchema`, `assertSchemaSignature`,
  `SchemaVerificationError`, `ControlDatabase.ensureAuthorityKey` /
  `queryCadrePeers`, `CadreNode.initializeSeedBootstrap` / `getControlDatabase` /
  `getControlNode` / `getStrand`.
- **Storage-bridge completeness verified at the source.** The synchronous
  `storage.provider` is hit in exactly two cadre-core sites — `provider('control')`
  (`cadre-node.ts:304`) and `provider(strandId)` (`strand-instance-manager.ts:111`
  via `resolveStrandStorage`). Both keys are pre-opened by `openStores` before the
  factory runs (`'control'` before `start()`, `CHAT_STRAND_ID` before `addStrand`),
  so the "throw on un-pre-opened key" guard cannot fire on the Phase-1 path. The
  control-*discovered*-strand gap is real and correctly deferred to Phase 2.
- `assertSchemaSignature` logic re-read: missing signature → skips; present +
  digest mismatch → throws. The `getTamperedChatSAppConfig` (valid sig, schema
  mutated after) therefore genuinely exercises the throw path.
- Connection-path **drift guard is real**: the web parity table is byte-identical
  to cadre-core's `test/connection-path.spec.ts` → `CLASSIFIER_TABLE`, and the
  canonical `cadre-core/src/diagnostics/connection-path.ts` it claims to mirror
  exists. The "deliberate duplicate" comments are accurate.
- `messages.svelte.ts` faithfully mirrors `reference-app-rn/src/chat-operations.ts`
  (same insert-or-ignore member, `max(Id)+1`, `App.Message`↔`App.Member` join,
  Quereus `'YYYY-MM-DD HH:MM:SS'` timestamp). No divergence introduced.

### Docs
- `docs/architecture.md` reference-apps table + Phase-1 note: **accurate** —
  matches the verified 4-transport/no-runtime-TCP, signed-strand, solo-authority,
  IndexedDB reality.
- README spot-checked: no stale `MessageApp`/CRUD/mode-flip claims (the only
  `edit/delete` mention correctly says it *belonged to the old demo app*).
- Residual `__optimystic` / `MessageApp` strings in `src/` are explanatory
  "replaces the old …" comments only — not live references.

### Fixed inline (minor)
- **`src/lib/ice-config.ts` stale comments** — the file (unchanged by the
  implement commit, but a file that *should* have been touched when its consumer
  moved) still pointed at the **deleted** `optimystic.ts → startNode` as the call
  site and claimed the helper "does NOT wire the transport." The consumer is now
  `cadre-web.ts → startCadre`, which *does* feed `rtcConfiguration.iceServers`.
  Updated both comment blocks to the new reality. Comment-only; typecheck re-run
  clean (exit 0).

### Noted, accepted as-is for Phase 1 (no new ticket — within scope/established pattern)
- **`Message.Id = max(Id)+1` is racy** under concurrent sends / future multi-peer
  writes (PK collision). It is the established project pattern (identical in the
  RN reference) and safe under serialized solo-UI sends. Phase-2 multi-peer
  convergence will need a collision-tolerant id strategy — folded into the named
  Phase-2 follow-up below rather than a standalone ticket.
- **`refresh()` in-flight guard** can delay a just-sent message's appearance until
  the next ≤4 s poll if a poll tick is mid-flight at send time. UX latency only;
  e2e tolerates it (15 s wait). Acceptable.
- **`store.svelte.ts` never re-sets `controlConnected` after `control:disconnected`**
  (no `control:connected` subscription; value derived from `isRunning` at start).
  Solo Phase-1 never disconnects; reconnection handling is a Phase-2 concern.
- **Dead `.mode-distributed` CSS** in `App.svelte` (the `CadreMode` type is `'solo'`
  only). Harmless forward-looking style; left for Phase 2.

### Major findings: none.
No correctness, security, type-safety, or resource-cleanup defect rises to a new
ticket. The implement-stage "known gaps" (Tier-2 distributed e2e parked & needing
a cadre-model rewrite; control-discovered-strand storage fallback; fail-soft
authority *failure* path unexercised; bundled demo author keypair; connection-path
duplicate collapse; CadrePeer-count-0 from cadre-core's no-op `registerSelf`;
unmeasured warm-restart hydration latency) are all legitimate **Phase 2** work and
are already owned by the named successor ticket
`reference-app-web-strand-formation-consent-rbac` — no decomposition needed here.

### Pre-existing test failures
None surfaced. No `tickets/.pre-existing-error.md` written. cadre-core source was
not modified by the implement commit, and the review touched only an inline
comment in the reference app.
