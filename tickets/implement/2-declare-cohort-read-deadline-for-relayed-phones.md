description: When a machine checks with the others in its group before reading, it gives each one a second to answer, which is not enough for two phones talking through a relay on a slow connection — so answers arrive too late to count and the read is refused and retried. Choose a limit that suits a relayed phone, and let hosts change it.
prereq: 1-first-sync-wait-too-tight-on-a-slow-relayed-link
architecture: docs/architecture.md#replication-cluster-size
files:
  - packages/quereus-plugin-sereus/src/cluster-size.ts (CONTROL_CLUSTER_POLICY, STRAND_CLUSTER_POLICY, controlClusterPolicy, strandClusterPolicy)
  - packages/cadre-core/src/types.ts (NetworkConfig, beside connectionMonitor / DEFAULT_CONNECTION_MONITOR)
  - packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions, around line 1669)
  - packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime, around line 690)
  - packages/cadre-core/test/cadre-node-control-node-options.spec.ts (asserts the control policy, including BY IDENTITY)
  - packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts (the same for strands)
  - docs/architecture.md ("CadreNode Configuration" network block; "Replication cluster size")
  - docs/testing.md ("Where measurements live")
  - .release-notes.pending.md
----

# Sereus still runs Optimystic's LAN-speed cohort read deadline

## What this is about

Before serving a read whose local copy may be stale, an Optimystic node asks the block's cohort which revision is newest, and believes an answer only if it arrives inside a per-peer deadline. That deadline was hardcoded at 1000 ms, which is shorter than one round trip between two phones that reach each other only through a relay; at a cohort of two there is exactly one peer to ask, so one late answer leaves the read with nothing to corroborate against and it is declined. Optimystic 1.6.0 made it `clusterPolicy.cohortQueryTimeoutMs` — default unchanged at 1000 ms, the whole reconcile pass derived as `max(5000, 5 x value)`, and a value that is not a finite number above zero, or is above `MAX_COHORT_QUERY_TIMEOUT_MS`, throws at node construction. Sereus declares nothing, so **sereus is still at 1000 ms** on both of its networks.

Reported as Optimystic GitHub #22 by the sereus-based chat app: two relay-only parties, about 1.8 s round trip, the joining phone never finishes and reports `StrandAwaitingFirstSyncError` after 120 s. Upstream fixed the configurability and deliberately left the default alone; choosing sereus's value is this ticket.

## What reproduction showed — read this before choosing a number

The reported failure **does not reproduce as a failure** on sereus at the reported link condition, and the mechanism behind it **does**. Measured 2026-09-26, one Windows developer machine, the reduced blind-relay topology (two relay-only `CadreNode`s, one shared loopback dedicated relay), with the one-way outbound frame delay raised to 900 ms after formation — a round trip of about 1.8 s. A machine that had joined, gone away while the other wrote, and then re-attached:

- completed every step, taking 20-36 s where the same journey on loopback takes about 9 s;
- logged `cluster-fetch:peers-silent { silent: 1, consulted: 2 }` followed by `cluster-fetch:no-quorum` **18 times after the delay was raised** (22 counting the transient window while the departed peer was genuinely absent). That is the reported mechanism exactly: the one peer there is to ask answers outside the 1000 ms deadline and reads as silent, the read is declined, and it is retried about a second later until one lands.

With `cohortQueryTimeoutMs: 5000` declared in both policies, the same journey logged **2** such declines after the raise instead of 18, and `cluster-fetch:local-current` lines appeared — corroboration succeeding rather than being abandoned. Logs: `tickets/.logs/strand-first-sync-fails-over-wan-cohort-deadline.repro-900-debug.log` (default) and the `...repro-900-5000ms.log` beside it, both taken with `DEBUG='optimystic:db-p2p:coordinator-repo*'`. Those are pruned on the usual schedule; the numbers here are the record.

So the change is worth making — it removes the large majority of declined reads on a relayed slow link, and the reporting app's deployment has more collections and slower crypto than this two-table scenario, which is a plausible reading of why the margin that saved us did not save them. It is **not** free, and the cost lands on a path that was already tight: a consult against a peer that cannot answer now costs the full deadline instead of 1 s, and a joining machine's first sync runs several of those. Measured first sync for a machine that holds nothing yet, same link: 23-41 s over four runs at 1000 ms, 35-46 s over three runs at 5000 ms. That is why `1-first-sync-wait-too-tight-on-a-slow-relayed-link` lands first — at 5000 ms against the old 30 s first-sync budget, this change would have turned a slow-but-working join into the very error the report names.

## The value

Recommendation: **5000 ms in both policies**, which is also what Optimystic's own note advises the reporter to set for that link. It covers the reported 1.8 s round trip with room for the Noise handshake, the relay hops and a phone's pure-JS crypto; the derived reconcile-pass bound becomes 25 s. Measure the first-sync band at whatever you land (recipe below) and confirm the sibling ticket's default clears it with margin. If it does not, 3000 ms is the fallback — still 1.7x the reported round trip, and a doomed consult costs 40% less.

One value for both networks, not two. The reason to widen is the link, and a phone's control node and its strand nodes share that link; nothing about control traffic or strand traffic argues for different numbers. Keep the two frozen policy objects separate as they are today, with the same value and one shared explanation.

## The host override

Add it to `NetworkConfig` beside `connectionMonitor`, threaded the way `DEFAULT_CONNECTION_MONITOR` is: one optional field covering both networks, documented in the same places, reaching `clusterPolicy` in `CadreNode.buildControlNodeOptions` and in `StrandInstanceManager.buildStrandRuntime`.

Two constraints on the shape:

- **The no-override path must keep returning the frozen policy object by identity.** `cadre-node-control-node-options.spec.ts` and `strand-instance-manager-cluster-size.spec.ts` both assert `toBe(CONTROL_CLUSTER_POLICY)` / `toBe(STRAND_CLUSTER_POLICY)`. The existing `controlClusterPolicy(enrolledMachines?)` and `strandClusterPolicy(clusterSize, servingMachines?)` builders already have that shape — the frozen constant itself when there is nothing to add, a new frozen object when there is — so one more optional argument on each is the natural route.
- **Do not restate Optimystic's validation.** A host value that is not a finite number above zero, or is above `MAX_COHORT_QUERY_TIMEOUT_MS` (about 4.97 days), throws where the libp2p node is constructed: inside `CadreNode.start()` for the control network, and inside `addStrand` for a strand. Say that in the field's doc so an embedder knows where the throw comes from, and add no second check.

## Do

- Declare the chosen value in `CONTROL_CLUSTER_POLICY` and `STRAND_CLUSTER_POLICY`. At the constants, state the cost in the terms Optimystic's own field doc uses: a peer that is truly gone now holds a read of a missing block for up to that long before the read is declined, instead of 1 s. Record the measured decline counts and the first-sync band that justify the number, with their date and link condition — the existing comments in that file are the house style for this.
- Add the `NetworkConfig` field, thread it to both networks, and document it beside `connectionMonitor`: the field's own doc comment, plus the network block under `docs/architecture.md` → "CadreNode Configuration", which carries a prose copy of each of these settings.
- Extend the two existing policy specs: the declared default arrives on both networks, a host override reaches both, and the no-override path still passes the frozen object by identity. That is the branch with real logic here; nothing else needs a test.
- **No new integration scenario.** The 900 ms journey above passes both before and after the change, so a committed scenario at that delay would gate nothing, and above it a run breaks on something else entirely (`fix/strand-node-never-redials-through-a-relay-at-a-three-second-round-trip`) — there is no delay at which a stable pass/fail gate for this exists. The numbers belong in `docs/testing.md` → "Where measurements live", beside the existing latency sweep, with the recipe below.
- `.release-notes.pending.md`: one line under the 1.6.0 requirement — a read over a slow relayed link is no longer refused because the other machine's answer arrived a fraction of a second late, and a host can tune the limit.

## How to re-measure

There is no committed instrument for this shape, and rebuilding one from scratch each time is the mistake `relay-round-trip-measure.integration.ts` exists to prevent. If you need these numbers again, or a third value compared, add the shape as a new opt-in configuration of that file rather than as a new scenario: it already carries the opt-in gate, the per-link delaying proxy (`harness/counting-proxy.ts`, which models one slow phone against a fast peer), and a documented home for its results. It needs one addition — the delay must be raisable after the strand is formed and first synced, because formation's own 5 s per-step budget is what breaks if the link is slow from the start. Both instruments hold their delay in a closure today, so either `counting-proxy.ts` or `ws-latency.ts` needs a setter; the proxy is the better host, and `backlog/debt-relay-scenarios-never-see-link-latency` owns that fixture's shape.

The shape measured above, for reference. A and B are each one relay-only `CadreNode` on a shared dedicated relay. A founds a closed strand and publishes a bound invitation; B forms, attaches and reads a row; `B.stopStrand(strandId)`; A writes a second row — its first attempts are refused while A's cohort view still counts B, so retry for a few seconds; raise the one-way delay to 900 ms; `B.addStrand(...)` again against the same raw-storage capture (`harness/block-store-probe.ts`'s `captureRawStorage`, so B re-attaches over its own stale store rather than an empty one), wait for the strand connection, then `whenStrandWritable` and read the row written while it was away.
