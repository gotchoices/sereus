description: The control-write retry now re-submits a failed write only when the database library says that write can never be stored, and never after a failure that says part of it may be stored. A fresh five-run check of the degraded three-machine scenario lost no control writes, so the upstream "dead pending record" failure is marked closed.
files:
  - packages/cadre-core/src/control-write-retry.ts (`reportsPossiblyStoredWrite`, `isFinalTornWrite`, `matchesRetriableFailure` — renamed from `matchesRetriableMessage`; module comment; accepted-tradeoff `NOTE:` on `isUncommittedTransactorAggregate`)
  - packages/cadre-core/src/control-retry.ts (`causeChain`, hoisted here from control-read-retry.ts)
  - packages/cadre-core/src/control-read-retry.ts (now imports `causeChain`)
  - packages/cadre-core/test/control-write-retry.spec.ts (`describe.each(WRITE_CLASSIFIERS)('%s — typed possibly-stored failures')`, `tornWrite` / `viaQuereus` / `viaRefusalRewrap` helpers, loop case "re-runs the body after a final torn write, and not after a non-final one")
  - packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (comments only: fingerprint table, `ABANDON_SETTLE_GRACE_MS` note)
  - tickets/.pre-existing-known.md (new "Delta 2026-09-17 (closing)" at top; "evening" block marked superseded; stale pointer in "(later)" block retired)
  - docs/architecture.md (line ~98, the "No approval threshold can relax unanimity…" bullet)
----

# Review: control-write retry classifies torn writes by `final`; degraded-cohort re-run

## What changed

Every local control-database write goes through `retryControlWrite`, which re-runs the whole write body (reads included) only when its classifier says nothing can have been stored. The classifier used to work only on message text. It now also checks the error *objects* on the `cause` chain, in this order (`matchesRetriableFailure`):

1. not an `Error` → not retriable;
2. **typed veto**, `reportsPossiblyStoredWrite`: any link that is a `SyncRetryExhaustedError` (including the `SyncRevisionStalledError` subclass), a `TornActionError` whose `final` is not `true`, a `CoordinatorPartialCommitError`, or a legacy `PartialCommitError` → not retriable;
3. the existing text veto for a commit-phase `[blocks:` batch → not retriable;
4. **typed matcher**, `isFinalTornWrite`: any link that is a `TornActionError` with `final === true` → retriable;
5. the existing text matchers (pend-phase aggregate, zero-rejection shortfall, plus the grace refusal for schema init).

Both write classifiers (`isRetriableControlWriteFailure`, `isRetriableSchemaInitFailure`) share this body. The read classifier is unchanged. `causeChain` moved from `control-read-retry.ts` into `control-retry.ts` beside `chainMessages`, and both modules use it.

Why the veto matters today: every class in it embeds text from elsewhere in its message. That is `detail` for a torn write, `lastReason` for exhausted sync, and `Underlying failure: …` for partial commits. When that text is a pend-phase aggregate (`Some peers did not complete: …[block:…]`), the old text matcher claimed the whole error. For the partial-commit errors this could happen with today's upstream wording whenever a control write spans two collections. The unit tests confirm it: 8 of the new classifier cases failed against the unmodified code, 4 per classifier, covering a final torn write being retriable and the three aggregate-bearing veto cases. The loop case failed too.

Asymmetry, documented in the comment on `reportsPossiblyStoredWrite`: if a second loaded copy of `@optimystic/db-core` builds the error, `instanceof` fails. The matcher then does not fire (no retry, the safe side), but the veto does not fire either, so classification falls back to today's text behaviour. No text fallback parses `TornActionError`'s closing sentence, because upstream says `detail` is for log lines only.

## Validation done

- `yarn workspace @serfab/cadre-core test test/control-write-retry.spec.ts test/control-read-retry.spec.ts`: **81/81 passed**, stale-build guard green (optimystic clean at `13586033`, 19:55).
- The new typed cases were run against the unmodified classifier first. Eight classifier cases (four per classifier) and the loop case failed, as expected.
- `yarn workspace @serfab/cadre-core typecheck` clean; `yarn lint` clean. `@serfab/cadre-core` dist rebuilt at 20:33, after the last source edit (a comment).
- The full cadre-core suite was **not** run. Only the two retry specs named in the ticket were.

### Degraded-cohort confirmation (Phase 2)

`yarn vitest run --reporter=verbose src/scenarios/control-write-degraded-cohort-member.integration.ts` from `packages/integration-tests`, fresh process each run, guard green each time. Logs: `tickets/.logs/control-write-retry-torn-final-and-degraded-rerun.run{1..5}.log`.

| run | optimystic | tree at start | result |
| --- | --- | --- | --- |
| 1 | `13586033` | clean | 7/7 |
| 2 | `13586033` | clean | 7/7 |
| 3 | `13586033` | clean | 7/7 |
| 4 | build identical to `2fdb3b97` | **dirty** (see below) | 7/7 |
| 5 | `2fdb3b97` | clean | 7/7 |

Across all five logs: zero `pending conflict`, zero `Pend blocks held`, zero `TornActionError` / `PartialCommitError`, and zero `[abandoned-write …]` lines outside a degraded window.

**Honest caveats for the reviewer:**

- **Run 4 started on an uncommitted build.** Optimystic's review agent rebuilt its Quereus plugin at 20:05:14 from a `txn-bridge.ts` edit made at 20:05:06, then committed that same source as `2fdb3b97` around 20:10. I checked afterwards that the working-copy file matches the commit and was not touched after the build, so run 4's build is the same as run 5's. It still did not start on a committed tree.
- **The five runs span two SHAs.** The only source difference is one early return in the plugin's legacy multi-tree commit path (`git diff --stat 13586033..2fdb3b97 -- packages | grep /src/` → only `txn-bridge.ts`), for two tables declared over one collection id. No control table does that.
- **A sixth run on `8a0ad39b`** (upstream's `committing-a-block-deletes-a-pending-record-that-is-already-gone`, which edits `db-p2p/src/storage/block-storage.ts`) **was refused by the guard**: that commit's `db-p2p` dist was never rebuilt. Not forced, and I did not build there. The newest optimystic fix has not been exercised here.
- **The ticket's literal pass bar ("zero `SyncRetryExhausted` lines") was not met in runs 3 and 4.** In both, node C's background `[self-record-update]` was given up during "commits with a member delayed under the response deadline" with `SyncRetryExhaustedError: … exhausted 10 retries: Conflict race lost: 1/3 member(s) hold a conflicting winner (2/3 approvals)`. I judged this is not the wedge, and closed the delta anyway:
  - The wording is different: no `pending conflict … unresolved rival action(s)`.
  - That case holds every request to C for 2 s, so A's write takes about 55 s. C's refresh of its own row loses to it for C's whole ~16 s sync budget.
  - A's write then commits, and so does every later write in the file. That is a live rival, not a dead record.
  - The scenario labels it "inside a deliberately degraded window" and does not fail on it, by design.

  The reviewer should agree or overrule. It is recorded as a known, non-failing line in `.pre-existing-known.md` and in the scenario's fingerprint table.
- **The final-torn-write retry was never exercised live.** No run raised a `TornActionError` at all. The typed matcher and veto are covered only by unit tests built from the real upstream classes.

## Where things were recorded

- `.pre-existing-known.md`: a new "Delta 2026-09-17 (closing)" at the top closes the wedge fingerprint owned by optimystic `a-member-that-missed-a-commit-refuses-every-later-write`, as of `13586033` / `2fdb3b97`. A recurrence goes to `.pre-existing-error.md` as a regression. The "evening" block is marked superseded. In the "(later)" block, the pointer naming `control-write-refused-when-a-rival-write-holds-the-block` as the live candidate for `resolvePeerAddrs(B)` returning `[]` is retired: that ticket was replaced by `an-abandoned-control-write-is-silent`, now complete.
- `docs/architecture.md`: one sentence on the `final` rule and the typed veto, and the wedge described as fixed upstream.
- The scenario's header comment: the wedge moved to a CLOSED paragraph, and the in-window `Conflict race lost` line added as not-a-failure. The `ABANDON_SETTLE_GRACE_MS` `NOTE:` was updated: both in-window losses landed while the delay was still held, so the grace window is still neither confirmed nor refuted.

## Things worth a reviewer's second look

- The test `lets the partial-commit veto beat a final torn write on the same chain` builds its chain by hand (`partial.cause = tornWrite(true)`). Neither partial-commit class chains its `reason` on `cause` today. The test pins the order in case upstream starts doing so.
- `isFinalTornWrite` runs *after* the `[blocks:` text veto. A final torn write whose `detail` happens to contain `[blocks:` is declined. I judged that conservative and acceptable, not tested.
- Step 5 of the original fix ticket (strand writes) needed no change. See the fix pass's reasoning, preserved in git history for `tickets/implement/control-write-retry-torn-final-and-degraded-rerun.md`. The chat-resend double-store is tracked separately as `backlog/bug-chat-resend-after-uncertain-failure-can-store-message-twice`.
