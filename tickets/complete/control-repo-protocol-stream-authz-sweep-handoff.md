description: A security check that only lets approved members read or write the shared per-party control database is finished, reviewed, and verified across the repo's real-network tests; the review also closed one remaining gap where members added by an incoming invitation seed were briefly refused.
files:
  - packages/cadre-core/src/cadre-node.ts (`authorizeInboundControlStream`, `refreshAuthorizedControlPeers`, `refreshMembershipGate`, `seedEventCallbacks`, `drainPendingPeerWrites`)
  - packages/cadre-core/src/membership-connection-gater.ts
  - packages/cadre-core/test/control-stream-authorization.spec.ts
  - packages/cadre-core/test/membership-gate-helpers.ts
  - packages/integration-tests/src/scenarios/control-stream-authz.integration.ts
  - packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
  - docs/architecture.md
  - docs/STATUS.md
----

# Per-stream control-DB authorization — complete

Chain root `control-repo-protocol-stream-authz`. Links, in order:
implementation → unit tests + docs → `push-wake-e2e-stream-gate-regression`
→ scenario sweep + handoff → this review.

## What shipped

Every inbound libp2p stream on the four
`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}/…`
protocols is checked against an in-memory snapshot of the peers this node
currently believes are authorized, via `CadreNode.authorizeInboundControlStream`
wired into libp2p's `authorizeInboundStream` seam (upstream
`@optimystic/db-p2p`, which aborts the stream before decoding any frame —
the remote sees a stream reset and its connection survives). A stranger with
no vouched `CadrePeer` row cannot open a control-DB stream at all.

The gate reads a materialized snapshot rather than the database, because
reading the database to decide whether to admit a stream would require
already admitting the stream being judged. The snapshot is re-materialized
out of band: at start, on every cohort-reconcile pass (~15s), after every
local membership write, and — added by this review — whenever an inbound
seed is applied. `refreshMembershipGate()` is the public, idempotent,
best-effort entry point for callers that write a `CadrePeer` row below the
`CadreNode` wrappers.

## Review findings

**Method.** Read the whole chain's code diff (`548236e..HEAD`, excluding
tickets) before the handoff summary: `cadre-node.ts`,
`membership-connection-gater.ts`, both unit suites, the new integration
scenario, and the two scenarios that were adjusted. Cross-checked the
upstream `authorizeInboundStream` contract in
`../optimystic/packages/db-p2p` to confirm the hook is scoped to the four
database protocols only (so `/sereus/seed/1.0.0` and
`/sereus/formation/1.0.0` are genuinely ungated and the enrollment
chicken-and-egg the handoff claims is real). Swept every `CadrePeer`
write site in the repo for a missing snapshot refresh.

**Fixed in this pass (minor):**

- *Real gap — an applied inbound seed never refreshed the gate.* The seed
  protocol handler writes its `CadrePeer` rows inside `SeedBootstrapService`,
  below every `CadreNode` membership wrapper, so a node that accepted a
  wire-delivered seed kept judging streams against a pre-seed snapshot until
  the next reconcile (~15s) — denying peers it had just admitted, and on a
  freshly enrolled node leaving the gate in its admit-all cold-start state
  for that window. This is the same defect class as the
  `push-wake-e2e` regression, at the one write site the chain had not swept.
  Fixed by refreshing in `onSeedApplied`. The two duplicated event-callback
  blocks (`initializeSeedBootstrap`, `enableSeedListener`) were collapsed
  into one `seedEventCallbacks()` helper so the two services cannot drift —
  the drift is exactly what would have re-opened this gap. New unit test:
  *an inbound seed application refreshes the gate for the peers it just wrote*.
- *Redundant work in the write-while-alone drain.* `drainPendingPeerWrites`
  refreshed the snapshot once per queued entry (a control-DB read each),
  and for the `authorize` branch the read was a guaranteed no-op — the row
  already existed locally and was already in the snapshot. Hoisted to one
  refresh after the drain settles.
- *Comment formatting.* A sentence added to the header comment of
  `control-db-two-node-convergence.integration.ts` had been jammed onto the
  same line as the following sentence; re-wrapped.

**Checked and found sound (no action):**

- The stream gate is a strict subset of the connection gate, sharing
  `admitControlPeerUnconditionally` so the two layers cannot diverge on the
  "no basis to judge" admissions. The two divergences that matter (enrollment
  window, outstanding invitation) are each covered by a unit test asserting
  connection-admit + stream-deny.
- Fail-open on read failure (`refreshAuthorizedControlPeers` keeps the
  previous snapshot, never clears) is the right direction: a transient DB
  error can neither drop a live member nor flip the gate back to admit-all.
- The predicate is synchronous and allocation-free on the hot path, so the
  upstream 5s deadline never trips.
- `registerSelf` refreshes only on the INSERT branch — correct, the
  `refreshed` branch is a self-update of a row already in the snapshot.
- Revocation is honored: the snapshot is built from the same
  revocation-filtered `listAuthorizedMembers` predicate as the connection
  layer, and `removePeer` refreshes inline. Unit-covered.
- No other `CadrePeer` write site in `packages/` bypasses a refresh
  (`cadre-host`, `cadre-cli`, `cadre-provider` all go through the wrappers).
- Docs read end-to-end rather than assumed current: the
  `docs/architecture.md` bullet and the `docs/STATUS.md` step-6 section both
  describe the landed design; both were updated here to include the
  seed-apply refresh path. `membership-connection-gater.ts`'s header no
  longer claims the Optimystic protocols lack a per-stream hook.

**Tripwires recorded (conditional; not tickets):**

- `cadre-node.ts`, `refreshAuthorizedControlPeers` doc: two refreshes in
  flight at once settle last-*completed*-wins rather than last-*read*-wins,
  so the snapshot can briefly hold the older read. Self-corrects on the next
  refresh; a single-flight guard would close it if the window ever matters.
- `cadre-node.ts:~1417` (`runReconcileControlCohort`), carried from the
  implement pass: two `CadrePeer` reads per reconcile (refresh + sibling
  enumeration); share one row-set if reads get costly.
- `cadre-node.ts` `authorizeInboundControlStream` doc, carried from the
  implement pass: the snapshot keys on peer id, so an ephemeral-identity
  node (owner status is a key, not a peer id) is denied by its siblings once
  their snapshots go non-empty. Handled today by configuring such a node as
  bootstrap infrastructure; needs key-based admission only if ephemeral
  identities ever become a supported deployment shape.

**No major findings — nothing was filed as a new ticket from this review.**
The one open item the chain generated remains
`tickets/backlog/debt-membership-gate-refresh-unskippable.md` (filed
earlier): make the snapshot refresh automatic at the row-write site instead
of an obligation documented on each wrapper. This review's seed-apply gap is
direct evidence for that ticket's value — a third site was missed exactly
because the obligation is manual.

## Validation

- `yarn lint` — clean.
- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn workspace @serfab/cadre-core test` — 829 passed, 1 skipped, 0 failed
  (up from 828; +1 for the seed-apply refresh test).
- `yarn workspace @serfab/integration-tests typecheck` — clean.
- Integration scenarios re-run after these edits (real libp2p nodes):
  `control-stream-authz`, `control-db-two-node-convergence`,
  `push-wake-e2e` (4/4), `cadre-host-bootstrap` (4/4),
  `cadre-host-trust-circle` (3/3), `multi-party-workflows` (5/5) — all green.
  The remaining scenario files were swept green by the prior ticket and are
  untouched by these edits.
- Two pre-existing failures remain out of scope and are already tracked in
  `tickets/fix/`: `bug-control-cohort-no-auto-dial`
  (`control-cohort-auto-convergence.integration.ts`) and
  `bug-strand-three-party-replication` (`strand-formation-e2e.integration.ts`).
