----
description: A group member whose machine is connected but slow or flaky can now block the group's shared-settings writes, where before it would have been ignored. Nothing tests what actually happens.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, docs/architecture.md
difficulty: hard
----

# Coverage: control writes with a connected-but-degraded party member

A prior plan run researched the write path end to end and was cut short by the token budget
before writing the implement ticket. **The research below is the deliverable of that run — it is
findings, not guesses, with file:line citations.** What remains is a handful of bounded decisions
and then the implement ticket. Do not re-derive the mechanics; verify them if you doubt them.

## Why this ticket exists

The control (shared settings / membership) database used to replicate each block to two machines.
It now replicates to every machine in the party (`CONTROL_REPLICATION_BREADTH` = 16, shipped by
`control-db-replicates-to-whole-party`), which fixed convergence: at two copies a machine that
missed a write could never catch up.

The cost lands on the write side. A control write commits only when a super-majority of the
*cohort* — the set of peers the block was offered to — approves. That cohort is now the whole
party. So a member that is **connected but degraded** (slow, packet-losing, mid-relay-reconnect)
sits inside the cohort and counts against the approval bar. At two copies the same member would
usually have been outside the cohort and simply ignored. Nobody has measured what that does.

## Research findings (established, with citations)

Paths below are in the sibling reference workspace `../optimystic` unless prefixed with
`packages/`.

### 1. The write path, and where it can block

`ControlDatabase` → Quereus → `NetworkTransactor` → `CoordinatorRepo` → `ClusterCoordinator`.

`ClusterCoordinator.collectPromises` (`packages/db-p2p/src/repo/cluster-coordinator.ts:460`)
fans out to every cohort peer and does a bare `Promise.all` over the results. **There is no
phase-level timeout.** The only thing that bounds a slow peer is the per-RPC deadline one layer
down. That is the single most important fact for this ticket: the coordinator itself would hang
forever on a silent peer if the transport did not cut it off.

### 2. What actually bounds a silent peer

`ClusterClient.update` (`packages/db-p2p/src/cluster/client.ts:32`) applies
`withRpcDeadlineDefaults`, so every remote cluster RPC carries
(`packages/db-p2p/src/rpc-deadline.ts:19,26`):

- `DEFAULT_DIAL_TIMEOUT_MS` = 3000 — bounds connecting, throws `DialTimeoutError`.
- `DEFAULT_RESPONSE_TIMEOUT_MS` = 10000 — bounds waiting for a reply on an established stream,
  throws `ResponseTimeoutError`. The implementation actively calls `stream.abort(...)`
  (`packages/db-p2p/src/protocol-client.ts:129`), so it genuinely unblocks the read rather than
  merely arming a timer.

`ClusterCoordinator.updateMember` (`cluster-coordinator.ts:132`) then re-attempts a *remote*
failure `promiseImmediateRetries` times, default 1, so **two** attempts. Local peers bypass the
client entirely and are invoked exactly once.

### 3. Therefore: the predicted outcome is a clean failure, not a hang

For a three-node party with one member that accepts the stream and then never replies:

- Promise phase costs roughly 2 × 10 s ≈ **20 s** (both attempts hit the response deadline; the
  second attempt's dial is warm), because all peers are dialled in parallel and the phase is as
  slow as its slowest peer.
- `approvalCount` = 2, `peerCount` = 3, `superMajority` = `ceil(3 × 0.75)` = 3
  (`cluster-coordinator.ts:334`).
- `peerCount > 1 && approvalCount < superMajority` → throws
  `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`
  (`cluster-coordinator.ts:364-374`).

For a member that is merely **slow but under the deadline** (say a 2 s delay), it approves and
the write commits, paying the delay as added latency.

So the expected shape is: *fast degradation → success with latency; degradation past 10 s → a
clean, named super-majority failure in the low tens of seconds.* **This prediction is the thing
the test must confirm or refute.** If measurement shows a hang instead, that is a defect this
ticket has found, not a test bug — see "If the finding is a hang" below.

One thing left to measure rather than reason about: whether a layer above multiplies the ~20 s.
`CoordinatorRepo` carries a 30 s default transaction budget
(`packages/db-p2p/src/repo/coordinator-repo.ts:137`, `DEFAULT_TIMEOUT`) that becomes the message
`expiration`, and `NetworkTransactor` has a batch-retry loop gated on `Date.now() < expiration`
(`packages/db-core/src/transactor/network-transactor.ts:164`). Whether a super-majority failure
is classed retryable there — and so whether the caller waits ~20 s or several multiples of it —
was not traced. **The test should measure the caller-visible wall time and error rather than
assume.**

### 4. The blocker: cohorts in tests are self-only

A naive "stand up three nodes and write" test proves nothing, because the cohort will be size 1
and the super-majority branch is never reached.

`Libp2pKeyPeerNetwork.findCluster` (`packages/db-p2p/src/libp2p-key-network.ts:556`) builds the
cohort as `[self, ...serves]`, where `serves` comes from `fret.assembleCohort(...)` filtered to
peers whose peerStore protocol list already contains this network's prefixed protocol
(`/optimystic/<networkName>`). FRET's routing table is not warm within a test's lifetime — the
harness comment at `packages/integration-tests/src/harness/test-party.ts:56` records 213/213
single-peer cohorts measured across a `happy-path` run, tracked as
`backlog/debt-harness-control-cohort-never-multi-peer`.

This plan **does not** try to solve that backlog ticket. It forces the cohort instead.

### 5. The forcing seam (found, verified by reading the wiring)

`createLibp2pNode` attaches the key network to the returned node:
`(node as any).keyNetwork = keyNetwork` (`packages/db-p2p/src/libp2p-node-base.ts:1301`), and it
is the *same object instance* the coordinator captured
(`libp2p-node-base.ts:695` → `coordinatorRepo(keyNetwork, ...)` at `:817`). `ClusterCoordinator.
getClusterForBlock` calls `this.keyNetwork.findCluster(...)` on it. So wrapping
`node.keyNetwork.findCluster` after node creation forces the cohort while leaving the real
`ClusterClient` (and therefore the real 3 s / 10 s deadlines), the real libp2p transport, and the
real `ClusterMember` on each peer in place. That is the minimum honest forcing: it substitutes
cohort *discovery*, which the harness cannot do, and nothing else.

### 6. Trap: patch all three nodes, not just the coordinator

Each member independently re-derives its own view of the cohort and gates the coordinator's
declared peer set against it — `deriveExpectedCluster` (`libp2p-node-base.ts:783`) feeding
`ClusterMember.admitMembership` (`packages/db-p2p/src/cluster/cluster-repo.ts:884`).

If only the coordinator is patched, the members' own `findCluster` still returns self-only, and
the outcome depends on FRET's network-size confidence in a way the test does not control:

- **Not confident** (`confidence <= MembershipConfidenceThreshold`, the likely case in tests):
  falls to the low-confidence branch, `assumedClusterSize` = 2 (Cadre leaves Optimystic's
  default, see the `CONTROL_REPLICATION_BREADTH` docblock), floor = `max(2, ceil(0.67 × 2))` = 2,
  declared = 3 ≥ 2 → **admits**. The test would work.
- **Confident**: `kEst` = 1 from the self-only view, so predicate 3 computes
  `symmetricDifference({a,b,c}, {self})` = 2 against `maxDiff = ceil(0.5 × 1)` = 1 → **rejects**
  with `membership-not-admitted:inconsistent-with-derived-view` (`cluster-repo.ts:961-975`).

A test whose result flips on FRET's confidence measures the wrong thing. **Patch `findCluster` on
all three nodes to return the same three-peer set**, so every member's derived view matches the
declared set and the admission gate is a no-op regardless of confidence. Assert that no vote
carries a `membership-not-admitted` reason, so the test fails loudly if the gate ever does bite
rather than silently reporting a super-majority failure with the wrong cause.

### 7. The degraded peer itself

The ticket's own preferred shape — "accepts the stream and then stalls" — is the one that lands
squarely on `ResponseTimeoutError` and is trivially deterministic. Realise it by registering a
handler for `/optimystic/<networkName>/cluster/1.0.0` that reads the request and then delays a
configurable number of milliseconds (or never replies) before responding. A configurable delay
gives the whole matrix from one knob: well under the deadline → approves; past the deadline →
times out.

## Decisions still open (settle these, then emit the implement ticket)

Each is bounded. None needs a human; pick the better option and write the tradeoff into the
implement ticket.

- **Which package hosts the spec.** Leading candidate is `packages/integration-tests` alongside
  `control-cohort-three-node-isolation.integration.ts`, since three real libp2p nodes is what that
  suite is for. Weigh against `packages/cadre-core/test`, which has the better per-operation
  deadline harness (`control-db-node-helpers.ts` `withinOp`) but is not where multi-node real-
  network tests live. Whichever is chosen, the labelled-deadline pattern from `withinOp` must come
  along — a freeze has to report as a named failure, not a bare vitest timeout.
- **Whether the degraded third node is a full `CadreNode` with a wrapped cluster handler, or a
  bare libp2p node that registers the cluster protocol and stalls.** The bare node is far cheaper
  and is enough to make the cohort arithmetic real; the full node is more faithful. Decide on
  whether anything in the write path requires the third peer to also serve the repo/sync
  protocols.
- **Where the `findCluster` patch lives.** A named test helper (not an inline cast per spec) so
  the forcing is visible and reviewable, and so the "patch all three" invariant is expressed once.
- **The delay matrix.** At minimum: no degradation (control case, must commit), degraded under the
  response deadline (must commit, with latency asserted as bounded), degraded past the deadline
  (must fail with the named super-majority error inside a stated budget). Include the three-node
  boundary explicitly, since `ceil(3 × 0.75) = 3` means one degraded member is decisive.

## Edge cases & interactions the implement ticket must carry forward

- **Reads while a write is degrading.** A control read issued while the promise phase is stalled
  must still answer from local state under its own deadline — the same liveness property
  `control-database-offline-peers.spec.ts` asserts for unreachable peers.
- **Both write directions.** `authorizePeer` (owner-vouched INSERT) and `removePeer` (stamp-
  retiring DELETE) are genuinely different SQL paths; the offline-peer review found the DELETE
  path had been missed. Cover both.
- **Recovery.** After the degraded member is restored, a subsequent write must commit normally —
  a failed write must not leave the coordinator or the transaction state store wedged.
- **The write-while-alone re-replication queue.** `CadreNode.noteControlWrite` flags writes that
  commit alone; check what it does (and does not) record when a write *fails* rather than
  commits self-only.
- **Cleanup on the failure path.** Every node stopped in a `finally`, and the stalling handler
  torn down, so a failed assertion cannot leak a live libp2p node or a pending stream into the
  next test.
- **No silent vacuity.** Assert the cohort really was three peers for the write under test. A
  regression that quietly returns to a self-only cohort would otherwise turn this into a test
  that passes by measuring nothing.

## If the finding is a hang

Then the coordinator's unbounded `Promise.all` (finding 1) is reaching production unprotected and
the RPC deadline is not covering some path. That is a defect, not a test bug: file it as a
`fix/` ticket naming the exact operation that froze and the elapsed time, and keep the test as the
reproducer rather than loosening it.

## Explicitly distinct from three neighbouring tickets (all now in `complete/`)

- `debt-control-db-offline-peer-no-hang-coverage` covers members that are **unreachable**. Those
  never enter the cohort, and the write commits self-only under `allowDownsize`. This ticket is
  about members that *do* enter the cohort. Do not merge the two.
- `control-cohort-three-node-reconcile-isolation-test` is about whether the nodes form dials with
  each other at all, not about approving a write.
- `debt-harness-supermajority-threshold-diverges-from-production` has **landed**: harness and
  production now share `CONTROL_CLUSTER_POLICY` and both resolve Optimystic's 0.75. That is why
  the `ceil(3 × 0.75) = 3` arithmetic above is the real bar and no longer needs to be a prereq.

## TODO

- Settle the four open decisions above.
- Confirm `ClusterMember.MembershipConfidenceThreshold` and `membershipAdmissionFraction` default
  values by reading `cluster-repo.ts` (the 0.67 figure above comes from the partition-safety note
  at `cluster-repo.ts:991`, not from the field declaration).
- Trace whether `NetworkTransactor`'s batch-retry loop retries a super-majority failure, so the
  implement ticket can state the expected wall-clock budget instead of guessing it.
- Write the implement ticket with the delay matrix, the per-operation deadline labels, the
  `## Edge cases & interactions` section above, and the explicit expected error string
  (`Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`).
