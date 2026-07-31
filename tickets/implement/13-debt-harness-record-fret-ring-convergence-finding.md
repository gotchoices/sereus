description: Test machines do find each other after a few seconds, so the earlier suspicion that a machine receiving connections forgets its peers was wrong. Correct the misleading comment in the test setup code that still says otherwise, and record what was actually measured.
prereq:
files: packages/integration-tests/src/harness/test-party.ts, C:/projects/Fret/packages/fret/src/service/fret-service.ts, C:/projects/optimystic/packages/db-p2p/src/libp2p-key-network.ts
difficulty: easy
----

# Record the measured FRET ring-convergence finding; fix the stale harness comment

Replaces `debt-harness-control-cohort-diagnose-empty-fret-ring` (deleted). That ticket's
diagnosis question is **answered** — the measurement is below. What remains is small:
one comment in the harness is factually wrong and points at a ticket slug that no longer
exists, and the measured numbers need a home a future reader will actually find.

## The answer (measured, not inferred)

**The hypothesis is refuted. Peers that only ever dial *in* to a node do enter that node's
peer-routing ring, within about five seconds.**

Method: a temporary scratch scenario booted the standard `createTestParty` topology
(one owner + two drones, real libp2p over TCP) and sampled the owner's and each drone's
FRET state every 5 s for 30 s — live connection count, the serialized routing table with
each entry's membership label, and `assembleCohort(coord, 15)` size. The scratch file was
deleted after the run; the numbers it produced:

| sample | owner conns | owner table | owner cohort | drone conns | drone cohort |
|--------|-------------|-------------|--------------|-------------|--------------|
| t=0 s  | 0 | 1 (self)          | **1** | 0 | 1 |
| t=5 s  | 2 | 3 (all `member`)  | **3** | 1 | 2 |
| t=10…30 s | 2 | 3 (all `member`) | **3** | 1 | 2 |

Three things follow.

**1. It is a start-up race, not a structural defect.** At the instant `createTestParty`
resolves, *no* node has dialled anything yet — the owner shows zero connections and a
self-only ring. libp2p's bootstrap discovery then dials, and within the next five seconds
the owner's ring holds all three peers, all classified as serving this network. So the
self-only cohorts that scenarios observe are writes issued **before the ring warms**, not
a node that can never learn its peers. This is a *convergence latency* finding: the fix is
that scenarios must wait for the cohort, which is exactly what
`debt-harness-control-cohort-observable-and-forced` builds.

Precision limit, stated honestly: the first sample after t=0 was at t=5 s, so all we know
is **N ≤ 5 s**. Nobody needs a tighter number — the harness should wait on the observable,
not on a hard-coded delay.

**2. Why inbound peers do get in.** In `fret-service.ts`, `FretService.start` registers a
`peer:connect` listener that upserts the remote into the routing table regardless of which
side dialled (line ~307), and `seedFromPeerStore` re-enumerates the whole libp2p peer store
on every stabilization tick (~1.5 s in passive mode). Ring *reads* are then gated on a
`membership: 'member'` label, which a peer earns either from libp2p `identify` reporting
one of this network's namespaced protocols (`classifyByProtocols`) or from a successful
namespaced ping (`classifyUnknownPeers` → `applySuccess`). Both paths work over an inbound
connection. The configured `bootstraps` list is only one seed source among several, not the
only one.

**3. A real, permanent limit in the star topology — drones cap at a two-member cohort.**
Each drone's cohort stabilizes at 2 (itself + the owner) and never grows, because the two
drones never connect to each other and hold no address for each other. FRET's
classification probe can only ping peers it can reach (`isConnected` or `hasAddresses`), so
each drone's sibling stays labelled `unknown` forever and is excluded from ring reads. This
is not a bug — nothing in `createTestParty` ever introduces the drones to each other — but
it means **a write coordinated by a drone can never see more than two cohort members in
this harness, no matter how long it waits.** Only the owner sees all three. Any scenario
that needs a genuine three-member cohort must either write through the owner or add
drone↔drone connectivity.

## Answer for the sibling ticket

`debt-harness-control-cohort-observable-and-forced` asked one question of this ticket:
is forcing a cohort permanent or a stopgap? **Stopgap.** For owner-coordinated writes a
plain wait-for-cohort observable is sufficient and preferable — the real cohort does form.
Forcing retains a narrower justification: drone-coordinated writes (point 3 above) and
tests that want a specific cohort shape without paying start-up latency.

## Not done, and deliberately so

The original ticket also asked for a probe against the `CadreNode` trio used by
`control-cohort-three-node-isolation.integration.ts`, and for isolating two config
variables (`arachnode.enableRingZulu` on every harness node, and the owner running the
`edge` FRET profile). Both were framed as ways to *explain a structural failure that turns
out not to exist*. Neither is worth a run now: the trio scenario already forms real
outbound connections in both directions and passes, and the prior pass reported that
flipping the owner to `storage`/`core` changed nothing. If a future scenario sees a
cohort that never warms **after** waiting past the convergence window, reopen from there.

## TODO

- Replace the `NOTE:` block in `packages/integration-tests/src/harness/test-party.ts`
  (currently lines ~56–60, inside the `createTestNode` `clusterPolicy` comment). It
  asserts that FRET "returns no non-self candidates within a test's lifetime" — measured
  false — and cites `backlog/debt-harness-control-cohort-never-multi-peer`, a ticket that
  no longer exists. The replacement should state, briefly: the owner's ring reaches all
  party members within ~5 s of party creation; writes issued before that see a self-only
  cohort and commit on the writer's own vote under `allowClusterDownsize`; scenarios that
  care must wait for the cohort. Point at
  `debt-harness-control-cohort-observable-and-forced` for the wait helper.

- Add a second short `NOTE:` at the drone-creation loop in the same file recording point 3
  above — drones never learn each other's addresses, so a drone's cohort is capped at two
  members permanently. Keep it to two or three lines; it is a property of the topology, and
  the loop is where a reader meets it.

- No test changes. Nothing here is a behaviour change; `yarn workspace @serfab/integration-tests typecheck`
  plus a lint pass is sufficient validation for a comment-only diff.

## Edge cases & interactions

- **Do not weaken the surrounding comment.** The block being edited also explains why
  `clusterPolicy: CONTROL_CLUSTER_POLICY` and `clusterSize: CONTROL_REPLICATION_BREADTH`
  are shared with production. Only the `NOTE:` paragraph is stale; the rest must survive
  intact.
- **Do not restate the measurement table in code.** The numbers belong in the completed
  ticket; the comment needs the consequence ("wait for the cohort"), not the data.
- **Another agent may be editing this file** for the sibling harness ticket. Touch only
  the comment blocks named above.
- **`yarn workspace @quereus/quereus build` may be required** before any vitest run in
  `packages/integration-tests` — the stale-build guard failed on it during this pass and
  the build was re-run. Not caused by this work.

## Related

- `debt-harness-control-cohort-observable-and-forced` — the harness wait/force helper.
  Sequence 13.5, i.e. it runs after this.
- `debt-control-write-unanimity-at-three-nodes` (in `plan/`) — the production-side
  fragility that a genuine three-member cohort would expose. Now reachable in the harness
  via owner-coordinated writes issued after the ring warms.
- `debt-harness-supermajority-threshold-diverges-from-production` — no longer inert once
  scenarios wait for the cohort.
