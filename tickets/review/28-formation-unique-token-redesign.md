----
description: Review the redesign that records each invitation acceptance under its own unique id (so two simultaneous acceptances can never silently erase each other) and enforces the invitation's use limit by counting recorded acceptances.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-formation-seat-budget.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-formation-consent-signature.spec.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, docs/architecture.md, docs/api.md, docs/STATUS.md
----

# Implemented: acceptance keyed by its own nonce; use cap enforced by counting

Settled decision (2026-08-04, do not re-litigate in review): the strict per-row sequence cap
was traded for an eventually-audited counted cap, because the sequence key's failure mode was
the SILENT loss of a consented join under the storage layer's last-write-wins merge, while the
counted cap's failure mode (concurrent over-admission) is visible in the append-only record and
reversible by owner-gated removal. The schema comment on `FormationUsage.Authorized` records
the decision at the site; do not "fix" it back toward a sequence number.

## What changed

**Schema** (`schemas/control.qsql` + byte-identical embedded copy in
`packages/cadre-core/src/control-schema.ts`; drift spec green):

- `FormationUsage.UseNumber` and the `Monotonic` constraint are gone. `UsageStampId` (the
  joiner-minted single-use nonce) is now the primary key; its former `unique` modifier dropped.
- The cap clause in `Authorized` is now
  `FI.TotalUses > (select count(*) from committed.FormationUsage U where U.Token = new.Token)`
  — deferred to commit, counting the pre-transaction snapshot, so a sequentially exhausted
  invite is still refused at the schema even when the TypeScript pre-check is bypassed.
- **The `Token` index landed** — `index FormationUsageByToken on FormationUsage (Token);` in the
  `declare schema` body, same form as `schemas/chat.qsql`. No fallback needed: the DDL loads on
  the optimystic-backed control store, and `countFormationUsage` / `isTokenUsed` /
  `hasOutstandingFormationInvite` (all filtering on the now non-PK `Token`) pass in the full
  suite against it.

**cadre-core source** (`control-database.ts` and neighbours):

- Deleted: `USE_NUMBER_ATTEMPTS`, `LOST_USE_NUMBER_PATTERNS`, `isLostUseNumberRace` (grep
  confirmed only tests imported it; never exported from `index.ts`), `withUseNumberRetry`,
  `nextUseNumber`, and the `unwrapError` import they used.
- `redeemInvitation` / `recordFormationUsage` now wrap their write in a single
  `lockedWithRetry(body, {}, 'formation-usage')` (label renamed from `formation-use-number`).
  Body order is contractual and commented at both sites: abort check → `assertSeatRemains` →
  write. `FormationAbortedError` is only ever thrown before the write is issued; a transient
  retry re-runs the whole body, re-checking both.
- `assertSeatRemains(token, knownTotalUses)` is count-based: it reads
  `countFormationUsage(token)` and throws `InvitationExhaustedError(token, usesRecorded,
  totalUses)` when `used >= totalUses`. (Micro-deviation from the ticket's literal snippet: the
  count is skipped when `totalUses` is null/unlimited — semantically identical, one read
  cheaper.) The `knownTotalUses` passthrough and its `FormationInvite`-is-immutable rationale
  are kept, as is the NOTE about a spurious empty invite read costing only the named error.
- `FormationUsageResult` is `{ usageStampId: string }`; the echo-back rationale kept.
- `execFormationUsageInsert` lost the `useNumber` option/column.
- `lockedWithRetry` and `isRetriableControlWriteFailure` are untouched behaviourally; prose in
  `control-write-retry.ts` that referenced the deleted classifier/outer loop was rewritten.
- `strand-formation-manager.ts`: exhaustion log line uses `usesRecorded`; both comment blocks
  rewritten; `InvitationExhaustedError` is still mapped terminal (`INVALID_TOKEN_REASON`),
  never into the retryable catch-all. `control-formation-recorder.ts`'s `provisionAndRecord`
  comment tail rewritten (same-node loser → named exhaustion; cross-node → accepted
  over-admission, not a retried collision).

**Docs**: `docs/api.md` (hook contacted at most once per redemption, now because nothing
contends; `TotalUses` stated plainly as an audited bound under concurrency), `docs/architecture.md`
(new model + the accepted trade, replacing the `withUseNumberRetry` paragraph; also re-pointed a
stale historical reference to `Monotonic` as the `committed.*` example), `docs/STATUS.md` (bullet
now names `control-formation-seat-budget.spec.ts`, 11 cases — counted, not estimated). Grep of
`docs/` for `UseNumber` / `use number` / `use #` / `use-number` is clean.

## Tests — what to run, what was deleted, where survivors live

- `control-formation-use-number-retry.spec.ts` → **renamed**
  `control-formation-seat-budget.spec.ts` (11 cases). Deleted with the loop: the
  `isLostUseNumberRace` classifier describe, every stub-driven retry case (`staleOnce`,
  `nextUseNumber` stubs, bounded-attempts, commit-time-loss, rollback-between-attempts), the
  `useNumbersFor` helper, and both disjointness cases (there as `is disjoint from
  isLostUseNumberRace`, and in `control-write-retry.spec.ts` plus its simulated-nesting case).
  Survivors, re-pointed to nonce sets:
  - the whole `concurrent redemptions on one node` describe (two-use invite lands both with the
    hook asked exactly twice; single-use seats exactly one, loser refused by name with
    `usesRecorded`; recorder-threaded budget for both the record-only and unbound paths);
  - `does NOT retry a duplicate nonce` (one write attempt, `execFormationUsageInsert` counting
    stub kept), the exhaustion-by-name case, an abort case, the expired-invite case;
  - `isRetriableControlWriteFailure` never claiming a real constraint failure — the surviving
    half of the deleted disjointness property, still driven from real engine errors.
- **New cases** pinning the new semantics: sequential exhaustion refused by name leaving exactly
  one row; the schema's own count-based cap refusing an over-cap RAW insert (bypassing the
  TypeScript guard); a two-use invite admitting exactly two rows under unrelated nonces and
  refusing the third (no ordering assumption).
- `control-formation-invite.spec.ts`: the use-number-race case replaced by
  `admits a second joiner under its own nonce, and refuses a verbatim replay on the primary key`;
  raw-insert helper and all assertions re-pointed (`usageStampId` echo).
- `control-formation-consent-signature.spec.ts`, `strand-formation-consent.spec.ts`,
  `control-revocation-replay.spec.ts`, `control-constraint-helpers.ts`: swept per ticket.
- **Coverage honestly lost, by design**: nothing exercises "another writer took my key between
  read and commit" because that situation no longer exists; and the bounded-attempts /
  rollback-between-attempts behaviour has no code to attach to. The abort coverage changed
  shape: the old "signal fires between attempts" case became "signal already fired before the
  write" in the seat-budget spec, and the stronger queued-behind-a-writer abort cases in
  `control-formation-invite.spec.ts` (~line 361) pass unchanged.

## Facts a reviewer will want

- **Duplicate-nonce engine message**, captured live from the engine (not assumed):
  `UNIQUE constraint failed: FormationUsage.UsageStampId` — pinned with a regex in the
  seat-budget spec's classifier case, and every `expectUniqueViolation` call site uses exactly
  that column.
- The schema's cross-node duplicate-nonce convergence caveat was carried over but its first
  words adapted ("the key is evaluated against LOCALLY VISIBLE rows") since the `unique`
  modifier it named no longer exists — the ticket said "verbatim"; flagging the deliberate
  wording drift.
- The cap clause uses `count(*)` (ticket's exact SQL); the rest of the schema uses `count(1)`.
  Both work; cosmetic inconsistency a reviewer may want to normalise.
- **Cross-node over-admission is NOT tested here** — single-node suite serializes through one
  write queue, so it cannot occur; no fake race was stubbed. It belongs to
  `formation-concurrent-redemption-e2e` (in implement/, prereq on this ticket).
- **`reference-app-web` and `integration-tests` still read the dropped column** (SQL strings and
  `row.X as number` casts — invisible to build/lint, fails at runtime):
  `cadre-web.ts`, `Diagnostics.svelte`, `e2e/fixtures/formation-responder.ts`,
  `strand-formation-e2e.integration.ts`. All owned by `formation-use-number-ripple`
  (implement/, prereq on this ticket). Do not file these as findings.

## Validation performed

From `packages/cadre-core`: `yarn build` clean; `yarn vitest run test/control-schema-drift.spec.ts`
green; the three formation specs green (79 tests); **full package suite green: 93 files, 1503
passed, 1 skipped** (the skip is a pre-existing `skipIf(win32)` in `key-store.spec.ts`,
unrelated). `yarn lint` at repo root clean. `grep -rn "useNumber|UseNumber|use number|use #"`
over `packages/cadre-core/src`, `test`, `schemas/control.qsql`, and `docs/` returns nothing
(remaining "Monotonic" hits in the package are the unrelated clock/reissue-counter senses).
Note: `../quereus` was rebuilt twice during this run to satisfy the stale-build guard — its src
is being edited concurrently by someone else; if tests fail on "Stale build detected", rebuild
`@quereus/quereus` first.
