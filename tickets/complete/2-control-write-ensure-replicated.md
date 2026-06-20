description: A node that changed the shared membership database while no other node was online used to keep that change trapped locally forever; now it re-sends those changes once another node connects, so they finally reach the rest of the group.
files: packages/cadre-core/src/cadre-node.ts (write-while-alone re-replication: state fields, committedAlone/noteControlWrite/drain/reconstruct/retouch/connection-listeners, instrumentation in publishSelfRecord/registerDeviceToken/authorizePeer/removePeer, wiring in start() + teardown in stopRecordRefresh), packages/cadre-core/src/seed-bootstrap.ts (canAuthorize, reauthorizePeer), packages/cadre-core/test/cadre-node-control-replication.spec.ts (18 unit tests — 15 from implement + 3 added in review for retouchSelfDeviceToken), packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts (2 live-network scenarios), docs/architecture.md (Control Network status), tickets/backlog/control-delete-while-alone-tombstone.md (follow-up), tickets/backlog/control-rereplication-broadcast-confirmation.md (follow-up filed in review)
----

## What shipped

Closes the **write-while-alone durability gap** for insert/update-shaped control
writes. An authority that authorizes/removes a peer or (re)publishes its own
`CadrePeer`/`DeviceToken` while no sibling is connected commits **local-only**
(Optimystic does not broadcast when the block's cluster is ≤1). `CadreNode` now:

1. **Detects** the local-only commit — `committedAlone()` (`getConnections().length === 0`,
   a sound lower bound) instrumented at the four write sites.
2. **Re-issues** queued writes on the 0→≥1 control-connection growth edge
   (`connection:open` listener wired in `start()`; single-flight
   `drainPendingControlReplication`): re-touches self rows (`registerSelf` +
   `retouchSelfDeviceToken`), re-issues pending authorizes as an authority
   `UpdatedAt` bump (`SeedBootstrapService.reauthorizePeer`, the authority branch of
   `CadrePeer.AuthorizedUpdate`), best-effort re-issues removes.
3. **Survives restart** — on first growth an authority reconstructs the queue by
   re-touching every `Sig`-null membership row it may have authored.

State resets in `stopRecordRefresh` so a `stop()→start()` cycle re-arms the edge.

## Review findings

Adversarial pass over the implement commit (`65be03a`). The implementation is
**correct and ships as described** — verified end-to-end, not just by the
handoff summary.

### Verified (checked, found sound)

- **Schema correctness of `reauthorizePeer` (the crux).** The authority branch of
  `CadrePeer.AuthorizedUpdate` (`control-schema.ts:95`) accepts an UPDATE that sets
  only `UpdatedAt` when `verify(digest(new.PeerId), context.Signature, A.Key)`
  passes. The re-issue signs `peerAuthorizationDigest(peerId)`
  (`digest([peerId],'sha256','base64url')`) — byte-identical to the INSERT path and
  to the SQL mirror `digest(new.PeerId)`. Confirmed against `peer-authorization.ts`.
- **Self-`Sig` safety.** Re-touching a self-signed row would invalidate its
  signature (the self-sig covers `PeerId|Multiaddr|UpdatedAt`). Both the queue drain
  and reconstruction correctly **skip** rows where `record.sig` is truthy; only
  authority-authored `Sig`-null rows are bumped. Verified in code and unit tests.
- **Monotonicity.** `reissuePeerAuthorize` writes `max(Date.now(), stored+1)`, so
  re-issues strictly increase even on a same-ms repeat; `record.updatedAt`-null is
  handled.
- **Event wiring.** `connection:open`/`connection:close` are real libp2p node events
  (used elsewhere in the repo). Listeners wired in `start()` (no early edge missed),
  torn down once in `stopRecordRefresh` (the only caller, via stop) — not prematurely.
- **Single-flight + edge semantics.** Concurrent drains collapse; the 0→≥1 edge
  fires once and re-arms only after a full disconnect; reconstruction is one-shot.
  All covered by unit tests.
- **Queue clear-on-connected and remove-wins.** `noteControlWrite` drops stale
  entries on a connected write and lets a later op for the same subject overwrite an
  earlier one. Covered.

### Lint / tests / typecheck (all green)

- `eslint` clean on all touched files (incl. the new tests).
- `yarn workspace @serfab/cadre-core test` → **591 passed / 1 skipped**
  (44 files; was 590+1 — the 3 unit tests added this pass account for the delta).
- `typecheck` clean for `@serfab/cadre-core` and `@serfab/integration-tests`.
- Did **not** run the full network-heavy integration suite (long, not
  agent-runnable in-ticket); the two new live scenarios are documented and were run
  green by the implementer.

### Fixed inline (minor)

- **Unit coverage for `retouchSelfDeviceToken`.** This method (the drain's
  self-device-token re-touch) was stubbed out in every existing unit test — zero
  unit coverage; only the integration scenario exercised it. Added 3 unit tests
  (`cadre-node-control-replication.spec.ts`) covering its guard logic: re-registers
  an existing push-platform token, no-ops on a missing row, no-ops on an
  unknown platform. (The full `registerDeviceToken` queueing path needs a real
  self-signing key, so it remains integration-tested by design — not duplicated.)

### Filed as follow-up (major — design needed, not fixed inline)

- **`control-rereplication-broadcast-confirmation` (NEW, backlog).** The drain
  clears a queued entry as soon as `db.exec` returns, but a successful exec does not
  mean the write broadcast — if the 0→≥1 growth edge is a relay / non-block-cluster
  peer, the re-issue re-commits local-only and the entry is dropped anyway, with no
  retry while continuously connected (the drain fires on the edge only) and
  reconstruction being one-shot. Partial safety nets exist (peer self-publish,
  self-row heartbeat), but an authority-authored `Sig`-null row for a slow-to-publish
  peer can be forgotten unreplicated. Needs a broadcast-confirmation / `getClusterSize`
  seam or a bounded reconcile-driven retry — a design decision, hence a ticket. This
  is the implementer's flagged "consider a bounded retry" concern, previously
  untracked.
- **`control-delete-while-alone-tombstone` (filed by implement, backlog).**
  `removePeer`/`clearDeviceToken` are physical deletes; a delete-while-alone leaves
  no local row to re-issue, so a revoked peer can persist elsewhere (security-
  relevant). Shipped disposition is loud-log + best-effort re-issue + this follow-up
  for a schema tombstone. Reviewed and confirmed as the correct deferral; the
  remove path is unit-tested for queueing/best-effort only (not end-to-end
  convergence, which the tombstone work will provide).

### Acceptable documented limitations (no new ticket)

- **Coarse `getConnections()===0` proxy** for "alone" — over-approximates safely
  (re-issue is idempotent); the precise `getClusterSize` tightening is folded into
  the broadcast-confirmation follow-up above.
- **Reconstruction over-applies** (`O(rows)` re-touch of all `Sig`-null rows on
  first connect after restart) — harmless (monotonic), bounded by the small control
  tables.
- **Docs** (`architecture.md`) read accurately against the shipped code: inserts/
  updates marked ✅, delete-while-alone called out as the remaining open
  security-relevant gap. No stale references elsewhere.
