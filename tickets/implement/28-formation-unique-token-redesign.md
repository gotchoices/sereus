----
description: Change how invitation acceptances are recorded so two people accepting at the same moment can never silently erase each other — each acceptance is stored under its own unique id instead of a fought-over sequence number, and the invitation's use limit is enforced by counting.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-formation-consent-signature.spec.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, docs/architecture.md, docs/api.md, docs/STATUS.md
difficulty: hard
----

# Key each acceptance by its own nonce; enforce the use cap by counting

## Decision context (settled — do not re-litigate)

Measured 2026-08-02 (`tickets/blocked/…-formation-use-number-lost-update-cross-node`, now
resolved by this design): two nodes redeeming one invitation concurrently both compute
`UseNumber = 1`, both commit, both are told they succeeded, and the storage layer's merge
keeps only the second row — the first joiner's consent record vanishes with no error. The
collision-retry machinery (`withUseNumberRetry` / `isLostUseNumberRace`) is correct but
unreachable, because the refusal it recovers from is never raised. Fixing that refusal lives
upstream (`tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww`).

The same measurement's Experiment 3 proved concurrent inserts of DIFFERENT primary keys both
survive the merge. So a design where two concurrent acceptances never share a primary key
removes this repo's exposure entirely.

**The human decided 2026-08-04: take that design.** Accepted trade, explicitly: the
invitation's use cap changes from strictly enforced (dense sequence, per-row `TotalUses >=
UseNumber`) to eventually-audited (count against the committed snapshot). Under a concurrent
race or cross-node convergence lag the cap can over-admit, bounded by the number of concurrent
redeemers. That failure is visible (both rows survive in the append-only audit) and reversible
(owner-gated member removal + `Revocation`), whereas the failure it replaces — silent loss of a
consented join — is invisible and unrecoverable. **Do not weaken this back toward sequence
numbers to restore a strict cap.**

No migration. AGENTS.md: no backwards compat yet — schema changes may assume fresh stores.
Do not write a migration path or a dual-read shim.

## Schema (`schemas/control.qsql` AND `packages/cadre-core/src/control-schema.ts`)

Two copies, kept byte-identical by `packages/cadre-core/test/control-schema-drift.spec.ts`
(the embedded copy is inside a template literal — backticks and `${` need escaping). Edit both.

`FormationUsage`:

- Drop the `UseNumber` column and the whole `Monotonic` constraint.
- `primary key (Token, UseNumber)` → `primary key (UsageStampId)`; drop the now-redundant
  `unique` modifier on the `UsageStampId` column declaration (keep `not null`).
- `Token` stays a plain column. Add a secondary index after the table declaration, in the
  `declare schema` body, same form `schemas/chat.qsql` uses:
  `index FormationUsageByToken on FormationUsage (Token);` — `Token` is no longer a
  primary-key prefix, and the cap check, `countFormationUsage`, `isTokenUsed` and
  `hasOutstandingFormationInvite` all filter on it.
  *Fallback, only if that DDL fails on the optimystic-backed control store:* drop the index
  line, add a `NOTE:` tripwire at `countFormationUsage` saying every count is a full scan of
  `FormationUsage` and why the index was not taken, and say so in the review handoff. Do not
  fight the storage layer inside this ticket.
- `Authorized`'s cap clause changes from `FI.TotalUses >= new.UseNumber` to a count over the
  pre-transaction snapshot:

```sql
and (FI.TotalUses is null or FI.TotalUses > (select count(*) from committed.FormationUsage U where U.Token = new.Token))
```

  `Authorized` already contains subqueries, so Quereus auto-defers it to commit — by which
  point the in-flight row is live, and `committed.*` is what excludes it (exactly the reason
  `Monotonic` read `committed.*`). A sequentially-exhausted invite is therefore still refused.

Comments to carry (this schema documents its own reasoning; a bare edit will read as a bug to
the next person):

- On `UsageStampId` as the primary key: keep the existing "joiner mints it, both digests bind
  it, neither side can swap it" text and the append-only/never-freed note; state that it is now
  the row key, so a verbatim replay of an approval collides on the PK locally instead of on a
  column `unique`. Keep the cross-node duplicate-nonce convergence caveat verbatim.
- On the new cap clause: state the accepted eventual-audit semantics — sequential redemptions
  are refused at `TotalUses`, concurrent redeemers on separate nodes (or nodes that have not
  converged) can each see the same count and both land, over-admitting by at most the number of
  concurrent redeemers; both rows survive in the append-only record so the overage is auditable,
  and removal is owner-gated. Mirror the wording style of the convergence note on `UsageStampId`.
  End with: do not "fix" this into a sequence number — that trade was considered and rejected
  because it reintroduces silent loss of a consented join.
- Same comment, one line on future writers: two `FormationUsage` rows for one token inserted in
  ONE transaction each read the same committed count, so they can jointly exceed the cap. No
  writer in this repo does that; it is a constraint on future writers, not a case to engineer for.

Untouched by construction, and worth stating so nobody goes looking: `Strand.AuthorizedInsert`'s
consent branch matches usage rows by `(StrandId, StrandStampId)`, never by use number; the
`'vouch'` and `'consent'` digests already deliberately exclude `UseNumber`. No signature format,
protocol frame, or approval-hook payload changes.

## cadre-core (`packages/cadre-core/src`)

`control-database.ts`:

- Delete `USE_NUMBER_ATTEMPTS`, `LOST_USE_NUMBER_PATTERNS`, `isLostUseNumberRace` (exported, but
  only tests import it — confirm with a grep before deleting), `withUseNumberRetry`, and the
  `nextUseNumber` probe read.
- `FormationUsageResult` becomes `{ usageStampId: string }`. Keep the interface and its export
  in `index.ts`; keep the doc comment's point that the nonce is echoed back so a caller can prove
  the value it signed over is the one that landed.
- `execFormationUsageInsert` drops the `useNumber` option and the `UseNumber` column from the
  insert list/values.
- `redeemInvitation` / `recordFormationUsage`: replace the `withUseNumberRetry(...)` wrapper with
  a direct `this.lockedWithRetry(async () => { … }, {}, 'formation-usage')` whose body keeps, in
  this order, the `signal?.aborted` → `FormationAbortedError` check, `assertSeatRemains`, then the
  write. That ordering is contractual: `FormationAbortedError` may only be thrown before the
  write is issued. Both return `{ usageStampId }`; the log lines drop `use #%d` and log the stamp.
  `lockedWithRetry` and `isRetriableControlWriteFailure` (`control-write-retry.ts`) STAY —
  transient cluster failures are a separate, still-real concern. Prune only the prose in
  `control-write-retry.ts` (lines ~251, ~287, ~298, ~441) that refers to the deleted classifier
  and the loop it nested inside.
- `assertSeatRemains(token, knownTotalUses)`: count-based. `const used = await
  this.countFormationUsage(token)` (already public, already `where Token = ?`), then
  `if (totalUses != null && used >= totalUses) throw new InvitationExhaustedError(token, used,
  totalUses)`. Keep the `knownTotalUses` passthrough and its `FormationInvite`-is-immutable
  rationale; keep the existing NOTE that a spurious empty invite read only costs the NAMED error
  and reverts to the generic `Authorized` refusal.
- `InvitationExhaustedError`: second field becomes `readonly usesRecorded: number` (drop
  `useNumber`); message e.g. `Invitation ${token} is exhausted: ${usesRecorded} of ${totalUses}
  use(s) already recorded`. Rewrite its doc comment: it is now raised off the count check ahead of
  the write, and off nothing else; the point it must keep is why it exists at all — without it the
  refusal surfaces as a generic `CHECK constraint failed: Authorized`, which the manager reports
  as a retryable `Formation conflict, retry`, telling the joiner to retry something that can never
  succeed.

`strand-formation-manager.ts`: update the `InvitationExhaustedError` log line to the new fields,
and rewrite the two comment blocks (~line 306, ~line 386) that describe the `(Token, UseNumber)`
PK collision and `withUseNumberRetry`. Verify the error is still mapped as terminal
(`INVALID_TOKEN_REASON`), not into the retryable catch-all.

`control-formation-recorder.ts` (~line 255-278): rewrite the `provisionAndRecord` comment tail —
the loser of a same-node concurrent redemption of a single-use invite is still refused as
`InvitationExhaustedError` (the local write queue serializes it, so it reads the committed count),
and a cross-node race is the accepted over-admission case rather than a retried collision.

## Tests (`packages/cadre-core/test`)

- `control-formation-use-number-retry.spec.ts` → rename to `control-formation-seat-budget.spec.ts`.
  **Delete** the `isLostUseNumberRace (classifier)` describe, the `retrying a lost use number`
  describe's stub-driven cases (`staleOnce`, `withStubbed` on `nextUseNumber`, bounded-attempts,
  commit-time-loss), the `useNumbersFor` helper, and the `is disjoint from isLostUseNumberRace`
  case. **Keep and re-point** (this is the coverage that must not be lost with the loop):
  - the whole `concurrent redemptions on one node` describe — two-use invite lands both uses with
    the hook asked exactly twice; single-use invite seats exactly one; the record-only and unbound
    losers report exhaustion on the budget the recorder passed down. Assertions move from use
    numbers to the set of `UsageStampId` values;
  - `does NOT retry a duplicate nonce`, `reports an exhausted invitation by name`, `abandons the
    redemption when the signal fires`, `lets an invite that expires mid-write fail cleanly`;
  - `isRetriableControlWriteFailure … never retries a real constraint or authorization failure`,
    driven from real engine errors. This is the surviving half of the deleted disjointness
    property and is worth keeping: a constraint failure must never be retried as transient.
- `control-formation-invite.spec.ts`: drop the `useNumber` field from `rawInsertFormationUsage`
  and every `.useNumber` assertion. Rewrite two cases —
  - `recordFormationUsage adds usage rows … monotonically` → asserts two rows against one strand,
    each under its own `UsageStampId`, neither erasing the other;
  - `lets the loser of a use-number race retry the SAME approval under the next use number`
    (~line 1241) → the machinery it drove is gone. Replace with: a second joiner, with its own
    approval and its own nonce, lands a second row for the same token, and both rows are readable
    with their own `PeerKey` — plus the verbatim-replay refusal now naming
    `FormationUsage.UsageStampId`.
  - the raw-insert race case at ~line 1266 that expects a `(Token, UseNumber)` unique violation →
    a duplicate-`UsageStampId` violation.
- `control-formation-consent-signature.spec.ts`: `.useNumber` assertions become `usageStampId`
  echo assertions; the comment at ~line 257 explaining why a replay reaches the nonce's `unique`
  (rather than the PK) needs rewriting — the nonce IS the PK now.
- `control-write-retry.spec.ts`: remove the `isLostUseNumberRace` import and the two disjointness
  cases; update the synthetic DDL message helper (~line 64) and the `SIMULATED_*` literal
  (~line 100) that name `UseNumber`; delete the `simulatedUseNumberRetry` nesting case (~line 555)
  — the outer loop no longer exists.
- `strand-formation-consent.spec.ts` (~lines 249, 335-338): assert on distinct `UsageStampId`
  values per strand rather than on `{1, 2}`.
- `control-revocation-replay.spec.ts` (~lines 805, 843): drop `.useNumber` assertions.
- `control-constraint-helpers.ts` (~line 44): the doc example naming
  `'FormationUsage.Token', 'FormationUsage.UseNumber'` → `'FormationUsage.UsageStampId'`.
- **Add** two cases pinning the new semantics directly (they are the reason for the change):
  - sequential exhaustion — a single-use invite redeemed twice in a row (converged, one node)
    refuses the second with `InvitationExhaustedError`, not a retryable conflict, and leaves
    exactly one row;
  - the cap is counted, not sequenced — a two-use invite whose first redemption is later joined
    by a second admits exactly two rows and refuses a third, with the rows carrying unrelated
    nonces (no ordering assumption anywhere in the assertion).

## Docs

- `docs/api.md` (~line 188): the paragraph explaining that `UseNumber` is not a signed field and
  that the loser retries under a fresh use number. Rewrite: the approval hook is still contacted
  **at most once per redemption** — now because each redemption writes under its own nonce and
  never contends for a shared key, so there is no lost race to recover from. State the cap's
  eventually-audited semantics plainly for the hook author: a spent invitation is refused, and
  simultaneous redemptions can exceed the stated limit by the number of simultaneous redeemers.
- `docs/architecture.md` (~line 544): replace the `withUseNumberRetry` paragraph with the new
  model — acceptance keyed by the joiner's nonce, cap counted against the committed snapshot,
  the accepted over-admission trade and why it was chosen over silent loss, and
  `InvitationExhaustedError` still reported to the joiner as `'Invalid token'`.
- `docs/STATUS.md` (~lines 1107-1115): the "recovery from a lost race … for
  `FormationUsage.UseNumber`" bullet describes a deleted spec and a deleted loop. Rewrite to name
  the new spec file and what it covers. Check the case count claim you write is the count you
  actually have.
- Grep `docs/` for `UseNumber`, `use number`, `use #` after editing; nothing should survive.

## Edge cases & interactions

- **Sequential exhaustion still refused.** Redemptions recorded one after another on a converged
  node must hit the count-based refusal at `TotalUses` and surface as `InvitationExhaustedError`
  (terminal), never as `Formation conflict, retry`. Both the pre-write check and the `Authorized`
  CHECK must agree; assert the CHECK's refusal independently with a raw insert that bypasses the
  pre-check, so the schema is not resting on the TypeScript guard.
- **Concurrent over-admission is accepted, and must be observable.** Not testable inside
  `cadre-core`'s single-node suite (one write queue serializes it) — it belongs to
  `28.5-formation-concurrent-redemption-e2e`. Do not stub a fake race here to "prove" it.
- **Same-transaction double-insert.** Two usage rows for one token in one transaction each read
  the same committed count and can jointly exceed the cap. Documented as a constraint on future
  writers in the schema comment; do not engineer around it.
- **Approval single-use is unchanged.** One sign-off still buys exactly one row: the digest binds
  `UsageStampId`, and a verbatim replay now collides on the primary key instead of a column
  `unique`. Confirm the engine's message for a duplicate PK is still a
  `UNIQUE constraint failed: FormationUsage.UsageStampId` shape and fix the `expectUniqueViolation`
  call sites to whatever it actually is — do not assume.
- **Bound vs unbound paths.** `redeemInvitation` (unbound: strand + usage row in one transaction)
  and `recordFormationUsage` (bound: usage row only) both lose the use-number leg. Exercise both;
  the original measurement raced only the bound one.
- **Abort contract.** `FormationAbortedError` is thrown only before a write is issued. Removing
  the retry loop removes the "between attempts" window, so the check now runs exactly once per
  call, inside the lock. The existing abort cases in `control-formation-invite.spec.ts`
  (~line 361) must still pass unchanged.
- **Transient-failure retry still wraps the write.** `lockedWithRetry` re-runs the body, including
  the abort check and the seat count. A retry after a transient cluster failure re-reads the count
  — correct, and the reason `assertSeatRemains` stays inside the callback rather than above it.
- **`hasOutstandingFormationInvite` / `isTokenUsed` are already count-based** and need no logic
  change — but they now read a non-PK column. Confirm they still return correct results against
  the new key (this is the concrete check that the index, or its absence, works).
- **Existing stored rows.** No migration; fresh stores only.

## TODO

### Phase 1 — schema

- Edit `FormationUsage` in `schemas/control.qsql`: drop `UseNumber` + `Monotonic`, PK to
  `UsageStampId`, drop that column's `unique`, count-based cap clause, add the `Token` index,
  write the comments described above.
- Mirror byte-for-byte into `CONTROL_SCHEMA` in `packages/cadre-core/src/control-schema.ts`.
- Run `yarn vitest run test/control-schema-drift.spec.ts` in `packages/cadre-core` first — a
  drift or DDL failure here invalidates everything downstream, so find it before editing code.

### Phase 2 — cadre-core source

- Delete the use-number machinery; rewrite `redeemInvitation` / `recordFormationUsage` /
  `assertSeatRemains` / `execFormationUsageInsert` / `FormationUsageResult` /
  `InvitationExhaustedError` as above.
- Sweep the prose in `control-write-retry.ts`, `strand-formation-manager.ts`,
  `control-formation-recorder.ts`.
- `yarn build` in `packages/cadre-core`; grep the package for `UseNumber|useNumber` and expect
  zero hits in `src/`.

### Phase 3 — tests

- Rename and prune `control-formation-use-number-retry.spec.ts` →
  `control-formation-seat-budget.spec.ts`, keeping the coverage listed above.
- Sweep the other six test files; add the two new cap-semantics cases.
- Stream the runs: `yarn vitest run test/control-formation-seat-budget.spec.ts test/control-formation-invite.spec.ts test/control-formation-consent-signature.spec.ts 2>&1 | tee /tmp/formation.log`,
  then the full package suite the same way. Never redirect silently — the runner's idle timeout
  kills an unstreamed long command.

### Phase 4 — docs + handoff

- Rewrite the three doc passages; grep `docs/` clean.
- `yarn lint` at the repo root.
- Review handoff: state whether the `Token` index landed or the fallback was taken; the exact
  engine message a duplicate `UsageStampId` produces; which coverage was deleted with the retry
  loop and where its survivors now live; and that `reference-app-web` still reads the dropped
  column until `28.2-formation-use-number-ripple` lands.
