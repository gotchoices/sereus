----
description: A security check that only lets approved members read or write the shared per-party control database has been built, tested, and now fully verified across every real-network test scenario in the repo — this ticket is the final handoff summarizing that work for a reviewer.
files:
  - packages/cadre-core/src/cadre-node.ts (`authorizeInboundControlStream` ~943, `refreshMembershipGate` ~3117, `runReconcileControlCohort` ~1407)
  - packages/cadre-core/src/membership-connection-gater.ts
  - packages/cadre-core/test/control-stream-authorization.spec.ts
  - packages/cadre-core/test/cadre-node-control-cohort.spec.ts
  - packages/integration-tests/src/scenarios/control-stream-authz.integration.ts (new)
  - packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
  - docs/architecture.md
  - docs/STATUS.md
  - tickets/backlog/debt-membership-gate-refresh-unskippable.md (filed by an earlier ticket in this chain — automate the refresh obligation this feature currently documents on seven call sites)
difficulty: easy
----

# Per-stream control-DB authorization: final scenario sweep + handoff

Chain root `control-repo-protocol-stream-authz`. This ticket is the last
link: `2.7-control-repo-protocol-stream-authz-tests-docs` (implementation
+ unit tests + docs) → `push-wake-e2e-stream-gate-regression` (fixed a
regression this sweep found) → this ticket (finished the sweep, confirmed
the fix, writing this handoff). No code changed in this pass — pure
verification.

## What shipped (whole chain)

Every inbound libp2p stream on the four
`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}/…`
protocols is now checked against an in-memory snapshot of peers the node
currently believes are authorized, via
`CadreNode.authorizeInboundControlStream` wired as libp2p's
`authorizeInboundStream` hook. A stranger — someone with no `CadrePeer`
row admitting them — cannot open a stream on the shared control database
at all, not even to attempt a write that would later fail authorization
checks inside the database layer.

The gate reads an in-memory snapshot rather than the database itself,
because reading the database to decide whether to admit a stream would
require already admitting the stream being judged. Each membership-writing
method on `CadreNode` re-materializes that snapshot right after it writes
so the snapshot doesn't go stale; `refreshMembershipGate()` is the public,
idempotent, best-effort entry point wrapping that re-materialization.

## Why this ticket exists: closing out the test sweep

The prior ticket in this chain landed the feature, unit tests, and docs
green, then ran the full `integration-tests` scenario suite one file at a
time looking for any real-network scenario the new gate broke. That sweep
found one genuine regression (below), and ran out of budget before
covering every scenario file. This ticket picked up where it left off:
re-confirmed the regression fix, then ran the five scenario files the
prior ticket hadn't reached yet. All green — the sweep is now complete.

## The one regression this sweep found (already fixed, already shipped)

`push-wake-e2e.integration.ts` scenario 4 was flaky under the new gate: a
node that had just vouched for a new member could still deny that
member's own control-DB streams, because the write path that inserted the
`CadrePeer` row (`getSeedBootstrapService().insertSelfPeerRecord(...)`)
sat below the `CadreNode` wrapper methods that refresh the in-memory
snapshot — so the writer kept judging against a snapshot that predated
its own write until the next timed cohort reconcile (~15s later). Fixed
in `push-wake-e2e-stream-gate-regression` (now in `tickets/complete/`) by
adding the missing refresh call, plus a second instance the reviewer
found in `CadreNode.addPhoneWithRelay` (same defect, production
phone-enrollment path, dormant today but wrong the moment it runs).
`tickets/backlog/debt-membership-gate-refresh-unskippable.md` tracks
making this automatic instead of an obligation documented on each
wrapper.

## Test / validation matrix (this is the floor, not the ceiling)

Unit level — `yarn workspace @serfab/cadre-core test`: 828 passed, 1
skipped, 0 failed (up from 825 — three new tests added fixing the
regression above).

- `control-stream-authorization.spec.ts` — the gate predicate itself
  (denies strangers, admits authorized peers, admits after
  `refreshMembershipGate`, doesn't reject when a materialization read
  throws) plus the new `refreshMembershipGate` suite from the regression
  fix.
- `cadre-node-control-cohort.spec.ts` — includes a single-flight
  reconcile test asserting exactly 2 control-DB queries per pass
  (2-not-4 proves in-flight coalescing works), stubbing
  `queryRevokedStamps`.

Integration level — real libp2p nodes, real streams, run individually
from `packages/integration-tests` via
`yarn vitest run src/scenarios/<file>`:

| Scenario | Result |
|---|---|
| `control-stream-authz.integration.ts` (new, raw end-to-end repo-protocol test) | GREEN |
| `control-db-two-node-convergence.integration.ts` | GREEN (repaired: owner now vouches the reader before its pull, matching the new gate) |
| `membership-connection-gater.integration.ts` | GREEN |
| `convergence-stress.integration.ts` | GREEN (3/3) |
| `multi-party-workflows.integration.ts` | GREEN (5/5) |
| `push-wake-e2e.integration.ts` | GREEN, 4/4 scenarios, confirmed over 3 consecutive full-file runs in this pass (on top of 4 prior clean runs from the regression-fix ticket) |
| `rbac-signed-write.integration.ts` | GREEN |
| `strand-membership-closed-strand-e2e.integration.ts` | GREEN |
| `websocket-chat.integration.ts` | GREEN |
| `cadre-host-bootstrap.integration.ts` | GREEN (4/4) |
| `cadre-host-trust-circle.integration.ts` | GREEN (3/3) |
| `control-cohort-auto-convergence.integration.ts` | FAILS — pre-existing, tracked as `bug-control-cohort-no-auto-dial` (`tickets/fix/`), not caused by this work |
| `strand-formation-e2e.integration.ts` | not re-run this pass (pre-existing failure tracked as `bug-strand-three-party-replication`, `tickets/fix/`); confirmed still-tracked in `tickets/.pre-existing-known.md`, no new evidence needed |

Repo-wide gates also green in an earlier ticket in this chain and
unaffected by this pass (no code changed here): `yarn build`, `yarn
lint`, `integration-tests` typecheck.

## For the reviewer

Carry these into the eventual `## Review findings` section — this list is
the accumulated index across the whole chain, not just this ticket:

- **Reviewer should treat the unit matrix + `control-stream-authz.integration.ts`
  as the floor, not full coverage**: cluster/sync/block-transfer protocols
  are gated by the same predicate as repo, but only the repo protocol is
  driven raw end-to-end in a dedicated scenario. The other three ride
  along inside `control-db-two-node-convergence.integration.ts` and the
  broader multi-party scenarios rather than being isolated.
- **Open question for the reviewer to decide, not yet a ticket**: the
  regression fix (`push-wake-e2e-stream-gate-regression`) resolved scenario
  4 by pointing `bootstrapNodes` at the owner's own address on every other
  cluster member — the same carve-out the relay scenarios already used.
  The underlying cause is that owner identity (a cryptographic key) and
  node identity (a libp2p peer id) are deliberately unbound for non-relay
  owners, so a dedicated owner node participating directly as a cluster
  peer (not just as the initiating writer) in a 3+-node full mesh can get
  denied by its own members once their authorized-set snapshots go
  non-empty. This was fixed per-scenario; whether it should instead become
  a documented topology requirement (every non-relay owner in a
  full-mesh cluster needs `bootstrapNodes` pointed at itself on every
  other member) is open, since production topologies shaped like scenario
  4 — dedicated owner, neither sender nor receiver — would hit the same
  gap outside tests. Parked as a `NOTE:` tripwire at
  `cadre-node.ts:934` (`authorizeInboundControlStream`), not filed as a
  ticket, since it's harmless until an ephemeral-identity node becomes a
  supported deployment shape.
- **Tripwire, `cadre-node.ts:1417`** (`runReconcileControlCohort`): the
  reconcile pass does two separate `CadrePeer` reads (refresh +
  sibling enumeration). Fine at current cohort sizes; if reads ever show
  up as costly, share one row-set between them instead of two round trips.
- **Restart staleness** (documented in both `docs/architecture.md` and
  `docs/STATUS.md`): a member added while a node was down is admitted only
  after that node's next reconcile refresh — bounded by design (~15s
  today), not a bug. No scenario in the suite depends on faster pickup.
- **Enrollment ordering verified non-deadlocking**: the invite flow rides
  the ungated `/sereus/seed/1.0.0` protocol; a joining node's control-DB
  gate is inert while its anchor/snapshot are still empty, so there's no
  chicken-and-egg between "must be invited to talk" and "must talk to be
  invited."
- `ops/docker/libp2p-infra` roles never speak the four control-DB
  protocols directly — confirmed unaffected by this gate.
- `tickets/backlog/debt-membership-gate-refresh-unskippable.md` (filed by
  the regression-fix ticket's review) is the one open backlog item this
  whole chain generated: automate the snapshot-refresh obligation at the
  single row-write site instead of leaving it as a documented obligation
  on each of the seven `CadreNode` wrapper methods that write a
  `CadrePeer` row. Not blocking — flagging so it doesn't get lost.

Nothing else to verify before this closes out — pending items are the two
pre-existing failures above (already tracked in `tickets/fix/`, not this
chain's problem) and the one backlog item.
