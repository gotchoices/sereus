description: The consistency doc now has one table listing every time limit a strand's reads and writes run under in the layers below Sereus (Optimystic, FRET, libp2p), and whether each follows the declared link speed or is a fixed number; review it against the code it cites.
architecture: docs/cadre-consistency.md#deadlines-below-cadre
files: docs/cadre-consistency.md ("Deadlines Below Cadre", a new subsection at the end of "Deadlines Over Optimystic's Reads and Commits"), docs/architecture.md ("Known limits at the supported round trip", last bullet), tickets/implement/strand-workload-on-a-phone-link-scenario.md (one TODO line appended), ../optimystic/packages/db-p2p/src/rpc-deadline.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/repo/client.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-core/src/utility/batch-coordinator.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../Fret/packages/fret/src/service/fret-service.ts, ../Fret/packages/fret/src/rpc/protocols.ts, ../Fret/packages/fret/src/service/live-member.ts
----

# The deadline ladder under a strand's reads and writes: review handoff

Doc-only. No code, no tests: nothing here has branching logic to pin, and no lint covers other projects' constants (the table says so).

## What changed

- `docs/cadre-consistency.md` gains `### Deadlines Below Cadre` at the end of "Deadlines Over Optimystic's Reads and Commits", after cadre's table and its relationships, so the existing prose about cadre's table stays next to it. One intro paragraph (what the table is, that the "cuts off" lint rule does not reach it, what "follows / fixed / no option / option" mean, where each project's sites live, and the versions it was read at), the table grouped by what each row bounds, and one sentence on why the ring group matters to a write.
- `docs/architecture.md` → "Known limits at the supported round trip": one bullet, FRET's ring-maintenance deadlines fixed below the supported round trip, linking the blocked ticket and the new subsection.
- `tickets/implement/strand-workload-on-a-phone-link-scenario.md`: one TODO line appended (see "Deferred" below).

## Values confirmed at the site

Read at Optimystic 1.15.0 (`28e6e044`) and FRET / p2p-fret 1.1.0 (`6c04166`), both sibling trees clean. Every row in the ticket's list matched the code, except these, where the table follows the code:

- **FRET's redial** is the node's resolved libp2p `dialTimeout` (`resolveLibp2pDialTimeoutMs(options.connectionManager?.dialTimeout, …)` in `libp2p-node-base.ts` ~815, passed at ~1168). cadre states `dialTimeout` itself, so it is 39 000 ms (Optimystic's 35 000 plus cadre's two admission decisions), not Optimystic's bare derivation. The blocked FRET ticket's wording ("from its derived libp2p dial timeout") is loose in the same way. It is not wrong enough to edit there.
- **The 21 000 ms round**: the coordinator's `updateMember` (`cluster-coordinator.ts` ~351) makes `1 + promiseImmediateRetries` attempts (default 1, not settable from a node), each ending at `ClusterClient`'s response deadline of 10 500 ms. So the round is the response deadline paid twice, as the section above says. The row names `updateMember`.
- **Commit broadcast retry**: 250 ms first, doubled each time, interval cap 8 000 ms, at most 5 scheduled attempts, plus 1 immediate retry per member. `resolveClusterPolicy` passes none of these fields, so no node can set them ("fixed, no node option"). At the defaults the 8 000 cap is never reached (the fifth interval is 4 000).
- **Connection monitor**: the ticket said "fixed". A host can replace it with `NetworkConfig.connectionMonitor`, so the row says "fixed by design" (it does not follow the link) and names the option.

## Rows added beyond the ticket's list

- **Stream hedge** (`hedgeDelayMs`, 1.5 round trips, 5 250 ms) and **dead connection** (`deadConnectionDelayMs`, equal to the request dial, 42 500 ms). Both follow the declaration and bound every Optimystic request's stream open (`openProtocolStream`, reached from `libp2p-key-network.ts` ~858).
- In the transaction budget row: **`RepoClient` sets no response deadline** (`repo/client.ts` ~82). A read's or a write phase's request to its coordinator is bounded only by what is left of the transaction budget (170 000 ms). That is the only bound on a coordinator that stops answering, and someone sizing reads on a slow link needs to know it.

Left out on purpose. Each touches a strand only indirectly, and the table is already long. The reviewer may disagree:

- `transferTimeoutMs`: rebalance block pushes, 42 500 ms, follows the request dial.
- `bootstrapContactTimeoutMs`: a self-only cohort lookup waiting for a bootstrap peer, 12 round trips, 42 000 ms.
- `slotHoldWindowMs`: a hold after repeated stale refusals, 3 000 ms, option.
- FRET's `deadAfterFailures` (3): a count, not a time. It appears in the ring sentence.

## Deferred

- **The scenario pointer.** The ticket asked for a sentence pointing to `strand-workload-on-a-phone-link.integration.ts`, but that file does not exist yet; `implement/strand-workload-on-a-phone-link-scenario` creates it. A doc pointing at a missing file breaks the rule that docs describe the system as it is, so I appended a TODO to that ticket to add the sentence when the file lands. Check that the TODO reads clearly and that the scenario ticket's runner has not already picked it up in a state that would miss it.

## What to check

- Each row's value, owner and "follows" verdict against its cited site. The table has 26 data rows in six groups. The highest-risk claims are the ones that are not constants: "no timer of its own" for `get:retry` and the coordinator retry, "two attempts on a two-member strand" for the coordinator retry (it rests on `findCoordinator` throwing `all candidates excluded` once self and the other member are both excluded, `libp2p-key-network.ts` ~1224), and "a `dead` peer is in no cohort" (`isLiveMember` in FRET `live-member.ts`).
- Anchors: `#deadlines-below-cadre` (from architecture.md) and the four `#deadlines-over-optimystics-reads-and-commits` links inside the table.
- That the architecture.md bullet keeps to one claim plus its reason (the `AGENTS.md` list rule).
- Wording: the table is wide (six columns). If it renders poorly, the "defined at" column is the one to shorten.
