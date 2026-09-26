description: Two phones that reach each other only through a relay cannot re-open a shared strand when the round trip is slow (about 1.8 s): the phone gives up after two minutes saying it never received the strand's data. Optimystic 1.6.0 made the relevant wait configurable; Sereus has to choose a value that works for relayed phones and let hosts change it.
files:
  - packages/quereus-plugin-sereus/src/cluster-size.ts (CONTROL_CLUSTER_POLICY, STRAND_CLUSTER_POLICY, controlClusterPolicy, strandClusterPolicy)
  - packages/cadre-core/src/types.ts (NetworkConfig, next to DEFAULT_CONNECTION_MONITOR)
  - packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts (where the cluster policy reaches the node)
  - packages/integration-tests/src/harness/ws-latency.ts (latency injection, from complete/latency-injection-fixture-for-relay-scenarios)
  - docs (wherever DEFAULT_CONNECTION_MONITOR is documented)
----

# Relayed phones on a slow link cannot finish a strand's first sync

## Report

optimystic GitHub #22 (kjeib, reporting from the sereus-based chat app):
- Two parties reachable only through a circuit relay (`listenAddrs: []`, `relayAddrs` only): the phone shape.
- The strand is founded and joined. B detaches, A writes, the one-way link delay is raised, and B re-attaches and reads.
- At 1 ms one-way, B re-attaches in 5–10 s. At 900 ms one-way (about 1.8 s round trip), B gets `StrandAwaitingFirstSyncError … (waited 120005 ms)`. 2 of 2 runs each way.
- Cause: optimystic gave each cohort peer a fixed 1000 ms to answer a read consult. At cohort size 2 there is one peer to ask, so one slow answer declines the read.
- Their reproduction script: `test/stack/small-cohort-repro.sh` in github.com/gotchoices/chat.

## What optimystic 1.6.0 changed

`clusterPolicy.cohortQueryTimeoutMs`, on `ClusterConsensusConfig` (see `../optimystic/tickets/complete/1-cohort-read-deadlines-are-fixed-at-lan-speeds.md` and `packages/db-p2p/docs/cluster.md`):
- Default 1000 ms, which is the old behaviour.
- It sets the per-peer deadline on the read path.
- The whole reconcile pass is derived from it as `max(5000, 5 × value)`.
- A value that is not a finite number above zero, or is above `MAX_COHORT_QUERY_TIMEOUT_MS`, throws at construction.

The default did not change, so **sereus is still at 1000 ms** until it declares something.

## Do

1. **Reproduce first.** Add an integration scenario that follows the report's steps. Use two relay-only parties, and raise the one-way delay with `ws-latency.ts` after formation, because injecting it from the start breaks the 5 s formation dial budget. It must fail at 900 ms one-way with today's settings and pass at 1 ms.
2. **Choose sereus's default.** Declare `cohortQueryTimeoutMs` in both `CONTROL_CLUSTER_POLICY` and `STRAND_CLUSTER_POLICY`, the same way the ping settings were chosen for #13: a value that tolerates a relayed phone on a slow mobile link.
   - **Starting point: 5000 ms.** That covers the reported 1.8 s round trip with room for Hermes crypto and relay hops. The derived pass bound becomes 25 s.
   - **State the cost at the constant:** a peer that is truly gone now costs a read of a missing block up to that long before the read is declined, instead of 1 s.
   - Measure where the scenario starts passing, and pick a value with margin above it. Record the measurement in the comment.
3. **Let hosts override it** through `NetworkConfig`, beside `connectionMonitor`, the way `DEFAULT_CONNECTION_MONITOR` is threaded, with the same documentation.
   - Keep the control and strand values separate if they need to differ; otherwise one field.
   - Don't restate optimystic's validation; let its construction-time throw surface.
4. The scenario from step 1 must pass at 900 ms one-way with the new default.
5. **Docs:** add the setting next to the connection-monitor documentation, and add a line to `.release-notes.pending.md` under the 1.6.0 requirement.

Don't edit `../optimystic` (`tickets/rules/sibling-repos.md`). If step 1 shows sereus's own timeouts fail first (strand first-sync wait, formation dial budget), record which one and fix it in this ticket only if the fix is a clear constant change. Otherwise file it separately.
