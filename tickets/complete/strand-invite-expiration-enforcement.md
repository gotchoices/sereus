description: A strand invitation's expiry date was recorded but never checked, so expired invites could still be used to join. Expired invites are now rejected at join time, enforced on the database engine with an off-engine pre-flight kept in sync.
prereq:
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, docs/architecture.md
difficulty: medium
----

# Complete: enforce `Strand.Invite.Expiration` at consume + in the join pre-flight

## What shipped

A strand invite's `Expiration` was previously stored and folded into the issuance signature
but **never compared against the current time**, so a past-expiry invite was indefinitely
consumable. Enforcement now lives in three coordinated places:

1. **On-engine gate (authoritative)** — a deferred `ConsumedInvite.NotExpired` check in both
   byte-equivalent schema copies (`schemas/strand.qsql`, `STRAND_SCHEMA` in
   `packages/quereus-plugin-sereus/src/strand-schema.ts`):
   `exists (select 1 from Invite I where I.Key = new.InviteKey and (I.Expiration is null or I.Expiration > context.Now))`,
   plus `Now datetime null` added to `ConsumedInvite`'s `with context`. Like `ValidUsage`, the
   subquery auto-defers to commit, so an expired redemption rolls back the whole txn (neither
   `Member` nor `ConsumedInvite` survives).

2. **Writer `consumeInvite`** (`strand-membership-writer.ts`) — optional `nowMs?` (default
   `Date.now()`), canonicalised via `canonicalDatetime` (the SAME transform `issueInvite` uses
   for `Expiration`) and passed as `context.Now`, so both sides of `I.Expiration > context.Now`
   are byte-identical canonical strings and the lexical `>` orders chronologically at any
   granularity. This **intentionally diverges** from the control layer, which passes an ISO
   `Now` (see Review findings).

3. **Off-engine pre-flight** (`StrandMemberVerifier.isAuthorizedToJoin`) — filters expired
   invites from the "door is open" count using the same canonical-`Now` comparison.

## Review findings

### Method
Read the implement diff (`2c6693f`) before the handoff summary. Re-derived the canonical-vs-ISO
datetime comparison from first principles; cross-checked the control-layer reference
(`schemas/control.qsql` `FormationUsage.Authorized`, `control-database.ts` `redeemInvitation`/
`recordFormationUsage`). Verified schema-copy byte-equivalence, ran the full validation suite,
and audited call sites of `consumeInvite` / `isAuthorizedToJoin`.

### Correctness / design — verified sound
- **Lexical comparison.** Both `Expiration` (stored canonical) and `context.Now` (canonicalised
  by the writer) come from `datetime(?)`, identical fixed-format strings, so lexical `>` orders
  chronologically. Confirmed.
- **Atomicity.** `NotExpired` defers to commit alongside the existing circular `Member` ↔
  `ConsumedInvite` checks; rollback leaves neither row. Confirmed by the past-expiry test.
- **Idempotent canonicalisation.** `issueInvite` stores an already-canonical string into a
  `datetime` column (idempotent re-coercion); `context.Now` is canonical regardless of whether
  Quereus coerces typed context — robust either way.
- **Schema drift.** `ConsumedInvite` block is byte-identical across both copies; the
  `strand-schema-drift` guard passes. No backticks in `STRAND_SCHEMA` (it is a JS template
  literal) — a real hazard for future schema-comment edits, noted in code comments.
- **Pre-flight parity & TOCTOU.** `isAuthorizedToJoin` is advisory; the on-engine gate is
  authoritative. The TOCTOU window between pre-flight read and commit is acceptable for that
  reason. `StrandMemberRegistry.registerMember` calls `consumeInvite` without `nowMs` →
  defaults to `Date.now()`; correct.

### Major finding → new ticket filed
- **Control-layer same-UTC-day expiry mis-order.** The implementer documented (correctly, and
  out of scope here) that the control layer passes `context.Now` as a JS ISO string
  (`control-database.ts:716`, `:778`) compared lexically against canonical
  `FormationInvite.ExpiresAt`. The formats diverge at position 10 (`' '` vs `'T'`), so
  `ExpiresAt > Now` is **always false when the expiry falls on the same UTC calendar day as
  redemption** — a valid invite expiring later today is wrongly rejected. The strand layer
  avoids this by canonicalising `Now`; the control layer still carries the latent bug. Filed as
  **`control-invite-expiry-same-day-misorder`** (fix/) with a suggested fix and the regression
  test to add.

### Minor findings → fixed inline this pass
- **Test gap: the divergence was never exercised.** Every implementer test used `base ± 1 day`
  (different calendar days), so they would *also pass under the buggy ISO approach* — they never
  proved the canonical-`Now` choice matters. Added
  `admits a member with a same-UTC-day future expiry (canonical Now, not ISO)`
  (`strand-membership-invite.spec.ts`): expiry `base + 1h`, consume at `base`, same UTC date →
  must succeed. This is the discriminating regression guard (fails under ISO `Now`, passes under
  canonical).
- **Stale docs.** `docs/architecture.md` described `consumeInvite` and `isAuthorizedToJoin`
  without the new expiry enforcement. Updated `consumeInvite` to document the `NotExpired` gate /
  `nowMs` / canonical-`Now` divergence, and `isAuthorizedToJoin` to say "outstanding **unexpired**
  Invite".

### Not done — explicitly, with reasons
- **Fail-closed null-`Now` path** — schema treats a null `Now` as fail-closed for set-expiry
  invites; no production caller produces a null `Now` (the writer always supplies it), so it is a
  defensive default with no live exercise. Not worth a schema-level raw-insert test; agree with
  the implementer's out-of-scope call.
- **Single-use PK gap** (`optimystic-insert-pk-uniqueness-not-enforced`) — independent, pre-
  existing, unaffected; its KNOWN-GAP sentinel test still passes.
- **Integration scenario** (`strand-membership-closed-strand-e2e.integration.ts`) — uses
  null-expiry invites (unaffected) and is a real-network test outside the agent-run suite; not
  exercised here.

## Validation (all green, post-review-edits)
- `yarn workspace @serfab/cadre-core typecheck` → exit 0.
- `yarn workspace @serfab/quereus-plugin-sereus build` → OK (required first — cadre-core imports
  the plugin via `dist/`, so the `STRAND_SCHEMA` edit must be built before cadre-core tests see
  it).
- `yarn workspace @serfab/cadre-core test` → **533 passed (39 files)** (532 + the added
  same-day test).
- `yarn workspace @serfab/quereus-plugin-sereus test` → **60 passed | 1 todo (7 files)**
  (incl. schema-drift guard + schema-apply e2e).
- `yarn lint` → exit 0.

### Reviewer note for future schema edits
- **Build-before-test coupling.** The schema lives in the plugin's `dist/`; any future schema
  edit needs a plugin rebuild before cadre-core tests reflect it. CI must build the plugin before
  running cadre-core tests, or it could test a stale schema. The drift guard catches
  source-vs-source divergence, NOT source-vs-stale-dist.
