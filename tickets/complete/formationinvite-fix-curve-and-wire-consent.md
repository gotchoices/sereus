description: COMPLETE — FormationInvite ed25519 curve fix + the now-live FormationInvite/FormationUsage consent path (ControlDatabase insert/redeem methods, DB-backed ControlFormationUsageRecorder, harness wiring). Reviewed adversarially; lint + cadre-core tests green; two follow-up tickets filed.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/integration-tests/src/harness/test-network.ts, docs/architecture.md
----

The implement stage fixed the `FormationInvite` ed25519 curve bug and made the
`FormationInvite`/`FormationUsage` consent path live end-to-end in `ControlDatabase`:
authority-signed invite insert, atomic redemption (Strand + FormationUsage in one
transaction, authority-signature-free consent branch of `Strand.Authorized`),
usage-only recording against a pre-existing strand, a DB-backed
`ControlFormationUsageRecorder`, and harness wiring. Two latent `FormationUsage`
schema bugs were discovered + fixed in the process. See the implement handoff for the
full landing description.

## Review findings

### Verified (read the implement diff first, fresh, before the handoff)

- **Curve fix (the ticketed defect).** `FormationInvite.AuthorizedAddOrRemove` now
  verifies `verify(digest(context.StampId,'sha256','utf8'), context.Signature, A.Key,
  'ed25519')`. Confirmed the missing `'sha256','utf8'` digest args and the `'ed25519'`
  curve are both present, in BOTH schema copies, byte-identically. Independently
  confirmed against the crypto plugin source that `verify()`'s curve defaults to
  **secp256k1** (`@optimystic/quereus-plugin-crypto/src/crypto.ts:236`), so the
  explicit `'ed25519'` is load-bearing, not cosmetic — the pre-fix verify silently
  rejected every real ed25519 authority signature. The `control-schema-drift` guard
  passes (the two copies are byte-identical).

- **`committed.*` semantics (FormationUsage `Monotonic` fix).** Verified directly in
  the Quereus source that `committed.<Table>` is a real pseudo-schema
  (`schema-resolution.ts:13` `COMMITTED_SCHEMA`, `reference.ts`/`scan.ts` plumb
  `_readCommitted`, `vtab/memory/table.ts:242` reads `conn.readLayer` rather than the
  pending layer), so it excludes the in-flight row. Verified that a CHECK containing a
  subquery auto-defers (`constraint-builder.ts` `containsSubquery`/`containsCommittedRef`
  → `needsDeferred`), and there is a regression test (`43-transition-constraints.sqllogic`)
  exercising a `committed.*` deferred CHECK. The implementer's diagnosis (plain
  `from FormationUsage` would count the new row itself at commit, making `max+1`
  unsatisfiable, so the first redemption could never succeed) is correct, and the fix
  is the right one. The empirical proof is the green `UseNumber=1` redemption test on
  the real optimystic backend.

- **`FormationUsage.Authorized` ValidationUrl fix.** The old
  `digest(new.Token, new.Disclosure)` passed `Disclosure` as the *algorithm* arg and
  base64url-decoded `Token`, throwing on a normal token string before the `OR`
  short-circuit could spare it. New shape `verify(digest(new.Token || new.Disclosure,
  'sha256','utf8'), context.ValidationSignature, context.ValidationKey, 'ed25519')` is
  utf8-input (never throws on arbitrary strings), binds token‖disclosure, and pins the
  curve. Confirmed this conflicts with **nothing already landed**: the related
  `strand-formation-disclosure-not-transmitted` ticket (already in complete/) states
  "nothing is signed at the transport layer," so the ValidationUrl/validation-signature
  crypto is unimplemented everywhere and this is a forward-looking correction. The
  ValidationUrl path itself remains unexercised (see Open gaps).

- **DB methods / recorder / harness / tests.** `insertFormationInvite`,
  `redeemInvitation` (explicit `begin → 2 execs → commit`, with a rollback that
  swallows only the post-failed-commit "no transaction active" no-op and re-throws the
  real cause — preserves the original error, does not eat it), `recordFormationUsage`,
  read helpers, `ControlFormationUsageRecorder`, and the harness `createInvitation`/
  `joinStrand` wiring all read cleanly and match the schema. The signer signs the raw
  sha256 bytes (`digest(stampId,'sha256','utf8','bytes')`) while the schema verifies
  over `digest(...)`'s default base64url-string output decoded back to those same
  bytes — consistent (and the happy-path insert test proves it).

### Checks run

- `yarn workspace @serfab/cadre-core test` → **24 files, 314 tests pass** (handoff said
  311; count grew, all green), including the new `control-formation-invite.spec.ts` (8
  tests) and the drift guard.
- `eslint` on all changed files → **0 errors**, 7 warnings, all **pre-existing**
  (the `control-database.ts` `any`/`preserve-caught-error` warnings are at line numbers
  shifted down by the new `parseStoredDatetimeMs` helper; the `test-network.ts`
  unused-import/arg warnings are in helper code the diff never touched).
- `yarn workspace @serfab/integration-tests typecheck` → **passes** (harness change
  compiles against the built dist).

### Found — minor, noted (not fixed; low risk, would be risky to change blind)

- **`ControlFormationUsageRecorder.recordUsage` inserts a Strand** (it delegates to
  `redeemInvitation`, which creates the Strand row). The `FormationUsageRecorder`
  contract is invoked from `StrandSolicitationService.recordFormationComplete`, whose
  doc says it runs "after strand provisioning." If a future caller wires this recorder
  into a flow where the strand is *also* provisioned separately (authority-signed),
  the second Strand insert PK-collides. Currently **latent**: the recorder is only
  exercised by its own unit test (no prior strand), and the harness deliberately uses
  the record-only `recordFormationUsage` path instead. This is the consent-creates-strand
  vs provision-then-record ambiguity flagged in the handoff's Gap 3; it belongs to the
  recorder-wiring work (`reference-app-rn-discovered-strand-join` /
  `reference-app-rn-closed-strand-consent-demo`), which should pick one model explicitly.

- **Fail-open expiry parse.** `queryFormationInvite` maps a `NaN` parsed `ExpiresAt`
  to `null` (= never expires), so a malformed stored datetime would read as a
  perpetually-valid invite. Extremely unlikely (Quereus canonicalizes the `datetime`
  on insert) and the recorder re-checks expiry in JS, but the direction is fail-open.
  Left as-is to avoid a risky behavior change in a review pass; flagged for awareness.

### Found — major, filed as follow-up tickets

- **`tickets/fix/formationinvite-signature-row-bind-single-use.md`** — Gap 1: the
  `FormationInvite` authority signature is a BARE STAMP (signs only `digest(StampId)`,
  `StampId` is a context value not a unique column), so it is transplantable onto a
  different invite row and replayable — unlike the row-bound + single-use scheme the
  other privileged tables already use. Real residual weakness; matches the originating
  ticket's deliberately-minimal scope. Filed to harden it.

- **`tickets/backlog/formation-provision-sappid-not-threaded.md`** —
  `StrandFormationManager.provisionAsResponder` calls `provisionStrand('', …)` with an
  empty `sAppId`, discarding the sApp identity the invitation carries. Nominally
  "tracked by" this slug (per the disclosure ticket) but never touched by the consent
  DB work; no current path breaks (all provisioners ignore the arg), so backlogged.

### Docs

- `docs/architecture.md` updated inline (this pass) to note `ControlFormationUsageRecorder`
  as the DB-backed `FormationUsageRecorder` and the now-live insert/atomic-redeem path.
  The table descriptions of `FormationInvite`/`FormationUsage` and the formation
  sequence diagram were already accurate (no contradiction) — only this addition was
  needed. No other doc actively contradicts the change.

### Not run (out of band — unchanged from handoff)

- The multi-node libp2p integration suite (`@serfab/integration-tests` happy-path /
  multi-party-sync / strand-creation) is **not agent-runnable** (needs real networks)
  and was not executed. The harness DB writes are local to the inviter's control DB
  (deterministic, same pattern as the already-working `createStrand`→`insertStrand`),
  so risk is contained but unverified. **CI/human: run
  `yarn workspace @serfab/integration-tests test`.**

## Net assessment

The implementation is solid and the handoff was honest. Three schema edits are
correct and well-justified; the DB/recorder/harness code is clean with proper
transaction and error handling; tests, lint, and typecheck are green. No blocking
defects. Two real follow-ups filed (signature hardening; sAppId threading) and two
minor items noted. Curve fix + consent path: **done, reviewed, green.**
