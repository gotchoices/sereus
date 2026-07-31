description: Review a new integration test suite that measures how much a slow or unresponsive machine in a group slows down (or blocks) shared-settings changes made on another machine.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/index.ts, docs/architecture.md, tickets/fix/control-reads-blocked-by-stalled-write.md
difficulty: medium
----

# Review: control-write availability with a degraded party member

## What this is

The control database (a party's shared settings + membership list) replicates every block to
the **whole party**, and a write commits only when a super-majority of the block's cohort
approves. At three nodes that bar is `ceil(3 × 0.75) = 3` — unanimity — so a member that is
*connected but degraded* (slow, or silently never answering) sits inside the cohort and counts
against the bar. Nothing measured that before. This work adds the measurement: a six-case
integration scenario plus two harness helpers that make it deterministic, and a docs section
recording the numbers.

**Result in one line:** a degraded member costs latency and availability but not consistency —
a healthy trio writes in ~0.5 s, a 2 s-delayed member turns that into ~55 s, a silent member
turns it into a clean ~20 s failure that rolls back and is not queued for retry, and the next
write commits normally.

## Current state — the suite is green and reproducible

```
cd packages/integration-tests
yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts --reporter=verbose
```

Last two full runs (both after the code below was final; ~180–200 s wall clock each):

| Case | Run A | Run B |
| --- | --- | --- |
| healthy trio (authorize + remove) | ✓ 459 ms | ✓ 1099 ms |
| 2 s-delayed member (authorize / remove) | ✓ 54.6 s / 54.9 s | ✓ 54.6 s / 54.8 s |
| never-answering member (authorize) | ✗ *see below* 40.4 s | ✓ 20.2 s |
| **reads during a stalled write** | **expected-fail** 15.3 s | **expected-fail** 15.3 s |
| recovery after restore | ✓ 906 ms | ✓ 1245 ms |
| failed DELETE not queued | ✓ 20.2 s | ✓ 20.2 s |

Run B is the final state: **5 passed + 1 expected fail, exit 0**. Run A is included on purpose
— it is the run that exposed the nondeterminism described under "Things a reviewer should push
on" and drove the last assertion change.

Also clean: `yarn tsc --noEmit` in `packages/integration-tests`, and `yarn eslint` over both
touched files.

**Prerequisite gotcha:** the run aborts with `Stale build detected` if the linked
`../quereus` workspace has been edited since its last build. Fix is
`cd ../quereus && yarn workspace @quereus/quereus build`. That was needed for this run and is
not a defect in this work.

## The expected failure is a real defect, deliberately left failing

The case `a control read answers locally while a write is stalled` is marked `it.fails` with a
comment naming `tickets/fix/control-reads-blocked-by-stalled-write`. Its assertions are the
real ones — nothing was weakened and nothing was skipped. `it.fails` was chosen over `it.skip`
specifically because vitest **runs the body and fails the suite if it ever passes**, so the day
that fix lands, this turns red and forces whoever landed it to promote the case back to a plain
`it` (the fix ticket's "done means" says so).

The defect: on the writing node, a plain local read (`ControlDatabase.hasOwnerKey()`) does not
answer within 15 s while a stalled write is in flight; it answers only once the write settles.
Already ruled out in the fix ticket: cadre-core's write queue (reads take no lock there) and
the harness's coordinator pin (the same hang predates the pin).

## What the harness helpers do — the part most worth reviewing

Both live in `harness/forced-cluster.ts` and both patch `Libp2pKeyPeerNetwork.prototype`, not
node instances. They replace **discovery and coordinator selection only**; the real cluster
clients, response deadlines, transports, and every peer's real `ClusterMember` stay in place.

- `forceFullCohort(nodes)` — makes `findCluster` return the forced trio. Needed because FRET's
  routing table never warms up inside a test's lifetime, so real discovery returns self-only
  cohorts that never reach the super-majority branch at all. Without it the whole scenario is
  vacuous.
- `pinCoordinator(candidates)` — pins who coordinates a write batch. Two seams, because the
  transactor picks a coordinator two ways: `findCoordinator` (fallback/retry/read) and
  `findCluster` (the primary write seam — `NetworkTransactor.consolidateCoordinators` does
  greedy set cover over per-block `findCluster` results and only calls `findCoordinator` when
  those throw). The pin re-keys the cohort candidates-first without changing membership.

**The two-key-network-instances discovery — flag this for a production decision, not just a
test one.** Every node has *two* `Libp2pKeyPeerNetwork` instances over the same libp2p node:
the node-attached one (`node.keyNetwork`, used for consensus cohort derivation and admission)
and a **fresh default-args one** that the quereus-plugin collection factory builds for the
`NetworkTransactor` — every transactor-level `findCluster`/`findCoordinator` goes through that
second one. This is what made every earlier instance-level patch silently ineffective. The
production question the reviewer should weigh: that fresh instance is built with **default
args**, so it skips both the node's configured `clusterSize` and its network-scoping
`protocolPrefix`. That is a real production concern about the collection factory reusing
`node.keyNetwork`, not merely a test seam.

## Things a reviewer should push on

- **The pin does NOT make the failure latency deterministic, contrary to what the implement
  ticket claimed.** Run A settled the never-answering authorize in 40.4 s reporting `0/3
  approvals`; run B settled the same case in 20.2 s reporting `2/3 approvals`. ~20 s is one
  pend round (two 10 s `ClusterClient` response-deadline attempts against the silent member);
  ~40 s is two rounds. The assertion was therefore relaxed from the literal `2/3` to `\d+/3`,
  keeping the parts that are the actual claim: super-majority failure, cohort of 3, `needed 3`,
  and **0 rejections** (the write failed on silence, not on a no-vote). Judge whether that
  relaxation is right or whether the round count should instead be pinned down.
- **The second round reports 0 approvals *and* 0 rejections even though A and B are healthy.**
  A retried control write appears to hear nothing from the healthy members either. It is benign
  for the assertion (the write must fail either way) and was not chased inside this ticket. It
  is recorded as a `NOTE:` at the assertion site. If a reviewer thinks this is a defect rather
  than a budget artifact, it deserves its own ticket.
- **All timings are single-machine, localhost websockets.** The bounds carry ~2–3× headroom off
  measurement, but they are still wall-clock assertions in an integration suite; the ~10 s
  pieces are fixed timers rather than CPU-bound work, which is what makes that headroom
  plausible on slower hardware. Nobody has run this on CI.
- **`pinCoordinator` depends on an optimystic internal:** greedy set cover keeps the
  first-inserted peer among coverage ties. Documented in the function header. If that tie-break
  ever changes, the pin stops biting — and the failure is loud, not silent: the must-fail cases
  start committing fast, because a write coordinated *by* the degraded node commits (its own
  vote is in-process, its degraded inbound handler is never dialled).
- **The pin is `[A]`, and A is also where reads must go.** `findCoordinator` is the read path's
  routing seam too, and only A holds the control trees' genesis-era blocks (it wrote them solo
  before B and C joined) — pinning to B made every case fail instantly with `Missing block`.
  So the pin choice is load-bearing for reasons unrelated to degradation. Worth a sanity check
  that this does not weaken what the cases claim to measure.
- **Prototype patches are process-wide.** Vitest's per-file worker isolation contains the blast
  radius to one suite; noted in the harness header. A suite that ran strand traffic alongside
  these helpers would be affected.
- **`forced.callCount()` alone does not prove consensus fan-out** — it proves discovery was
  consulted. The cases pair it with `interceptedStreams()` (the degraded node really saw
  inbound streams) and elapsed-time bounds. Check that pairing holds in every case that claims
  anti-vacuity.
- **Tripwire, not a ticket:** an early exploratory run (pre-pin) once showed a write *after* a
  failed write also failing — a failed write possibly poisoning later ones. It has not
  reproduced since; the recovery case commits in ~1 s every run. Parked as a `NOTE:` on the
  recovery case saying where to look if it returns.

## Use cases the suite covers

- Party of three, one member connected and healthy → membership writes commit sub-second.
- One member slow (2 s per inbound cluster RPC) → writes still commit, paying ~55 s. The
  amplification is the point: one control write makes ~27 inbound cluster RPCs and pays the
  delay serially on each, so a small per-RPC latency becomes a large per-write one.
- One member silent → writes fail cleanly with a named super-majority error, roll back locally,
  and are **not** placed in the write-while-alone re-replication queue (asserted for both
  directions — INSERT via `authorizePeer` and stamp-retiring DELETE via `removePeer`; the
  DELETE direction had been missed once before by an earlier review).
- Recovery: once the member is restored, the next write commits normally, so neither the
  coordinator nor the transaction state store is left wedged by the failures.
- Reads during a stalled write → currently blocked; standing reproducer for the open fix.

## Docs

`docs/architecture.md` → "Replication cluster size" gained two bullets: the degraded-member
latency/availability numbers (including the exception — a write coordinated *by* the degraded
node commits fast, so the cost depends on who coordinates), and one bullet pointing at the
reads-blocked-by-stalled-write defect and its ticket.
