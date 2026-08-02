description: When two people redeem the same invitation at the same instant on one machine, the one who loses was told "conflict, try again" rather than "this invitation is used up" — fixed, reviewed, and now covered by tests that race the real production path.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, docs/architecture.md, docs/STATUS.md
----

# Same-node invitation race now reports exhaustion instead of a retryable conflict

## What changed

`ControlDatabase.withUseNumberRetry` (`packages/cadre-core/src/control-database.ts`) used to check
whether a redemption's use number was inside the invite's seat budget (`assertSeatRemains`) only on
RETRIES (`attempt > 1`). Two redemptions of a single-use invite racing on the SAME node never retry
— they serialize behind the local write queue, so the loser's very first attempt already reads a
use number past budget, skipped the guard, and fell through to a generic
`CHECK constraint failed: Authorized`, which `StrandFormationManager.provisionAsResponder`'s
catch-all reports as `'Formation conflict, retry'` — wrong, since retrying a spent invite can never
succeed.

`assertSeatRemains` now runs on EVERY attempt, so a same-node race raises the named
`InvitationExhaustedError` → `'Invalid token'`, the same answer a cross-node race and a plain
latecomer already got.

To keep the common (non-racing) redemption off an extra `FormationInvite` read, the invite's
`TotalUses` is threaded down from callers that already hold it:

- `redeemInvitation` / `recordFormationUsage` gained an optional `totalUses?: number | null`,
  passed to `withUseNumberRetry` → `assertSeatRemains`. `undefined` (direct test callers, the
  `integration-tests` harness) falls back to a fresh `queryFormationInvite`, as before.
- `ControlFormationUsageRecorder.recordUsage` / `provisionAndRecord` both already read the invite
  (for `validationUrl`), so both pass `totalUses: invite?.totalUses ?? null` — no extra read on the
  production path.

Doc comments updated to match in `control-database.ts`, `control-formation-recorder.ts`, and
`strand-formation-manager.ts` (comment-only there; its `InvitationExhaustedError` →
`INVALID_TOKEN_REASON` mapping was already correct and is pinned by
`strand-formation-consent.spec.ts` case `(p)`).

## Review findings

**Diff read first, from the implement commit `5cc900e`, before the handoff summary.**

### Correctness — checked, nothing found

- The new guard's condition (`useNumber > totalUses`) is byte-for-byte the complement of the
  schema's own `FormationUsage.Authorized` clause (`FI.TotalUses is null or FI.TotalUses >=
  new.UseNumber`, `control-schema.ts:546`), so the check can only rename a refusal the database
  would have made anyway — it cannot manufacture one. A missing/invisible invite row yields
  `null` and defers to the CHECK exactly as before.
- `InvitationExhaustedError`'s message matches neither `LOST_USE_NUMBER_PATTERNS` entry, so a
  first-attempt exhaustion propagates immediately instead of burning all three attempts.
- `assertSeatRemains`'s fallback read (`queryFormationInvite`) takes no write lock, so promoting it
  from the rare retry path to every attempt cannot deadlock against the non-re-entrant
  `withWriteLock`.
- Only one caller outside `cadre-core/src` reaches these methods
  (`packages/integration-tests/src/harness/test-network.ts:218`); it omits `totalUses` and gets the
  read-based fallback.

### Test coverage — one real gap, fixed in this pass

The implement pass changed an existing case to assert `InvitationExhaustedError`, but every
exhaustion case in the suite calls `ControlDatabase` **directly**, i.e. omits `totalUses` and
exercises the fallback read. The threading through `ControlFormationUsageRecorder` — the entire
production path, and the only part of the change that was new API surface — had **no** coverage: a
recorder passing the wrong budget (or `null`) would have left the whole suite green while silently
restoring the old generic-conflict behaviour.

Added two cases to `control-formation-use-number-retry.spec.ts` → `concurrent redemptions on one
node`, both racing the RECORDER:

- `reports the loser of a record-only race as exhausted, on the budget the recorder passed down`
  (bound invite → `recordUsage` → `recordFormationUsage`);
- `reports the loser of an unbound provision race as exhausted, seating exactly one strand`
  (unbound invite → `provisionAndRecord` → `redeemInvitation`, also asserting the winner's strand
  is seated and the loser leaves no orphan use number).

Verified non-vacuous by mutation: with the recorder temporarily changed to pass `totalUses: null`,
exactly these two cases fail and the other 17 stay green. The mutation was reverted (`git diff`
clean on that file).

### Documentation — one stale claim, fixed

- `docs/architecture.md` said "**Only** a retry that runs out … reaches
  `provisionAsResponder`'s catch-all as `InvitationExhaustedError`" — untrue after this change, and
  it was also the one sentence a reader would use to conclude the bug still exists. Rewritten to
  say the refusal fires whenever an attempt's use number is past the budget, first attempt or not,
  and that the manager handles it in a dedicated branch (not the catch-all).
- `docs/STATUS.md` said the spec holds "15 cases" (already stale before this ticket; now 19).
  Corrected, with the two new shapes named.
- `strand-formation-manager.ts`'s in-catch comment still described the trigger as
  "retry-then-exhaustion". Reworded.
- Checked and left alone: `strand-formation-protocol.ts`'s `INVALID_TOKEN_REASON` doc and
  `docs/cadre-consistency.md`/`docs/strands.md` say nothing that this change falsifies.

### Design — considered and kept

Threading an optional `totalUses` through two public methods to save one in-memory point lookup is
API surface bought with a micro-optimization, on a path that already does two invite reads and (for
a validating invite) an outbound HTTP call. Kept anyway: it was the explicit, reasoned choice of
both the bug ticket and the fix ticket, it is now covered by the two tests above, and reverting it
would churn four files for no observable gain.

### Tripwires (recorded, not filed)

- A passed-in `totalUses` is read before the write lock, so it is a cached value. Harmless while
  `FormationInvite` is insert/delete only (its `Immutable` constraint) — the only way to stale it
  is an owner revoking and re-issuing the same token with more seats mid-redemption. Parked as a
  `NOTE:` on `ControlDatabase.assertSeatRemains`' doc comment, with the remedy (drop the parameter,
  read per attempt) if invites ever gain an update path.

### Not filed

- No new tickets. Nothing found rose to major; the one gap (recorder-path coverage) was cheap to
  close inline.
- `control-database.ts` is 2268 lines (`wc -l`), which is large, but this change added ~35 of them
  and a split is unrelated to this ticket's site. Noted, deliberately not filed as size debt here.
- Cross-node (two real nodes) concurrency for this same guard is already claimed by
  `plan/28-debt-formation-use-number-race-real-concurrency`; no arm appended, since that ticket's
  scope already covers the negative single-seat case.

## Verification

- `yarn workspace @serfab/cadre-core test control-formation-use-number-retry` — **19/19 pass**
  (required first building the sibling `@quereus/quereus` workspace, which the stale-build guard
  flagged; no source there was touched).
- `yarn lint` (whole repo) — exit 0.
- The broader suites the implement pass ran (`control-formation-invite`,
  `control-formation-consent-signature`, `control-revocation-replay`) were not re-run: this review
  changed no production behaviour, only tests, comments, and docs. The one failure the implement
  pass saw there (`control-revocation-replay.spec.ts`, tombstone permanence) is pre-existing and
  already tracked — see `tickets/.pre-existing-known.md`, owned by
  `10-revocation-reissue-same-pk-update-unique-collision`.
