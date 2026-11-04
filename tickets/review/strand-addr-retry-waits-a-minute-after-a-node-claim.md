description: After a phone adds an always-on node to its cadre, the phone's shared workspace now connects to that node within seconds instead of about a minute, so saves made right after adding a node no longer land on the phone alone. Review the new retry schedule behind this and its cost.
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/cadre-node.ts (`nextStrandAddrAsk`, `STRAND_PEER_ADDR_FIRST_RETRY_MS`, `strandAddrAskStreak`, `refreshStrandPeerAddrs`, `askSiblingsForStrandAddrs`), packages/cadre-core/src/strand-addr-protocol.ts (comments only), packages/cadre-core/src/types.ts (comment only), packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts, docs/architecture.md, docs/strands.md
repro: verified
----
# Retry the strand-address ask within seconds after a node claim (gotchoices/sereus#56)

A strand is a shared database on its own libp2p node, and a node learns a sibling's strand address by asking over the control network. After a claim the phone's asks failed or came back empty while the node restarted, and the next ask waited a flat 60 s or 10 minutes.

## What changed

`nextStrandAddrAsk` (exported from `cadre-node.ts`, replacing `siblingAnswered`) sets the wait from the ask's outcome and the count of consecutive asks that produced no address, this one included:

| Outcome | Wait | Count |
|---|---|---|
| `answered` | refresh interval (10 min) | back to 0 |
| `empty` | 1 s × 2^(count − 1), up to the refresh interval | +1 |
| `unreachable`, `unavailable`, `unsupported` | 1 s × 2^(count − 1), up to the smaller of 60 s and the refresh interval | +1 |

The count lives in `strandAddrAskStreak`, beside `strandAddrAskDueAt`, and is pruned at the same two sites, so a reconnected sibling or a resumed strand starts at 1 s. `nextReconcileWakeMs` is unchanged: it already wakes a pass for a due time before the backstop. Comments and docs that stated the old schedule are updated, including `docs/strands.md`, which the ticket did not list.

## Measurements

All on 2026-11-03, one machine, Node 24, against the real `cadre-cli` bin.

**The new integration arm** fails on the old build (one run: `Timeout … after 20000ms`, both claim-time asks failed, no further ask inside the window). On the new build it passed 4 of 4 runs.

**The issue's script, one run**, `NODES=1 WAIT_MS=70000`, at the default 2-minute backstop, so the 1 s retry came from the pass's own wake:

- The node's strand started at 5.0 s. The +0 s sample showed 0 connections and cohort 1. Every sample from +10 s to +70 s showed 1 connection, cohort 2, `heldElsewhere true`. The old code stayed at cohort 1 through +50 s.
- The asks failed at 25.585 and 25.852, and the next one, 1.02 s later at 26.876, returned 6 addresses.
- **`commit:solo-cohort` count: 53, against 58 before. This count is a poor measure, because it is mostly the phone founding its databases.** 50 of the 53 fall in the first second, before any node exists. 2 are control-database commits before the first failed ask. 1 is a strand commit after the claim: the +0 s write at 26.377, 0.5 s before the addresses arrived. The drop of 5 equals the five samples from +10 s to +50 s that no longer commit alone; that link is inferred from the counts, not traced line by line.

## Tests

- `nextStrandAddrAsk` table (10 rows, `cadre-node-strand-addr-refresh.spec.ts`): first step for a failure and for `empty`, doubling, `empty` continuing a streak failures began, the 60 s cap for failures, `empty` climbing past 60 s to the refresh cap, a configured refresh shorter than 60 s and shorter than the first step, reset on `answered`.
- "retries a sibling that could not answer on the climbing wait…" (rewritten from the flat 60 s assertion): a failing sibling is asked at 1 s and 2 s further on, while a healthy one waits the full interval.
- "merges the addresses of a sibling that answered empty on the next step…" (new): the trap the ticket names, where an `empty` answer must not cost the full interval. It then checks the return to the refresh interval.
- "starts the climbing wait again after the sibling reconnects or the strand resumes" (new): both prune sites. Nothing else fails if either prune is dropped.
- `node-claim-by-phone.integration.ts` step 3 (new arm): the phone publishes and founds a strand, then polls from before `claimNode` for a strand connection with a 20 s limit.

## Validation run

- `yarn typecheck` and `yarn lint`: pass.
- `@serfab/cadre-core` full suite: 2558 passed, 1 skipped, and one file failed to load (below).
- Integration: all 24 `strand-*` scenario files (69 passed, 8 skipped by their own opt-in environment flags, none added here), `node-claim-by-phone`, `cadre-host-join-by-qr`.

**Not run:** the rest of the integration suite (56 of the 80 files). The `strand-*` files alone took 11 minutes, past the per-command limit. Scenarios that run no strand ask nothing extra, so they should see no change, but that is reasoning, not a run.

**One failure seen, not filed.** In the full suite `test/peer-record-resolution.spec.ts` could not resolve `@optimystic/quereus-plugin-optimystic`: the suite started at 16:47:08 and that package's `dist` was being rewritten at 16:47:09 to 16:47:14 by whoever works in `../optimystic`. Run alone it passes 15 of 15, so it is a sibling rebuild, not a defect, and `.pre-existing-error.md` was not written.

**The stale-build guard now refuses this package's tests.** A final rerun of the refresh spec stopped on `@quereus/quereus: dist is stale`, because `../quereus` has uncommitted source edits in progress. Nothing here depends on that rerun: the last source edit (16:45:10) and build (16:45:19) precede all the runs above. Expect the same refusal until that repo is rebuilt by its owner.

## Things to look at

- **The cost of reconnects is higher than the ticket states.** The ticket says a sibling flapping its connection costs one prompt ask per reconnect, as today. That holds only for a sibling that answers with addresses. A phone always answers `empty` to the node, and the count resets on reconnect, so each new connection pays the early steps again: a connection that lasts 60 s costs 6 asks per (sibling, strand) rather than 1 (counted from the steps, not measured). The `NOTE:` on `nextStrandAddrAsk` names this and the way out. A possible cheaper shape, not built: keep the count across a reconnect for `empty` only. That would slow the case this ticket fixes if a node restart first looks like a flap.
- **The extra asks and passes are unmeasured.** The figures in that `NOTE:` (10 asks in 17 minutes rather than 2; 7 extra passes) are counted from the steps. Nothing here measures battery or pass counts on a phone.
- **The integration arm does not pin the wake.** `buildPhoneOwner` sets a 2 s backstop, so a pass runs regardless and the arm would still pass if the wake were broken. The wake has its own unit coverage in `control-cohort-wake.spec.ts`, and the script run above exercised it at the default backstop, once.
- **`nextStrandAddrAsk` sits in `cadre-node.ts`**, with the constants it uses, though that file is over 10,000 lines. It is exported for the spec and is not in the package index.

## Not in this ticket

The +0 s write above still commits alone, and offline mode does not hold it. That window, and a node with its control port reachable but its strand port firewalled, belong to `plan/offline-mode-holds-writes-for-party-machines-it-cannot-reach`.
