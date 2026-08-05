----
description: Change how invitation acceptances are recorded so that two people accepting at the same moment can never silently erase each other — each acceptance is stored under its own unique id instead of a fought-over sequence number, and the invitation's use limit is enforced by counting.
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-formation-consent-signature.spec.ts, packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/src/Diagnostics.svelte
difficulty: hard
----

# Record formation usage under a unique id, not a raced sequence number

## Decision context (settled — do not re-litigate)

`formation-use-number-lost-update-cross-node` (was `tickets/blocked/28-…`, measured
2026-08-02) proved that two nodes redeeming the same invitation concurrently both compute
`UseNumber = 1`, both commit, both are told they succeeded, and the storage layer's merge
silently keeps only the second row — the first joiner's consent record vanishes with no
error. The collision-retry machinery (`withUseNumberRetry` / `isLostUseNumberRace`) is
correct but unreachable, because the refusal it recovers from is never raised. Fixing the
refusal lives in `../optimystic` (tracked in
`tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww`).

The same measurement's Experiment 3 proved concurrent inserts of DIFFERENT primary keys
both survive the merge (ordinary eventual convergence). So a design in which two
concurrent acceptances never share a primary key removes this repo's exposure to the
upstream defect entirely.

**The human decided 2026-08-04: take that design.** The accepted trade, explicitly: the
invitation's use cap changes from strictly enforced (dense sequence, per-row
`TotalUses >= UseNumber`) to eventually-audited (count-based check against the committed
snapshot). Under a concurrent race or cross-node convergence lag the cap can over-admit,
bounded by the number of concurrent redeemers. That failure is visible (both rows survive
in the append-only audit) and reversible (owner-gated member removal + Revocation),
whereas the failure it replaces — silent loss of a consented join — is invisible and
unrecoverable. Do not weaken the design back toward sequence numbers to restore a strict
cap; that trade was considered and rejected.

## Design

### Schema (`schemas/control.qsql`, `FormationUsage`)

- Primary key becomes `UsageStampId` (already `text not null unique` — the joiner-minted,
  consent-signed nonce; see the existing column comment for why neither side can swap it).
  Drop the `unique` modifier once it is the PK.
- Drop the `UseNumber` column and the `Monotonic` constraint entirely.
- Keep `Token` as a plain indexed/filterable column.
- `Authorized`'s cap clause `FI.TotalUses >= new.UseNumber` becomes a count over the
  pre-transaction snapshot:
  `(FI.TotalUses is null or FI.TotalUses > (select count(*) from committed.FormationUsage U where U.Token = new.Token))`.
  The subquery makes the CHECK auto-defer to commit, same as `Monotonic` did; `committed.*`
  excludes the in-flight row, so a sequentially-exhausted invite is still refused. Carry a
  comment stating the accepted eventual-audit semantics (mirror the convergence-window
  wording already on `UsageStampId`), so a future reader does not "fix" it into a race.
- Everything else is untouched by construction: the `Strand.AuthorizedInsert` consent
  branch matches usage rows by `(StrandId, StrandStampId)`, not by use number; the vouch
  and consent digests already deliberately exclude `UseNumber`
  (`control.qsql` "Why a fresh nonce rather than binding UseNumber"), so no signature,
  protocol handshake, or approval format changes.

### cadre-core

- `recordFormationUsage` / `redeemInvitation` no longer compute or return a use number;
  they return the `usageStampId` they already mint/receive. Callers that displayed or
  logged `useNumber` switch to the stamp id.
- Delete the now-dead collision machinery: `withUseNumberRetry`, `isLostUseNumberRace`,
  `LOST_USE_NUMBER_PATTERNS`, the max-use-number probe read, and their tests
  (`control-formation-use-number-retry.spec.ts`). `lockedWithRetry` /
  `isRetriableControlWriteFailure` (`control-write-retry.ts`) stay — transient cluster
  failures are a separate concern and still real.
- `InvitationExhaustedError` stays, now raised off the count-based `Authorized` refusal
  (sequential exhaustion). Verify the manager still maps it as terminal, not retryable.

### Ripple

`UseNumber` appears in ~16 files across `cadre-core`, `integration-tests`,
`reference-app-web` (protocol fixtures, `Diagnostics.svelte`), and tests — mechanical
renames/removals, but sweep them all; `yarn lint` will not catch a stale UI column header.
Update `docs/architecture.md` / `docs/strands.md` where they describe use-number
sequencing. `28.5-formation-concurrent-redemption-e2e` (implement/, prereq-chained here)
must be rewritten by this plan's output — its collision-retry premise is gone; see the
note prepended to that ticket.

## Edge cases & interactions

- **Sequential exhaustion still refused.** Uses recorded one after another (converged
  cohort) must hit the count-based refusal at `TotalUses`; assert the joiner-facing error
  is `InvitationExhaustedError`, not a retryable conflict.
- **Concurrent over-admission is accepted, and must be observable.** Two nodes racing the
  last use may both land; both rows must survive on BOTH nodes' views with distinct
  `UsageStampId`/`PeerKey`, and a count query must show the overage. No error is required.
- **Same-transaction double-insert.** Two usage rows for one token in one transaction each
  see the same committed count — both pass a cap they might jointly exceed. No writer in
  the repo does this today; state it as a constraint on future writers in the schema
  comment rather than engineering for it.
- **Approval single-use is unchanged.** One validation sign-off still buys exactly one row
  (digest binds `UsageStampId`; `unique`/PK refuses verbatim replay locally). The
  cross-node duplicate-nonce convergence caveat already documented on `UsageStampId`
  carries over verbatim.
- **Bound vs unbound paths.** `redeemInvitation` (unbound: seats the strand + usage row in
  one transaction) and `recordFormationUsage` (bound: usage row only) both lose the
  use-number leg; the strand-seating consent branch is stamp-matched and unaffected — but
  test both paths, not just the bound one the original measurement raced.
- **Existing stored rows.** No backwards compat yet (AGENTS.md) — schema changes may
  assume fresh stores; say so in the implement ticket so nobody builds a migration.
