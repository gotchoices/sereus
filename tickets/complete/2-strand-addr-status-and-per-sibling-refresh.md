description: A phone that joined after a party's always-on machines could wait ten minutes before those machines learned where it was, because they re-asked for addresses on one fixed timer per workspace and treated "the other machine failed to answer" the same as "it has nothing". Each machine now asks each newly connected sibling right away, retries siblings that failed within a minute, and the answering side says when it could not answer. Reported as gotchoices/sereus#21 and #22.
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/types.ts (StrandAddrStatus, StrandAddrResponse), packages/cadre-core/src/strand-addr-protocol.ts (addrlessResponse, handleStream, processAddrRequest, collectStrandAddrs, dialOneSibling, siblingAnswer, isStrandAddrResponse), packages/cadre-core/src/delegate-admission.ts (prunePeerStrandKeys, peerIdOfKey), packages/cadre-core/src/cadre-node.ts (STRAND_PEER_ADDR_RETRY_MS, siblingAnswered, strandAddrAskDueAt, resolveSiblingSeed, recordDelegateAnnounces comment, refreshStrandPeerAddrs, strandAddrRefreshTargets, refreshOneStrandPeerAddrs, askSiblingsForStrandAddrs, recordFormationStrandPeers, runReconcileControlCohort NOTE), packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/cadre-core/test/delegate-admission.spec.ts, packages/integration-tests/src/scenarios/{control-stream-authz,push-wake-e2e,strand-addr-seed-convergence,strand-circuit-same-party-e2e,blind-relay-phone-to-phone-e2e}.integration.ts, docs/architecture.md, docs/strands.md
repro: verified
----

# Complete: strand-addr status field and per-sibling refresh scheduling

## What changed

**Wire (`types.ts`, `strand-addr-protocol.ts`).** `StrandAddrResponse` now carries a required `status: 'ok' | 'unavailable' | 'refused'`. Responder mapping: member lookup → `ok` (possibly empty); non-member → `refused`; concurrency cap, unreadable/oversized/timed-out request, or any throw from `processAddrRequest` (e.g. `isMember` failing on a control-DB read) → `unavailable` with `strandId: ''`. The asker validates every reply with `isStrandAddrResponse` (status in the set, `strandId` a string, `multiaddrs` a string array); anything else throws inside the per-target attempt and counts as a failed exchange.

**Asker API.** `collectStrandAddrs` returns `StrandAddrCollection { addrs, outcomes }`. `outcomes` maps each candidate's control peerId to `answered | empty | unavailable | refused | unreachable`. A reply of any status ends `dialOneSibling`'s target loop (all targets reach the same responder). Non-`ok` replies contribute no addresses. `StrandAddrOutcome`/`StrandAddrCollection` are exported from `index.ts`; `StrandAddrStatus` comes through `export * from './types.js'`.

**Refresh pass (`cadre-node.ts`).** `strandPeerAddrRefreshAt` (keyed by strand) is replaced by `strandAddrAskDueAt`, keyed `peerStrandKey(siblingControlPeerId, strandId)` → the epoch ms the sibling is next due; a missing key is due. Each pass:
- no running strand → clear the map, return;
- enumerate connected siblings (`strandAddrRefreshTargets`; skipped with zero connections, `[]` on failure);
- `prunePeerStrandKeys` drops keys whose strand is not running or whose sibling is not in the target set (so a reconnect is asked on the next tick);
- per strand: RPC only due siblings, stamp each from its outcome (`answered`/`empty` → `now + strandAddrRefreshMs ?? 10 min`, otherwise `now + STRAND_PEER_ADDR_RETRY_MS` = 60 s), then merge `unionAddrs(siblingAddrs, bookAddrs)`. The peer book merges on every tick, whether or not anyone is due.
- `resolveSiblingSeed` uses `.addrs` and does not stamp. The relay announce paths ignore outcomes and still record optimistically (reason reworded on `recordDelegateAnnounces`).
- The throttle clear in `recordFormationStrandPeers` is gone; the every-tick book merge covers re-formation.

`pruneStoppedStrandAnnounces` was generalized and renamed to `prunePeerStrandKeys(map, runningStrandIds, livePeerIds?)`, since it now serves both maps.

## Tests (added or changed)

- `strand-addr-protocol.spec.ts`
  - **New:** "replies unavailable, not refused or empty, when the membership lookup throws". This is the #22 reproduction.
  - Existing processAddrRequest/handleStream cases now assert `status`: non-member → `refused`; malformed, oversized, read timeout and cap → `unavailable`; not running → `ok` with an empty list.
  - "skips a throwing sibling…" and "returns [] when no sibling answers" now also assert `outcomes`. The other collect cases read `.addrs`.
- `cadre-node-strand-addr-refresh.spec.ts` (harness gained `unavailable: Set<peerId>`, and `throttleMap` became `askDueMap`)
  - **New:** "asks a sibling that connects after a pass on the next tick". It has two arrangements. After sibling A was asked, B is asked at T0+15 s and A is not. After a book-only pass with no connection (the 1.7.0 widening, and also the first tick after a restart), B is asked at T0+15 s. This is the #21 reproduction.
  - **New:** "retries a sibling that could not answer within STRAND_PEER_ADDR_RETRY_MS, a healthy one only after the full interval". The unavailable sibling is not re-asked at RETRY−1 and is re-asked at RETRY. The healthy sibling waits the full refresh interval.
  - **Reworked:** "re-asks a sibling once its own interval has elapsed, and on the next tick after it reconnects". This is the old throttle test in per-sibling form. **Deviation:** I folded in a disconnect/reconnect arm (pass without the sibling, then reconnect, then the sibling is asked on the next tick). The ticket said to add no tests beyond its list, and this arm is the only coverage for the `livePeerIds` half of `prunePeerStrandKeys`. It lives inside an existing test, not a new one. Cut it if you disagree.
  - **Reworked:** the hibernating-strand test now uses the new keys. The book test now asserts that the book merges on every tick and nothing is stamped.
  - **Deleted:** "leaves the throttle unstamped…" and "re-forming against a running strand refreshes on the next tick…", as the ticket directed.
  - Unchanged but still relevant: "reads no CadrePeer row when the node holds no control connection". Only its comment changed.
- `delegate-admission.spec.ts`: rename only.
- Integration scenarios: moved to `.addrs`. `control-stream-authz` and `push-wake-e2e` now also assert `outcomes.get(peer) === 'refused'`. That assertion depends on the strand-addr protocol not being covered by the per-stream control-DB gate, which I verified by running the scenario.

## Validation run

- `yarn workspace @serfab/cadre-core build`: clean.
- `yarn workspace @serfab/cadre-core test`: 144 files, 2336 passed, 1 skipped. The skip was already there. The log is at `tickets/.logs/strand-addr-status-and-per-sibling-refresh.test.log`.
- `yarn lint`: clean.
- `yarn workspace @serfab/integration-tests typecheck`: clean.
- Ran `control-stream-authz`, `push-wake-e2e`, `strand-addr-seed-convergence` and `strand-circuit-same-party-e2e`: 8/8 passed. `blind-relay-phone-to-phone-e2e` only had a comment changed and was not run.

## Judgment calls and known gaps

- **`sanitizeStrandAddrs` was not reused** for reply validation. It caps the list at 16 and silently drops bad entries. That is right for a cross-party formation result, but here it would truncate a sibling's full list and turn a malformed reply into a partial answer. The reason is written on `isStrandAddrResponse`.
- **Harness `unavailable` makes `getStrandMultiaddrs` throw, not `isMember`.** The refresh harness records asks inside `getStrandMultiaddrs`, because that is where the strandId is known. Both throws reach the same `handleStream` catch and produce `unavailable`. The protocol spec pins the `isMember`-throws path itself.
- **`unavailable` replies carry `strandId: ''`** even when the request was read before the lookup threw. The asker never reads `strandId`.
- **Extra `CadrePeer` read.** The sibling enumeration now runs on every 15 s tick that has a running strand and a control connection, not only when a strand is due. Pruning needs the current target set. I could not find a cheaper way to tell whether anyone is due, because connected non-members never get a key. A `NOTE:` on `strandAddrRefreshTargets` records this, and the `runReconcileControlCohort` NOTE was updated. `control-founding-consult-budget.spec.ts` still passes.
- **Tripwire left in code:** a `NOTE:` at the every-tick book merge in `refreshOneStrandPeerAddrs` (up to 16 `peerStore.merge` calls per strand per tick).
- **Not changed, but worth knowing:** sibling-sourced addresses are still re-merged only when that sibling is asked, every 10 minutes. `peer-addr-book.ts` documents a libp2p bug: merge never refreshes an address's `observed` time, and the restamp workaround only fires once an address has already expired. So a sibling address can still be invisible for up to one refresh interval around its one-hour mark. That was true before this change too. Book entries now get at most a ~15 s gap, because they merge every tick.
- **Follow-up (not done here):** after release, reply on gotchoices/sereus#21 and #22. The maintainer approves the posts. #22's registration half lands in `await-protocol-handler-registration`, which declares this ticket as its prereq, so post once both are released.

## Reviewer focus

- Is the prune-then-ask ordering in `refreshStrandPeerAddrs` race-free against a strand that starts during the enumeration await? Such a strand is not in `running`, so its keys (none yet) are pruned and it is asked on the next tick.
- Does the outcome → interval mapping match intent? In particular, `empty` waits the full interval. The ticket settled this: an empty `ok` is a normal steady state.
- The docs changes are in the Strand-Address Resolution section of `docs/architecture.md` (the request/response, client-union, kept-warm and cross-party bullets, plus one line in the Strand Networks paragraph) and in the within-party answer in `docs/strands.md`.


## Review findings

I read the diff for `ticket(implement): strand-addr-status-and-per-sibling-refresh` before the handoff, then ran build, lint, the full cadre-core suite and the integration typecheck.

**Checked, no problem found**
- **Reviewer focus, the race.** A strand that starts during the sibling enumeration is not in `running`, so it has no keys to prune and is asked on the next tick. A strand that stops mid-pass leaves keys that the next pass prunes. `reconcileControlCohort`'s single-flight guard means two refresh passes never overlap, so two passes cannot double-ask one due sibling.
- **Reviewer focus, the interval mapping.** `answered` and `empty` wait the full interval. `unavailable`, `refused` and `unreachable` wait the retry. This matches the ticket's settled intent.
- **Responder mapping.** A throw from `getStrandMultiaddrs` (after the delegate grant was recorded) and a throw from `isMember` both end at the `handleStream` catch as `unavailable`. That is correct: the grant stands, and the asker simply retries sooner.
- **Asker validation.** The `readFrame<unknown>` result is narrowed through `isStrandAddrResponse` before use. There is no unchecked cast.
- **Enumeration failure.** A failed enumeration prunes every key, which costs at most one extra round of asks.
- **Per-tick book merge.** `mergePeerAddrs` is a `peerStore.merge` plus a restamp only when an address has expired. The implementer's `NOTE:` at that site is the right place for the conditional cost.
- **Implementer's deviation.** The implementer folded a disconnect/reconnect arm into an existing test. I kept it: it is the only coverage of the `livePeerIds` half of `prunePeerStrandKeys`.

**Found and fixed in this pass**
- **Retry slower than refresh (minor defect).** With `network.controlCohort.strandAddrRefreshMs` set below 60 s, a sibling that failed waited the fixed 60 s retry, while a healthy one was re-asked sooner. `askSiblingsForStrandAddrs` now uses `min(refreshMs, STRAND_PEER_ADDR_RETRY_MS)` for the retry. I extended the existing override test with an `unavailable` sibling, and that test fails without the fix. The `strandAddrRefreshMs` doc in `types.ts` now says so.
- **Asker-side status mapping had no unit coverage.** Only integration scenarios asserted `refused`, and nothing covered a reply with no status. I added one test to `strand-addr-protocol.spec.ts`. It sends canned `ok`-empty, `unavailable`, `refused`-with-addresses and status-less replies, and checks that each maps to its outcome and that only an `ok` reply contributes addresses. This pins the documented rule that a reply without a valid status is a failed exchange.
- **Stale comment.** `StrandAddrResponse.strandId` said it is empty "when the request was never read". It is actually always empty on an `unavailable` reply, including the case where the lookup threw. Reworded.
- **Stale wording.** Two places still said the ops-relay announce failure "folds to `[]`": `docs/architecture.md` (the relay re-drive paragraph) and the `resolveCohortSeed` doc in `cadre-node.ts`. Both now say it comes back `unreachable`.

**Tripwires.** No new ones. The implementer's two `NOTE:`s (the per-tick `CadrePeer` read on `strandAddrRefreshTargets`, and the per-tick book merge in `refreshOneStrandPeerAddrs`) are correctly placed, and I left them as written. A sibling that permanently refuses (for example, its voucher check never passes) now costs one RPC a minute rather than one every ten minutes. That is bounded and documented in `docs/architecture.md`, so I parked nothing further.

**Tickets filed.** None. `cadre-node.ts` is now 7,872 lines (`wc -l`), and this change added about 70. That size is already tracked by `backlog/debt-cadre-node-single-file-size`.

**Docs.** I read `docs/architecture.md` (the Strand Networks and Strand-Address Resolution sections, and the relay re-drive paragraph) and `docs/strands.md`. They now reflect the per-sibling schedule and the status field. I found no other doc that describes the old per-strand throttle.

**Validation (review pass).** `yarn workspace @serfab/cadre-core build` and `yarn lint` are clean. `yarn workspace @serfab/cadre-core test`: 144 files, 2,337 passed, 1 skipped (the skip was already there). `yarn workspace @serfab/integration-tests typecheck` is clean. I did not re-run the integration scenarios: my source change touches only the retry clamp, which they do not exercise.

**Still open (not work for this repo's pipeline).** After release, reply on gotchoices/sereus#21 and #22 (the maintainer approves the posts). For #22, wait until `await-protocol-handler-registration` has also shipped.
