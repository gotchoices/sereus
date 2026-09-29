description: When a machine asks another for the newest copy of a block, the database library gives up after 3 seconds even though the connection is already open, because just opening the request's stream takes 3 seconds on the slowest link we support. So on that link every such check fails no matter how long we let the answer take. The library's own ticket asks whether an open connection should be exempt from that limit, and our measurement answers it; somebody needs to carry the answer upstream.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files:
  - ../optimystic/packages/db-p2p/src/network/open-protocol-stream.ts (forwards the caller's dial signal into `newStream` on the connection-reuse path)
  - ../optimystic/packages/db-p2p/src/rpc-deadline.ts (`DEFAULT_DIAL_TIMEOUT_MS`, 3000)
  - ../optimystic/packages/db-p2p/src/sync/client.ts (`SyncClient.requestBlock`, the latest-revision query; applies `withRpcDeadlineDefaults`, and no node option reaches it)
  - ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, which calls `requestBlock` with no deadline options)
  - ../optimystic/tickets/backlog/debt-rpc-dial-deadlines-cannot-open-a-slow-relayed-connection.md (the upstream ticket this answers)
  - packages/quereus-plugin-sereus/src/cluster-size.ts (the measurement, on `COHORT_READ_DEADLINE_MS`)
  - packages/cadre-core/src/link-budget.ts (`cohortReadDeadlineMs`; the module doc's "What still fails")
  - packages/cadre-core/src/strand-first-sync-gate.ts (the first-sync bands taken in the same runs)
difficulty: easy
----
# Human action: carry the open-connection measurement to optimystic's dial-deadline ticket

**Blocked on a dependency outside this repo.** Unblocked when optimystic's `debt-rpc-dial-deadlines-cannot-open-a-slow-relayed-connection` lands with the connection-reuse path covered, or when `@optimystic/db-p2p` gains a node option for its RPC dial deadline. Either way the next step here is a sereus ticket that derives that deadline from `NetworkConfig.linkRoundTripMs` (a stream negotiation is one link round trip, `CIRCUIT_REQUEST_ROUND_TRIPS` minus the request itself), then re-runs the measurement below.

## Why this is a human's call

Sibling repositories are read-only for agents (`tickets/rules/sibling-repos.md`), so the upstream ticket cannot be edited from here. That ticket ends with an open question, "whether an already-open connection should short-circuit the dial deadline (it usually does — the dial budget only bites on a cold dial)", and the measurement below shows the assumption in the parenthesis does not hold. Everything needed to answer it is here; what is missing is somebody to paste it there.

## The finding

Measured 2026-09-29 while deriving the per-peer cohort read deadline from the declared link. One Windows machine, two relay-only cadre nodes on a loopback dedicated relay, 1 500 ms one-way delay raised after formation (the supported 3-second round trip), fresh-join arm of `packages/integration-tests/src/scenarios/strand-reattach-first-sync-measure.integration.ts`, one run at a 5 000 ms per-peer read deadline and one at 7 000 ms, both under `DEBUG=optimystic:db-p2p:coordinator-repo*`.

- Declined reads (`cluster-fetch:peers-silent` followed by `cluster-fetch:no-quorum`): 39 at 5 000 ms, 32 at 7 000 ms. Both joins completed (writable at 70.2 s and 63.6 s).
- On the joiner, consecutive declined reads were 3.00 to 3.02 s apart in both runs, and every one came after the two strand nodes had held an open connection for at least 15 s. A consult that completed would need at least two link round trips, 6 s, so none of these ran to an answer, and neither the 5 000 nor the 7 000 ms deadline ever fired. The time that did fire is 3 000 ms.
- The 3 000 ms is `DEFAULT_DIAL_TIMEOUT_MS` in `rpc-deadline.ts`, applied through `withRpcDeadlineDefaults` by `sync/client.ts` (`SyncClient.requestBlock`, which `clusterLatestCallback` in `libp2p-node-base.ts` calls with no deadline options) to the latest-revision query, which `protocol-client.ts` turns into an abort signal for the dial phase. `open-protocol-stream.ts` forwards that signal into `chosen.newStream([protocol], { signal })` on the connection-reuse path, and libp2p's full multistream-select negotiation inside `newStream` costs one link round trip, 3 s at this delay. The dial deadline therefore bounds the negotiation even when no dial happens.
- No `NodeOptions` field reaches that deadline. `underReplicationDrain.pushDialTimeoutMs` covers pushes only, and `connectionManager.dialTimeout` is replaced by the caller's signal, as the upstream ticket already says.

The join completes anyway because cadre's peer-join backfill pushes the blocks and the first-sync gate probes until the machine holds them. What is lost is read repair itself: on this link a machine never corroborates a block with its cohort, and a read of a block it does not hold waits for a push instead of fetching it.

## Proposed text for the upstream ticket

Append under "To decide", answering the second bullet:

> Measured by sereus on 2026-09-29 (its `strand-reattach-first-sync-measure` scenario, 1 500 ms one-way): an already-open connection does NOT short-circuit the dial deadline. `openProtocolStream` forwards the dial signal into `newStream` on the reuse path, and the full multistream-select negotiation there costs one link round trip, so at a 3 s round trip every `queryClusterForLatest` consult aborts at 3.0 s regardless of `cohortQueryTimeoutMs` (39 declined reads at 5 000 ms, 32 at 7 000 ms, consults 3.00 to 3.02 s apart in both). Either the reuse path should run negotiation under the response deadline rather than the dial one, or the dial deadline should be settable from the same declaration as `connectionManager`; sereus would derive it as one link round trip.

## Alternatives considered

- **Raise `cohortQueryTimeoutMs` further from sereus.** Does nothing: the abort comes from a different deadline that fires earlier.
- **Have sereus pass `negotiateFully: false`.** Not reachable: the cluster client is constructed inside db-p2p, and the option is per call.
- **Work around it in cadre by pre-negotiating streams.** Would duplicate db-p2p's client for one deadline; the fix is one field upstream.

## If we do nothing

Read repair and cohort corroboration stay unavailable at the supported link. Joins still complete through backfill, so nothing visible breaks today; the derived 7 000 ms deadline is correct and waiting, and takes effect the moment the upstream deadline lets a negotiation through.

## Reversibility

Fully: the upstream change is a deadline's scope or a new option, and sereus's side is one derivation in `link-budget.ts`.
