description: A control write that met a brief network hiccup used to fail permanently. The networking library fixed that, and five test runs today confirm the write now recovers on its own. Record the closure, and add unit tests so the classifier that decides "retry this one" cannot quietly stop working.
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, tickets/.pre-existing-known.md
difficulty: easy
----

# Close out the transient-stream-reset fingerprint, and pin the two error shapes the upstream fix added

This is the close-out of `fix/control-write-retry-does-not-absorb-a-transient-stream-reset`. **No runtime behavior needs to change** — the defect was upstream, the upstream fix landed, and the verification series confirms it. What is left is evidence-keeping plus two unit tests that make the classifier's silence about a new class of error message an explicit claim instead of an accident.

## What the verification series measured (2026-09-17)

The ticket's unblock condition was five isolated runs of `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`. Five completed on 2026-09-17 — two during the review of `control-write-hears-zero-approvals-from-healthy-trio`, three during this fix pass:

| round | result | the case this ticket is about | the red, if any |
| --- | --- | --- | --- |
| 1 (sibling review) | 6 passed / 1 failed | passed, committed on attempt 3/3 | `pending conflict`, no reset before it → `blocked/control-write-refused-when-a-rival-write-holds-the-block` |
| 2 (sibling review) | 7 passed | passed | — |
| 3 | 7 passed | passed, 1550 ms, committed on attempt 3/3 | — |
| 4 | 6 passed / 1 failed | passed, committed on attempt 3/3 | `resolvePeerAddrs(B)` returned no addresses — see "A fingerprint that is new to this file" |
| 5 | 7 passed | passed | — |

**This ticket's fingerprint did not appear in any of the five.** It was a `pending conflict` that followed a stream reset whose error carried `cancelError`, together with a `failed non-transiently on attempt 1/3, not retried here` line. No round shows `cancelError`, and none shows `not retried here` on the reset case. In every round the case "absorbs an injected transient stream reset" passed, with the funnel logging one or two `failed transiently` decisions and then `committed on attempt 3/3`.

Logs for rounds 3, 4 and 5 are `tickets/.logs/control-write-retry-absorb.probe-r1.log`, `-r2.log` and `-r3.log` respectively — the file names count this fix pass's own rounds, not the series. That directory is pruned on age and run count, so every literal worth keeping is transcribed below rather than cited.

**Caveat, stated plainly.** All five rounds ran while `../optimystic` had uncommitted in-flight edits to `db-core` (`collection.ts`, `tracker.ts`, `cache-source.ts`, `transactor-source.ts`, plus a new `block-floors.ts`) from that repo's own ticket runner, working `refreshed-collection-caches-a-block-older-than-its-log-entry`. The stale-build guard passed each time, so each round ran against a build that matched that working tree — but that tree is not `../optimystic`'s committed state. Two further attempts, one before round 3 and one after round 5, were refused outright by that guard because the sibling had edited its sources again without rebuilding; neither was forced, and no sibling rebuild was run. The conclusion still holds: the absorbed-reset path is not touched by those edits, and the case passed identically across all five rounds.

## Why nothing in this repo needs to change

The upstream fix is optimystic `complete/1-a-failed-attempt-must-discharge-its-own-pend`. A commit attempt that dies on a transport fault now cancels the pending record it created, with a retried and checked cancel (`NetworkTransactor.dischargeCancel`, bounded by six rounds and `abortOrCancelTimeoutMs`). When that cancel itself fails, `TransactorSource.transact` attaches the cancel's own error to the error it rethrows, as a `cancelError` property.

That adds two error shapes this repo can now see. Both are correctly declined by `isRetriableControlWriteFailure` today, and that was **measured**, not assumed — by importing the built classifier (`packages/cadre-core/dist/control-write-retry.js`) and calling it directly:

| shape | classifier answer | is that right? |
| --- | --- | --- |
| `Cancel of action <id> did not discharge <n> block(s): …; peers: <peer>[block:<id>](no-response) cause=…` | `false` | yes — the conjunction `Some peers did not complete:` **and** `[block:` is what keeps a cancel fault from reading as a retriable pend |
| a bare transport error carrying `cancelError` | `false` | yes — no matcher claims a bare transport message, and a standing pend means a retry could only meet its own record |
| `Some peers did not complete: …[block:…]` carrying `cancelError` | `true` | unreachable, so it does not matter — see below |

The third row is the only one that would be wrong, and it cannot occur. `cancelError` is attached only in `TransactorSource.transact`'s `catch`, which wraps `NetworkTransactor.commit` alone (the pend runs before the `try`). Everything thrown out of `commit` is either the phase-2 aggregate, which formats `[blocks:<count>]` and is vetoed by `reportsIndeterminateCommit`, or a raw error from coordinator resolution. The single-block `[block:` aggregate is built at only two sites, `get` and `pend` (`../optimystic/packages/db-core/src/transactor/network-transactor.ts`, lines 304 and 585), neither of which is on the commit path.

## What to build

**Two spec cases pinning the shapes above.** They belong in `packages/cadre-core/test/control-write-retry.spec.ts`, beside the existing message constants (`TRANSACTOR_AGGREGATE` and friends, around line 65). Both are cheap, need no network, and turn a correct-by-accident answer into a stated rule:

- The cancel-discharge aggregate must be declined **although it contains `[block:`**. `isUncommittedTransactorAggregate`'s doc comment already claims exactly this ("never relax it to 'contains `[block:`'"), citing optimystic `c56c2bd4`, and nothing currently reddens if someone does relax it. Build the literal from `dischargeCancel`'s formatter (`network-transactor.ts` ~1156): `Cancel of action <actionId> did not discharge <n> block(s): <ids>; peers: <peerId>[block:<blockId>](no-response) cause=The stream has been reset; root: The stream has been reset`.
- A `SyncRetryExhaustedError`-shaped message must be declined. This is a **real captured literal** from round 4, and is the surviving copy — the log it came from will be pruned:

  ```
  sync for collection default/cadrecontrol/CadrePeer exhausted 10 retries: pending conflict: block(s) held by unresolved rival action(s) f7cM8wOiFkZ4O_bOrXFVQQ
  ```

  It reaches the funnel with no aggregate wrapper, so no matcher claims it and it is declined — which is the right answer, because optimystic's own `Collection.syncAttempts` already spent ten attempts on it. Say that in the test's comment; the value of the case is that it records *why* declining is correct here, next to the promise-phase `pending conflict` case that is deliberately retried.

**One tripwire comment.** At `CONTROL_WRITE_RETRY_BUDGET_MS` in `packages/cadre-core/src/control-write-retry.ts`, add a `NOTE:` recording that a failed commit attempt now also pays a cancel discharge before its error returns — bounded by six rounds and `abortOrCancelTimeoutMs`, which `../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` sets to 5 s for every collection this repo opens. Two failed attempts whose cancels each run their full budget would consume the whole 10 s budget and cut the three-attempt policy to two. Not observed — every measured round committed on attempt 3 of 3 — so this is a condition to watch, not work to do: if the reset case ever starts failing with `failed after 2/3 attempt(s)`, the cancel discharge is where the time went.

**Retire the fingerprint in both places that list it.**

- `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`, the fingerprint table in the header comment (around line 130): drop the `pending conflict` after a stream reset whose error carries `cancelError` row, and note the class as closed on the 2026-09-17 series the way the file already treats the `0/3 approvals` class — brief, with the evidence, so a future red is filed fresh rather than attributed here.
- `tickets/.pre-existing-known.md`: the same row in the 2026-09-17 Delta's table (line 15). The ledger is the authoritative copy of that table, so change it there first. Add a short Delta recording the five-round series, its caveat, and the new fingerprint below.

**Record the new fingerprint in the ledger** (see next section) with its evidence and its candidate owners. Do not file a ticket for it.

## A fingerprint that is new to this file

Round 4 failed a case no recorded fingerprint covers: `a control read answers locally while a write is stalled`, at `control-write-degraded-cohort-member.integration.ts:862` — `A.resolvePeerAddrs(B)` returned an empty array while `queryPeerRecord(B)` on the same node returned a row. `resolvePeerAddrs` (`packages/cadre-core/src/cadre-node.ts:2473`) returns `[]` from any of five gates, and the run had `sereus:cadre:node` debug off, so **which gate rejected is not recorded**. Freshness is not a candidate: `DEFAULT_PEER_RECORD_MAX_AGE_MS` is 15 minutes and the suite runs about 4.

Two owners already on the board could account for it, and this is an inference from timing, not a trace:

- `blocked/control-write-refused-when-a-rival-write-holds-the-block`. The same round logged B's background `[self-record-update]` failing permanently with the `SyncRetryExhaustedError` message quoted above, about three minutes before the failing read. If B's address-record refresh never landed, A has no fresh signed row to answer from.
- `blocked/control-peer-row-refresh-invisible-to-third-node`. Its traced cause — a node keeps a stale in-memory copy of a row block that another node has since rewritten, and nothing invalidates it until a write touches the block — produces exactly this symptom shape, one node reading another's `CadrePeer` row at a revision that predates its self-publish. The ledger already lists this scenario file under that owner for the boot-gate fingerprint.

Both are blocked on upstream tickets that are in flight in `../optimystic` right now, so the root cause is tracked either way and this was deliberately **not** re-reported through `tickets/.pre-existing-error.md`. Rounds 5 onward ran with `DEBUG='sereus:cadre:node,sereus:cadre:control-db'` and did not reproduce it; anyone who meets it again should keep that namespace on, because the `resolvePeerAddrs:` line it prints names the gate and settles the attribution in one run.

## TODO

- Add the cancel-discharge-aggregate case to `control-write-retry.spec.ts`, asserting it is declined, with a comment saying the conjunction — not the `[block:` token alone — is what declines it.
- Add the `SyncRetryExhaustedError` case, asserting it is declined, with the captured literal above and a comment on why declining is correct (optimystic already retried ten times).
- Add the `NOTE:` tripwire at `CONTROL_WRITE_RETRY_BUDGET_MS` about the cancel discharge now sitting inside every failed attempt.
- Drop the `cancelError` row from the fingerprint table in the scenario file's header and mark the class closed with its evidence.
- Drop the same row from `tickets/.pre-existing-known.md`, and add a Delta recording: the five-round series and its in-flight-sibling caveat, the closure, and the new `resolvePeerAddrs` fingerprint with its two candidate owners.
- Run `yarn workspace @serfab/cadre-core test test/control-write-retry.spec.ts`, plus `yarn lint` and `yarn typecheck`. All three need `../optimystic` built and quiet — the stale-build guard refuses every suite in this repo while that sibling has unbuilt edits, which cost this ticket two of its seven attempted rounds. If the guard refuses, wait rather than rebuilding or forcing the sibling.
- The integration scenario itself needs no change beyond its header comment and does not need re-running for this work; the five-round series above is the evidence.
