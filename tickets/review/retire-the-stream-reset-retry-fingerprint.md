description: Closed out a fixed bug about a control-database write that used to fail permanently after a brief network hiccup, and added two unit tests so the code that decides "retry this write" cannot silently stop working the same way again.
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, tickets/.pre-existing-known.md
----

# Close-out of `control-write-retry-does-not-absorb-a-transient-stream-reset` — no runtime behavior changed

This was a pure evidence-keeping + regression-proofing ticket. The defect (a failed control-write
attempt's own abort left a `pending` record that attempts 2 and 3 then collided with) was fixed
**upstream**, in `../optimystic` (`complete/1-a-failed-attempt-must-discharge-its-own-pend`). A
five-round verification series on 2026-09-17 confirmed the fix holds; this ticket's job was to
record that evidence and pin the two new error shapes the upstream fix introduced.

## What changed

1. **`packages/cadre-core/test/control-write-retry.spec.ts`** — two new cases in the
   `isRetriableControlWriteFailure` describe block:
   - `'never retries the cancel-discharge aggregate, even though it contains `[block:`'` — pins
     `isUncommittedTransactorAggregate`'s existing doc-comment claim that the discriminator is the
     `Some peers did not complete:` prefix **and** the `[block:` token together, never the token
     alone. The literal (`CANCEL_DISCHARGE_AGGREGATE`) is a reconstruction built from
     `NetworkTransactor.dischargeCancel`'s real formatter (verified by reading
     `../optimystic/packages/db-core/src/transactor/network-transactor.ts` ~1152-1165), not a
     capture — no run has produced one yet.
   - `'never retries a SyncRetryExhaustedError-shaped pending-conflict message'` — pins that a
     `pending conflict` Optimystic's own collection sync has already exhausted 10 retries on is
     correctly declined here (no `[block:` wrapper at all, so no matcher claims it). The literal
     (`SYNC_RETRY_EXHAUSTED_PENDING_CONFLICT`) is a **real captured message** from round 4 of the
     verification series, transcribed before its source log aged out of `tickets/.logs/`.
   - Full file now 33 tests, all green: `yarn workspace @serfab/cadre-core test test/control-write-retry.spec.ts`.

2. **`packages/cadre-core/src/control-write-retry.ts`** — one `NOTE:` tripwire added to the doc
   comment on `CONTROL_WRITE_RETRY_BUDGET_MS`: a failed commit attempt now also pays a cancel
   discharge (bounded by 6 rounds and a 5 s `abortOrCancelTimeoutMs`, confirmed at
   `../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:288`)
   before its error returns. Two failed attempts whose cancels each ran their full budget could
   consume the entire 10 s retry ceiling and cut the three-attempt policy to two. **Not observed** —
   every measured round committed on attempt 3 of 3 — so this is flagged as a condition to watch,
   not a defect. No runtime code changed.

3. **`packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`**
   — the fingerprint table in the header comment: dropped the `cancelError` row and added a
   "CLOSED 2026-09-17" note pointing at `tickets/.pre-existing-known.md` for the evidence.

4. **`tickets/.pre-existing-known.md`** — this file is the authoritative copy of the fingerprint
   table, so it was updated first: same row drop, plus a new Delta block (inserted as the newest
   entry, above the existing 2026-09-17 delta) recording:
   - the five-round series (6/1, 7/0, 7/0, 6/1, 7/0 passed/failed) and that the target case
     ("absorbs an injected transient stream reset") passed all five;
   - the caveat that all five rounds ran while `../optimystic`'s `db-core` had uncommitted
     in-flight edits from that repo's own ticket runner (stale-build guard passed each time, but
     against a working tree, not a committed state);
   - a **new, not-yet-owned** fingerprint: round 4 failed "a control read answers locally while a
     write is stalled" on `A.resolvePeerAddrs(B)` returning `[]`. Attribution is inferred, not
     traced (`sereus:cadre:node` debug was off that round) — two open tickets
     (`blocked/control-write-refused-when-a-rival-write-holds-the-block` and
     `blocked/control-peer-row-refresh-invisible-to-third-node`) are named as candidate owners by
     timing, and this was deliberately **not** filed as a new ticket or routed through
     `tickets/.pre-existing-error.md` since both candidates are already tracked and blocked on
     in-flight upstream work. Rounds 5+ ran with `sereus:cadre:node,sereus:cadre:control-db` debug
     on and did not reproduce it — flagged for whoever meets it next to keep that namespace on
     (the `resolvePeerAddrs:` line it prints names the gate directly).

## Validation run

- `yarn workspace @serfab/cadre-core test test/control-write-retry.spec.ts` — 33 passed, 0 failed.
- `yarn lint` — exit 0, no output.
- `yarn typecheck` — exit 0, including the stale-build-guard-wiring and test-coverage checks.

All three ran clean against a fresh `../optimystic` build — no stale-build guard refusals this
time (the ticket's TODO flagged this as a risk; it did not materialize during this pass).

## What a reviewer should look at

- **The two new literals are constructed, not blindly copied from the ticket text.** The ticket's
  suggested `CANCEL_DISCHARGE_AGGREGATE` literal used a `(no-response)` status token; I built the
  actual literal from the real formatter in `dischargeCancel` instead, which only ever pairs
  `cause=` with `(in-flight)` (same rule already documented at this spec file's
  `TRANSACTOR_AGGREGATE_COMMIT_PHASE` constant). Worth a second look if you want to re-derive it
  independently — the source is `../optimystic/packages/db-core/src/transactor/network-transactor.ts:1152-1165`.
- **The cancel-discharge aggregate case is a reconstruction, unlike the `SyncRetryExhaustedError`
  case, which is a real capture.** Both are declined by the classifier today, and the reconstructed
  one's value is purely defensive (pinning a doc-comment claim against a future edit), not evidence
  of anything currently happening in this repo.
- **No production code path changed.** The only non-test, non-doc edit is the `NOTE:` comment in
  `control-write-retry.ts` — everything else is tests, a header comment, and the ticket ledger.
- **The new `resolvePeerAddrs` fingerprint is explicitly unresolved** — it's recorded as evidence
  with two candidate (already-blocked) owners, not diagnosed. If a reviewer wants to push this
  further, the next useful step is a re-run with `sereus:cadre:node` debug on to catch the gate
  name directly, not more code investigation from here.
