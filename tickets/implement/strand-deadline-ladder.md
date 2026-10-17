description: Write down, in one table in the consistency doc, every time limit a strand's reads and writes run under across Sereus, Optimystic, FRET and libp2p, and say for each whether it follows the link speed Sereus declares or is a fixed number, so the next person changing one can see what it sits above and below.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: docs/cadre-consistency.md ("Deadlines Over Optimystic's Reads and Commits"), docs/architecture.md ("Dial budgets are counted in round trips, not milliseconds" → "Known limits at the supported round trip" ~2007), packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR` ~675), packages/quereus-plugin-sereus/src/cluster-size.ts (`COHORT_READ_DEADLINE_MS`, `STRAND_CLUSTER_POLICY`), ../optimystic/packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines` ~253, the round-trip counts above it), ../optimystic/packages/db-core/src/cluster/structs.ts (`readRepairWindowMs` ~404, the commit-broadcast retry fields ~355-365), ../optimystic/packages/db-core/src/utility/batch-coordinator.ts (`processBatches` ~111-164), ../optimystic/packages/db-core/src/transactor/network-transactor.ts (`get:retry` ~275-310), ../optimystic/packages/db-p2p/src/inbound-authorization.ts (~74), ../optimystic/packages/db-p2p/src/cohort-topic/threshold-crypto.ts (~43), ../Fret/packages/fret/src/service/fret-service.ts (~475-533), ../Fret/packages/fret/src/rpc/protocols.ts (~27)
----

# The deadline ladder under a strand's reads and writes

Doc-only. GitHub gotchoices/sereus#48 showed that on a slow link the limits that fire are not cadre's: they are Optimystic's, FRET's and libp2p's, and some follow the declared link (`NetworkConfig.linkRoundTripMs`, 3 500 ms by default) while others are fixed. `docs/cadre-consistency.md` → "Deadlines Over Optimystic's Reads and Commits" indexes cadre-core's own deadlines today. Extend it with the layers underneath, so one place answers "what is this read or write waiting on, and does it move with the declaration".

The sibling repositories are read-only (`tickets/rules/sibling-repos.md`); read them, do not build them. Values below were read at Optimystic `28e6e044` and FRET `6c04166` (p2p-fret 1.1.0) on 2026-10-16. Confirm each at its site before writing it down; correct the table where the code differs, and state the versions the table was read at.

## What to add

A second table in that section, after cadre's own, titled for the layers below cadre. Columns: deadline, owner (Optimystic / FRET / libp2p), value at the default declaration, follows the declared link (yes, with its round-trip count; or "fixed"; or "option"), what it bounds, where it is defined. Keep it an index: the reasoning stays at each constant, as the section already says of cadre's rows. Rows, grouped by what they bound:

**Opening and keeping a connection**

- libp2p `addressDialTimeout` and `dialTimeout`: 39 000 ms, stated by cadre-core (`optimysticDialLimits`), Optimystic's ten round trips plus two admission decisions.
- Optimystic's request dial: 42 500 ms, stated by cadre-core, eleven round trips plus two decisions.
- libp2p `inboundUpgradeTimeout`: 17 500 ms, Optimystic's five round trips, never below 10 000.
- FRET's redial: Optimystic's derived libp2p dial timeout, passed as `FretConfig.dialTimeoutMs`.
- The connection monitor's ping deadline: 30 000 ms, cadre-core's `DEFAULT_CONNECTION_MONITOR`, fixed by design (it exists for the phone's CPU, not the link; its comment says why).
- The ping handler on the node being pinged: 10 000 ms, `@libp2p/ping`'s default, fixed, no option (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`).

**Keeping the ring (which peers are in a block's cohort)**

- FRET `MAINTENANCE_RPC_TIMEOUT_MS` 2 000, `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` 1 000, `STABILIZE_PHASE_ONE_BUDGET_MS` 3 000, `STABILIZE_TICK_BUDGET_MS` 5 000, `RPC_TIMEOUT_MS` 5 000: all fixed, no option (`blocked/fret-maintenance-deadlines-below-the-declared-link`). Say in one sentence beside the table why this group matters to a write: three missed maintenance pings mark a peer `dead`, and a `dead` peer is in no cohort.

**A read**

- `cohortQueryTimeoutMs`: 7 000 ms, cadre's two round trips (already described above the first table; link to it rather than repeat).
- The reconcile pass bound: `max(5000, 5 × per-peer)`, 35 000 ms.
- The read-repair window `readRepairWindowMs`: 10 000 ms, Optimystic's default, which cadre does not set. Not a deadline but an interval: a read of a held block older than this starts a background consult. Include it, marked as an interval, because on a link whose rounds are longer than it, every read of a held block costs a consult.
- `network-transactor`'s `get:retry`: one extra round, no timer of its own.

**A write**

- Optimystic's request response deadline: three round trips, 10 500 ms (`RESPONSE_ROUND_TRIPS`); the `ClusterClient` round the section above costs at 21 000 ms is this paid twice. Confirm the relation at the site.
- `transactionTimeoutMs` 170 000 ms and `abortOrCancelTimeoutMs` 42 500 ms: already described above the first table; one row each, linking up.
- The batch coordinator's retry: no timer; it retries a failed batch at once, with no backoff, against the next coordinator, until the transaction budget or until every candidate and self are excluded (`No coordinator available (all candidates excluded)`). On a two-member strand that is two attempts. Say so in the row.
- The commit broadcast's scheduled retry (`commitBroadcastRetry*` in `structs.ts`): its defaults, and that they are fixed.
- `pendDeliveryDeferralMs` 2 000: fixed; a hold, not a deadline. One row, marked as such.

**Only with strand reactivity on** (`strandReactivity`, off by default)

- Optimystic's cohort-topic frame read: FRET's `readFramed` at `RPC_TIMEOUT_MS`, 5 000 ms, fixed.
- `DEFAULT_SIGN_COLLECT_TIMEOUT_MS` 5 000: fixed.

**Not on the link in cadre**

- `DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS` 5 000: bounds an asynchronous authorization predicate; both of cadre's are synchronous (`CadreNode.authorizeInboundControlStream`, `StrandRevocationEnforcer.authorizeStream`). Already an option (`NodeOptions.authorizeInboundStreamTimeoutMs`). One row.

After the table, one sentence pointing to `strand-workload-on-a-phone-link.integration.ts` as the scenario that measured which of these fire on a phone-shaped link, with its numbers in its doc comment (do not copy them here).

In `docs/architecture.md` → "Known limits at the supported round trip", add one bullet: FRET's maintenance deadlines are fixed below the supported round trip, linking `blocked/fret-maintenance-deadlines-below-the-declared-link` and the new table. One claim, one reason, per the list rule in `AGENTS.md`.

## Edge cases & interactions

- **The section's own rule** says the rows marked "cuts off" in cadre's table are exactly the sites carrying the lint reason `cuts off by design`. The new table is not part of that rule: it lists other projects' constants, which no lint here checks. Say so in the sentence introducing the table, so nobody tries to make the lint cover it. Verified by inspection.
- **Values the code contradicts.** Where a value read here differs from the code, the code wins; note the difference in the handoff. Verified by inspection.
- **History.** Docs describe the system as it is (`AGENTS.md`). No dates of discovery, no before-states; a fixed value that has a ticket names the ticket slug and stops.
- **Duplication.** Rows already described in the section's prose (the cohort read deadline, the transaction and cancel budgets) get one row that links up, not a second description.

## TODO

- Read each site listed above and confirm its value, owner and whether it follows the declaration.
- Add the table and its two framing sentences to `docs/cadre-consistency.md`.
- Add the "Known limits" bullet to `docs/architecture.md`.
