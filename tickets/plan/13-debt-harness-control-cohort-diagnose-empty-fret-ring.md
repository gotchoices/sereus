----
description: When a machine only receives incoming connections and never makes outgoing ones, it appears to forget its peers exist — so it decides alone on writes that should be agreed by the whole group. We need to find out whether that is a real product defect or only an artifact of how fast our tests run.
prereq:
files: packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, C:/projects/optimystic/packages/db-p2p/src/libp2p-key-network.ts, C:/projects/optimystic/packages/db-p2p/src/libp2p-node-base.ts, C:/projects/Fret/packages/fret/src/service/libp2p-fret-service.ts, C:/projects/Fret/packages/fret/src/service/peer-discovery.ts, C:/projects/Fret/packages/fret/src/service/discovery.ts, C:/projects/Fret/packages/fret/src/service/cohort.ts
difficulty: hard
----

# Diagnose why the peer-routing ring stays empty on an inbound-only node

Split out of `debt-harness-control-cohort-never-multi-peer` (deleted; this ticket and
`debt-harness-control-cohort-observable-and-forced` replace it). That ticket bundled a
product diagnosis with harness API work; the two are independent and the diagnosis is the
one that must resolve before any design choice can be defended.

## Plain statement of the problem

Optimystic decides who must approve a database write by asking the peer-routing layer
(FRET) for the peers nearest the key being written. In our integration tests that answer
is always "nobody but yourself", so every control-database write commits on the writer's
own vote. Machines that are visibly connected are not offered the write at all.

## What the prior pass established (carry this forward — do not re-derive)

**1. The membership filter is not the cause.** `Libp2pKeyPeerNetwork.findCluster`
(`libp2p-key-network.ts:556`) calls `fret.assembleCohort(coord, wants)` and then
classifies the non-self members it got back. The measured log line

```
findCluster:membership serves=0 unknown=0 foreignDropped=0 kept=1
```

has all three counters at zero, and those counters are computed by iterating
`cohort.filter(id => id !== selfId)` (line 593). All-zero therefore means that list was
**empty** — `assembleCohort` returned nothing but self. Nothing was filtered out; there
was nothing to filter. The investigation belongs in FRET's ring population, not in
`findCluster`.

**2. This is NOT specific to the `createTestParty` harness.** The original ticket asserted
that the scenarios building `CadreNode` directly do reach three-machine cohorts. The
header of `control-write-degraded-cohort-member.integration.ts` (lines 33–41) says the
opposite, and it is the file that actually measured it: *"FRET's routing table stays cold
inside a test's lifetime, so real cohort discovery returns self-only cohorts that never
reach the super-majority branch."* That whole scenario only works because it patches
cohort discovery out (see point 4). Treat "harness-specific" as **refuted** unless this
ticket re-measures and shows otherwise. The claim in the original ticket that
`debt-control-write-availability-degraded-cohort-member` "cannot be written until this is
fixed" is likewise stale — that scenario exists and passes today.

**3. The leading hypothesis, unconfirmed.** In `libp2p-node-base.ts:638-652`, FRET is
constructed as

```ts
fretService({ k: 15, m: 8, capacity: 2048, profile, networkName,
              bootstraps: options.bootstrapNodes ?? [] })
```

In `createTestParty` the **owner** node is created with `bootstrapNodes: []` (it is the
bootstrap), and the drones are created with the owner's addresses. The drones dial *in* to
the owner. If FRET seeds its ring only from its configured bootstrap list and from peers
it dials outbound — and not from inbound connections or from libp2p `identify` /
`peer:discovery` events — then the owner's ring is self-only by construction and stays
that way forever, which matches the observation exactly. This hypothesis was NOT verified;
the FRET service files listed in `files:` were located but not read.

## TODO

Phase 1 — confirm or refute the hypothesis

- Read `C:/projects/Fret/packages/fret/src/service/libp2p-fret-service.ts`,
  `peer-discovery.ts`, `discovery.ts` and `cohort.ts`. Answer one question in writing:
  **what events insert a peer into the ring store?** Specifically whether any of
  `connection:open` for an *inbound* connection, libp2p `peer:identify`, or
  `peer:discovery` reaches the ring, versus only the configured `bootstraps` list plus
  peers reached by an outbound stabilization walk.
- Write the answer down in the next ticket regardless of which way it goes — it is the
  fact that decides everything downstream.

Phase 2 — measure it directly, do not infer

- Add a temporary (not committed) probe, or a short scratch scenario, that boots the
  `createTestParty` topology and prints `fret.assembleCohort(...)` size on the owner at
  intervals over ~30 s. Expected outputs to distinguish the two worlds:
  - **stays 1 indefinitely** → structural: inbound peers never enter the ring. Product
    question (see phase 3).
  - **reaches 3 after N seconds** → merely slow convergence. Then the finding is a
    latency number, and the fix is that scenarios must *wait* for the cohort rather than
    assume it — which is exactly what
    `debt-harness-control-cohort-observable-and-forced` builds. Record N.
- Run the same probe against the `CadreNode` topology used by
  `control-cohort-three-node-isolation.integration.ts` (which does form real *connections*
  via `reconcileControlCohort`) to settle point 2 above with a measurement rather than a
  comment.
- Also test the two variables the original ticket flagged but never isolated: the
  harness sets `arachnode: { enableRingZulu: true }` on **every** node where production
  sets it only for storage-profile nodes, and the owner runs the `edge` FRET profile
  (`fretProfile: profile === 'storage' ? 'core' : 'edge'`, `test-party.ts:47`). Vary each
  independently; the prior pass reports that flipping the owner to `storage`/`core` alone
  changed nothing.

Phase 3 — decide where the fix belongs, and say so plainly

- If inbound-only peers genuinely never enter the ring, that is a **product** claim about
  a real deployment shape, not a test artifact: a party's owner is exactly the node
  everyone else dials into. State whether a real deployment is saved by something the
  tests lack (longer uptime, the periodic stabilization walk, `reconcileControlCohort`
  producing outbound connections in both directions). If it is not saved, this becomes an
  optimystic/FRET ticket and should be filed as such — do not try to fix it inside the
  Sereus harness.
- If it is convergence latency only, close this out with the measured number and let the
  sibling ticket carry the harness work.

## Edge cases & interactions

- **Two `Libp2pKeyPeerNetwork` instances per node.** Documented in
  `forced-cluster.ts:16-35`: one attached by `createLibp2pNode`, one created fresh by the
  quereus-plugin collection factory and cached with the `NetworkTransactor`. Any probe
  that reads only one of them measures half the system.
- **The coordinator cache.** `Libp2pKeyPeerNetwork.recordCoordinator` caches per key for
  30 minutes; a probe that re-reads after a cohort warms may still see the cold answer.
- **`allowClusterDownsize` defaults to true**, which is *why* a self-only cohort commits
  silently instead of failing. Any measurement that shows writes succeeding is not
  evidence that a cohort formed.
- **Vitest worker isolation.** Prototype patches (and any probe that installs one) are
  per-file; a probe in one scenario says nothing about another.

## Related

- `debt-harness-control-cohort-observable-and-forced` — the harness half; depends on this
  ticket's answer for one decision only (whether forcing is permanent or a stopgap).
- `debt-control-write-unanimity-at-three-nodes` (in `plan/`) — the production-side
  fragility a real cohort would expose.
- `debt-harness-supermajority-threshold-diverges-from-production` — aligned the harness
  approval threshold with production; inert while cohorts are self-only.
