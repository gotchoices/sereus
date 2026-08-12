----
description: Each invitation acceptance is now recorded under its own unique id, so two simultaneous acceptances can never silently erase each other, and the invitation's use limit is enforced by counting the acceptances already recorded.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-formation-seat-budget.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-formation-consent-signature.spec.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, docs/architecture.md, docs/api.md, docs/STATUS.md
----

# Acceptance keyed by its own nonce; use cap enforced by counting

## What shipped

`CadreControl.FormationUsage` no longer carries a per-token sequence number. The row key is
`UsageStampId` — the single-use nonce the joining peer mints and signs into its own consent
digest — so two acceptances of one invitation never compete for the same row key. The
invitation's `TotalUses` limit is enforced by **counting** already-recorded acceptances, in two
places: `ControlDatabase.assertSeatRemains` ahead of the write (so a spent invitation is refused
by the named `InvitationExhaustedError`, not as a generic constraint failure the joiner is told
to retry), and the schema's own `FormationUsage.Authorized` clause against the pre-transaction
snapshot (so the cap does not rest on the TypeScript guard).

Everything the sequence number needed — the retry loop, its bounded-attempts constant, its
error-text classifier, the `Monotonic` constraint — is gone. A new
`index FormationUsageByToken on FormationUsage (Token)` backs the per-token filters that used
to ride the primary key's leading column.

The trade this makes was settled at plan time (2026-08-04) and is recorded at the schema site:
concurrent acceptances on separate nodes can each read the same count and both land,
over-admitting by at most the number of concurrent redeemers. That overage is visible in the
append-only record and reversible by owner-gated removal, where the sequence key's failure mode
was the **silent** loss of a consented join under last-write-wins merge. Review did not
re-litigate it.

## Review findings

Reviewed against the implement diff (`d8652b7`) with fresh eyes before reading the handoff, then
against the handoff's own claims. Full source, schema, docs and test sweep.

### Fixed in this pass (minor)

- **`FormationUsage.Token` lost its non-nullity.** Dropping `(Token, UseNumber)` as the primary
  key left `Token` a bare nullable column. No bad row was reachable — `Authorized`'s
  `FormationInvite` exists-clause cannot match `null = null`, so a null-token insert already
  failed — but the invariant was being carried by a CHECK instead of by the column. Added
  `not null` to both schema copies with a comment saying why it is stated explicitly, plus a new
  spec case (`refuses a null Token outright, rather than leaving it to Authorized`) that proves
  the engine enforces it and that the refusal is *not* `Authorized` — otherwise the comment would
  be describing a guard that does not exist.
- **`count(*)` in the new cap clause.** The rest of `schemas/control.qsql`, `strand.qsql` and
  `chat.qsql` use `count(1)` uniformly; the new clause was the single outlier. Normalised in both
  schema copies. The handoff flagged this itself.
- **Stale `FormationUsage.Monotonic` reference outside the ripple ticket's scope.**
  `packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts:23`
  cited the deleted constraint as the example of a deferred CHECK reading `committed.<Table>`.
  Re-pointed at `FormationUsage.Authorized`'s count-based cap, matching the wording
  `docs/architecture.md` already uses. This file is **not** in
  `28.2-formation-use-number-ripple`'s `files:` list, so it would otherwise have been missed.
- **Test assertion gap on the unbound race.** `reports the loser of an unbound provision race as
  exhausted, seating exactly one strand` asserted the winner's strand exists but never checked
  that the loser left no orphan strand behind — which is the half its own comment claims. Added a
  before/after `Strand` row count (the loser's id is minted inside the recorder and unreachable
  from the test, so a count is the only way to see an orphan).
- **Two prose/format leftovers.** A blank line left inside the `isRetriableControlWriteFailure`
  describe by the deleted disjointness case, and an unwrapped ~150-column comment line in
  `control-formation-invite.spec.ts` left by an in-place edit.
- **Stale board fact.** `tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md`
  stated `FormationUsage`'s key is `(Token, UseNumber)` as part of its reasoning about which read
  shapes are safe. Corrected, and an arm appended (below).

### Recorded as a tripwire, not a ticket

- **The seat count is now an index seek, where it used to be a scan.** Declaring
  `FormationUsageByToken` changes `select count(1) … where Token = ?` from a leading-key partial
  match the optimystic vtab declines (served by scan + engine filter) into a descent through a
  separate index collection. That count *is* the seat cap, so an under-reporting descent would
  admit a seat the invitation did not pay for — a failure mode a scan could not produce. Descent
  misses have been observed on a networked store for full-primary-key lookups (tracked by
  `debt-composite-pk-point-lookup-unreliable-untracked`); **no miss has been observed on this
  index**, and the full package suite exercises the seek. Parked as a `NOTE:` on
  `ControlDatabase.countFormationUsage` naming the symptom to look for, and as a third numbered
  question appended to that existing debt ticket rather than a new one — the ticket's deliverable
  is already "state which lookup shapes are safe on a networked strand", and index descents
  belong inside that answer.

### Checked and found clean — with the reason, not just the verdict

- **Settled trade re-checked, not re-opened.** The accepted-tradeoff `NOTE:` on
  `FormationUsage.Authorized` states the decision, the date, and the reasoning. Its premises have
  not changed, so it stands untouched — per the accepted-tradeoffs rule.
- **Deleted-code sweep is complete inside this ticket's scope.** `UseNumber` / `useNumber` /
  `use number` / `use #` / `withUseNumberRetry` / `isLostUseNumberRace` return zero hits across
  `packages/*/src`, `packages/cadre-core/test`, `schemas/`, and `docs/`. Remaining `Monotonic`
  hits in the package are the unrelated clock and reissue-counter senses. The four
  `reference-app-web` / `integration-tests` readers of the dropped column are owned by
  `28.2-formation-use-number-ripple` and deliberately not filed here.
- **Docs reflect the new reality, verified by reading each one.** `docs/api.md`'s hook-contacted-
  once guarantee now rests on "no contention" rather than "the loser retries", and states
  `TotalUses` as an audited bound. `docs/architecture.md`'s formation section, its `FormationUsage`
  and `ValidationKey` table rows, and its network-backing bullet are all consistent with a
  nonce-keyed, counted-cap design. `docs/STATUS.md`'s bullet names the renamed spec; its case
  count was 11 and is now updated to 12 with the new case described.
- **Ordering inside the locked body is sound.** Abort check → seat check → write, with
  `FormationAbortedError` only ever thrown before a write is issued, and the whole body re-run
  (both checks included) on a `lockedWithRetry` transient retry. `assertSeatRemains` reaches only
  non-locking reads (`queryFormationInvite`, `countFormationUsage`), so the
  "no locked public method inside a locked body" hazard the deleted retry's comment warned about
  is not re-introduced.
- **No behaviour regression in the transient-retry-after-a-landed-write edge.** Re-running the
  body after a transient failure whose write actually committed now hits either the named
  exhaustion (capped invite) or the nonce's primary key (uncapped) instead of silently writing a
  second row under a fresh sequence number. That is the same or better than the prior design, and
  the residual — a joiner told "retry" after a multi-use write that did land — is a property of
  `lockedWithRetry` shared by every control write, not of this change. Left alone deliberately.
- **Coverage the handoff admitted losing is genuinely unreachable, not merely untested.** The
  "another writer took my key between read and commit" cases and the bounded-attempts /
  rollback-between-attempts cases have no code left to attach to. The abort coverage changed shape
  rather than shrinking (the queued-behind-a-writer abort cases in
  `control-formation-invite.spec.ts` still pass unchanged).
- **Cross-node over-admission remains untested here, correctly.** The single-node suite serialises
  through one write queue, so it cannot occur; no fake race was stubbed to pretend otherwise. It
  belongs to `28.5-formation-concurrent-redemption-e2e`.

### Nothing filed as a new bug or feature ticket

No finding in this pass was severe enough or general enough to need one. The one architectural
concern (the index seek) attached to an existing ticket as an arm; everything else was a minor
fix applied inline.

## Validation

From `packages/cadre-core`, after the review's changes:

- `yarn build` — clean.
- `yarn vitest run test/control-formation-seat-budget.spec.ts` — 12 passed.
- `yarn vitest run` (full package suite, 93 files) — 1502–1503 passed, 1 skipped, with **one
  pre-existing flake** in `control-database-solo-warm-start.spec.ts` (see below).
- `yarn lint` at repo root — clean.

**Pre-existing flake, reported not papered over.** `control-database-solo-warm-start.spec.ts`
(added three commits ago by `solo-warm-start-blocks-on-prior-cohort-peers`, untouched by this
ticket) fails intermittently under full-suite parallel load — a different case each run, always a
wall-clock timeout on the spec's own hard-coded 15s/30s control-op budgets, never an assertion.
It passes 6/6 in isolation in 32s, and the same 6 cases take 155s inside the full suite. Recorded
in `tickets/.pre-existing-error.md` for the runner's triage pass; not in
`tickets/.pre-existing-known.md`, and not covered by
`tickets/implement/port-solo-warm-start-to-published-smoke.md`, which names the file but is about
porting it to the published-install smoke script. No test was skipped, disabled, or loosened.

Note for whoever runs this next: `../quereus` is being edited concurrently. If the suite fails on
"Stale build detected", rebuild `@quereus/quereus` first.

## Downstream

- `28.2-formation-use-number-ripple` (implement) — the web reference app and e2e fixtures still
  read the dropped column in SQL strings and `row.X as number` casts, invisible to build and lint.
- `28.5-formation-concurrent-redemption-e2e` (implement) — the cross-node over-admission this
  design accepts, exercised against a real multi-node cluster.
