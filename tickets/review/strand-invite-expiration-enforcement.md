description: A strand invitation's expiry date was recorded but never checked, so expired invites could still be used to join. Expired invites are now rejected at join time, with the on-engine schema check as the authority and the off-engine pre-flight kept in sync.
prereq:
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/test/strand-membership-invite.spec.ts
difficulty: medium
----

# Review: enforce `Strand.Invite.Expiration` at consume + in the join pre-flight

## What the bug was

`Invite.Expiration` was canonicalised, folded into the issuance signature, and stored — but
no code path ever compared it against the current time. An invite with a past `Expiration`
was fully consumable, indefinitely. The issuance signature only binds `Expiration` against
tampering; it does not reject a past expiry.

## What was implemented

A deferred `NotExpired` check on `Strand.ConsumedInvite`, mirroring the proven control-layer
`CadreControl.FormationUsage.Authorized` expiry gate, plus the off-engine pre-flight parity:

1. **Schema (both byte-equivalent copies)** — `schemas/strand.qsql` and the embedded
   `STRAND_SCHEMA` in `packages/quereus-plugin-sereus/src/strand-schema.ts`:
   - Added `constraint NotExpired check on insert (exists (select 1 from Invite I where
     I.Key = new.InviteKey and (I.Expiration is null or I.Expiration > context.Now)))` to
     `ConsumedInvite`.
   - Added `Now datetime null` to `ConsumedInvite`'s `with context (...)`.
   - `NotExpired` has a subquery, so (like `ValidUsage`) it auto-defers to commit and rolls
     back the whole consume txn — neither `Member` nor `ConsumedInvite` survives an expired
     redemption.

2. **Writer `consumeInvite`** (`strand-membership-writer.ts`):
   - Added optional `nowMs?: number` to `ConsumeInviteParams` (default `Date.now()`), so
     tests can pin the comparison instant (control `redeemInvitation` convention).
   - Computes `nowCanonical = await canonicalDatetime(db, nowMs ?? Date.now())` — the SAME
     transform `issueInvite` uses to store `Invite.Expiration` — and passes it as `Now` on
     the `ConsumedInvite` insert context. Both sides of `I.Expiration > context.Now` are then
     byte-identical canonical strings, so the lexical `>` orders chronologically at any
     granularity.

3. **Pre-flight parity** (`strand-member-registry.ts` `StrandMemberVerifier.isAuthorizedToJoin`):
   - Filters expired invites out of the "door is open" count:
     `select count(1) ... from Strand.Invite where Expiration is null or Expiration > ?`
     with `canonicalDatetime(this.db, Date.now())`. Imported `canonicalDatetime`.
   - The `consumed > 0` short-circuit above it is unchanged.

### Why `context.Now` is canonical here, not ISO (intentional divergence from control)

The control writer passes `context.Now` as a JS ISO string (`new Date(ms).toISOString()`).
Quereus does NOT type-coerce context params (only column values), so an ISO `Now`
(`...T...000Z`) is compared lexically against the canonical, space-separated
`datetime`-coerced `Expiration` — they differ at position 10 (`'T'` vs `' '`) and in the
suffix, so near-same-instant timestamps can mis-order. The control tests only use
far-future/far-past expiries, so that latent skew never bites there. The strand layer uses
`canonicalDatetime` for `Now` so both sides match exactly. This divergence is documented in
code comments in `consumeInvite` and the schema constraint, NOT "fixed" in the control layer
(out of scope).

## ONE deviation from the implement ticket — please scrutinize

The ticket's proposed `NotExpired` comment used backtick-quoted SQL snippets
(`` `>` ``, `` `FI.ExpiresAt is null or FI.ExpiresAt > context.Now` ``). `STRAND_SCHEMA` is a
JS **template literal** (backtick-delimited), so those backticks terminated the string and
broke the build (`TS1005`). I replaced the backticks with double quotes in **both** schema
copies (`">"`, `"FI.ExpiresAt is null or FI.ExpiresAt > context.Now"`), preserving meaning and
keeping the two copies byte-identical. This is verified two ways: a `diff` of the
`ConsumedInvite` blocks is identical, and the automated `strand-schema-drift.spec.ts` guard
passes. No backticks may ever appear in `STRAND_SCHEMA` comments — worth a reviewer note for
future schema edits.

## Tests added (`test/strand-membership-invite.spec.ts`)

All pin the instant via `nowMs` with a fixed `base = Date.UTC(2031, 2, 4, 12, 0, 0)`:

- **Past-expiry rejected + atomic rollback** — `expiration: base`, consume at `base + 1 day`
  → rejects; `Member` stays 1, `ConsumedInvite` stays 0.
- **Future-expiry succeeds** — `expiration: base + 1 day`, consume at `base` → `Member` = 2,
  `ConsumedInvite` = 1.
- **Boundary rejected** — `expiration: base`, consume at `base` → rejected (`>` is strict;
  expiry instant is exclusive, matching control).
- **Null-expiry still consumable (regression)** — no `expiration`, consume with a `nowMs` set
  → succeeds (adding the `Now` context never breaks the never-expires path).
- **`isAuthorizedToJoin` expiry filtering** — expired-only invite → `false`; future-expiry
  invite → `true`; null-expiry invite → `true`.

## Validation run (all green)

- `yarn workspace @serfab/cadre-core typecheck` → exit 0.
- `yarn workspace @serfab/cadre-core test` → **532 passed (39 files)**.
- `yarn workspace @serfab/quereus-plugin-sereus build` → OK (rebuild required — cadre-core
  imports the plugin via `dist/`, so the `STRAND_SCHEMA` edit must be built before tests see
  it; a stale `dist/` initially made the new tests fail against the OLD schema).
- `yarn workspace @serfab/quereus-plugin-sereus test` → **60 passed | 1 todo (7 files)**,
  including the schema drift guard and the schema-application e2e.
- `yarn lint` → exit 0.

## Reviewer focus / known gaps (treat my tests as a floor)

- **Build-before-test coupling.** The schema lives in the plugin's `dist/`. Any future schema
  edit needs a plugin rebuild before cadre-core tests reflect it. If CI runs cadre-core tests
  without first building the plugin, it could test a stale schema. Worth confirming CI builds
  the plugin first (the drift guard at least catches source/source divergence, but not
  source-vs-stale-dist).
- **Pre-flight is advisory, not authoritative.** `isAuthorizedToJoin` uses wall-clock
  `Date.now()` and is a "door is open" hint; the on-engine `NotExpired` gate is the real
  enforcement. There is an inherent TOCTOU window (an invite could expire between the
  pre-flight read and the commit) — acceptable because the on-engine gate is authoritative,
  but noted so it isn't mistaken for a second enforcement point. The pre-flight tests use
  far-past/far-future expiries to avoid wall-clock flakiness.
- **Fail-closed null-`Now` path is not directly tested.** The schema treats a null `Now` as
  fail-closed for set-expiry invites (`Expiration > null` → unknown → `exists` fails →
  rejected) while null-expiry invites still pass. The writer ALWAYS supplies `Now`, so this
  is only a defensive default and has no production caller exercising it. A reviewer wanting
  belt-and-suspenders could add a raw `insert into ConsumedInvite ... with context Now = null`
  schema-level test; I judged it out of scope since no code path produces a null `Now`.
- **Single-use PK gap is independent and unchanged.** The pre-existing "KNOWN GAP" double-
  consume test uses a null-expiry invite and still pins the platform's overwrite behavior —
  unaffected by this change (verified: it passes). Expiry enforcement applies regardless of
  whether PK-uniqueness is enforced.
- **Integration scenario not executed here.** `strand-membership-closed-strand-e2e.integration.ts`
  uses null-expiry invites (so it is unaffected), but it is a real-network integration test
  not part of the agent-run suite — not exercised in this ticket's validation.
