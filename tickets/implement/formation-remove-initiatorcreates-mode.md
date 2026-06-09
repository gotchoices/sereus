description: Remove the dead, unreachable `initiatorCreates` 3-message formation mode (and its now-single-value `FormationMode`/`mode` discriminator) from the native strand-formation transport, manager, and solicitation layer. `responderCreates` is the only mode any caller can select; the initiator-provisions branches are unreachable dead surface whose eventual N-party use case is designed differently (new-stream-per-responder) anyway.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts
----

# Remove the `initiatorCreates` formation mode

## Decision (resolved in plan)

The plan ticket asked: cover `initiatorCreates` with an end-to-end test + make it
reachable, OR remove it. **Decision: remove it.**

Rationale:
- **No production caller and no concrete near-term use case.** `StrandFormationManager.validateToken`
  hardcodes `mode: 'responderCreates'`, and nothing else ever returns `initiatorCreates`. The path
  in `dialFormation` (`provisionStrand` callback branch), `FormationListener.runSession`
  (`await-database` branch + `validateDatabaseResult` hook), and
  `createDefaultFormationResponseValidator().validateDatabaseResult` is dead with zero coverage.
- **The architecture assumes the responder/authority provisions.** Provision-then-record,
  `ResolvedHostStrand` (unbound/bound/missing), and `FormationUsage` (deferred `StrandExists`
  CHECK) are all built around the responder minting/recording the strand. There is no
  consent-recording path for an initiator-created strand, so making `initiatorCreates`
  reachable would be a feature, not a test.
- **The only forward-looking reference is a deprecated doc that designs it differently.** The
  N-party roadmap in `docs/strand-proto.md` ("Extending to N-Party Bootstrap") describes the
  initiator-provisions leg as **new-stream-per-responder** — the opposite of the current
  same-stream echo. If N-party formation ever lands it will be redesigned, not reuse this code.
- Per AGENTS.md ("Don't worry about backwards compatibility yet", small single-purpose units),
  removing unused surface is defensible; git history preserves the implementation.

Because only `responderCreates` survives, the `mode` discriminator becomes a single-value union
(jank per AGENTS.md). **Collapse it entirely** rather than leaving `FormationMode = 'responderCreates'`:
drop the `mode` field from `validateToken`'s return, from `FormationDialOptions`, and from the
manager call site.

## Surface to remove

### `packages/cadre-core/src/strand-formation-protocol.ts`
- Module doc comment (the "Two provisioning modes are preserved…" paragraph, ~lines 11–16):
  reduce to describe the single `responderCreates` flow (responder provisions and returns the
  result, 2 messages).
- `FormationMode` type (~line 53) and the `FormationParty`-adjacent mode doc: **remove** the type.
  (Keep `FormationParty` — `createdBy: FormationParty` is still used.)
- `FormationDatabaseMessage` interface (~lines 118–122): **remove** (only `initiatorCreates` uses it).
- `FormationResultMessage.provisionResult` (~lines 114–115): **keep**; simplify the
  "Present for `responderCreates` mode." comment to "The provisioned strand/db result." since
  it is now always present on approval.
- `FormationListenerOptions.validateToken` (~line 242): change return type from
  `{ valid: boolean; mode: FormationMode }` to `{ valid: boolean }`.
- `FormationListenerOptions.validateDatabaseResult?` (~lines 255–256): **remove**.
- `FormationListener.runSession` (~lines 357–381): remove the `if (tokenResult.mode === 'responderCreates')`
  wrapper and inline its body as the only path; **delete** the `initiatorCreates` branch (the
  approve-without-result + `await-database` read + `validateDatabaseResult` call, ~lines 376–381).
- `runSession` catch comment (~lines 382–394): update — drop the `initiatorCreates`/"second frame
  after the approval" references. **Keep** the `wroteFrame` guard and the re-throw as
  defense-in-depth (do not silently eat the error); just retire the mode-specific wording.
- `FormationDialOptions.mode` (~line 405) and `FormationDialOptions.provisionStrand?`
  (~lines 409–410): **remove** both.
- `dialFormation` (~lines 425, 445–458): remove `const mode = …`; remove the
  `if (mode === 'responderCreates')` wrapper (always responderCreates → always return
  `response.provisionResult`, throwing if absent); **delete** the `initiatorCreates`
  provision-locally + echo-`FormationDatabaseMessage` branch.

### `packages/cadre-core/src/strand-formation-manager.ts`
- Remove the `type FormationMode` import (~line 22).
- `validateToken` (~lines 196–215): change signature to `Promise<{ valid: boolean }>`; drop the
  `const mode: FormationMode = 'responderCreates'` and the `mode` field from every return.
- `formStrand` `dialFormation` call (~line 165): remove the `mode: 'responderCreates'` option.

### `packages/cadre-core/src/strand-solicitation.ts`
- Remove the `type FormationDatabaseMessage` import (~line 19) if it becomes unused.
- `FormationResponseValidator.validateDatabaseResult?` (~lines 143–148): **remove**.
- `createDefaultFormationResponseValidator().validateDatabaseResult` (~lines 165–168): **remove**;
  update the function doc comment (~line 157) to drop the `validateDatabaseResult` sentence.

### `packages/cadre-core/src/index.ts`
- Remove `type FormationMode` and `type FormationDatabaseMessage` from the
  `strand-formation-protocol.js` re-export block (~lines 134, 138).

### `packages/cadre-core/test/strand-formation-protocol.spec.ts`
- `baseOptions.validateToken` (~line 84): change `async () => ({ valid: true, mode: 'responderCreates' })`
  to `async () => ({ valid: true })`.
- The invalid-token override (~line 104): change `{ valid: false, mode: 'responderCreates' }` to `{ valid: false }`.
- Everything else in this spec already exercises only `responderCreates` and should pass unchanged.

## Edge cases & interactions

- **No vestigial single-value type.** After removal there must be NO `FormationMode` symbol
  anywhere (type, import, export, or `mode:` field). Grep `FormationMode`, `initiatorCreates`,
  `FormationDatabaseMessage`, and `validateDatabaseResult` across `packages/` (excluding
  `strand-proto/` and `docs/`) and confirm zero hits in non-doc source.
- **`provisionResult` invariant on the dialer.** With the mode branch gone, `dialFormation`
  must still throw `'Missing provision result for responderCreates mode'` (or an equivalent
  message) when `response.approved === true` but `response.provisionResult` is absent — do not
  drop that guard when collapsing the branch.
- **Disclosure-timing guarantees are unchanged.** The four rejection paths (invalid token,
  invalid disclosure, concurrency cap, post-validation provisioning rejection) and the
  approval path must still behave exactly as the existing spec asserts. The `getResponderIdentity()`
  must still be read ONLY on the approval path (identity-not-disclosed-on-rejection tests stay green).
- **`wroteFrame` defense-in-depth stays.** The internal-error→non-disclosing-rejection conversion
  in `runSession`'s catch must remain (it still guards the `responderCreates` provisioning throw,
  covered by the "converts an unexpected provisioning throw…" test). Only the comment wording changes.
- **Docs.** Update `docs/strand-proto.md`'s "Mode: initiatorCreates" section and
  `docs/STATUS.md` line ~147 ("3-message flow (`initiatorCreates`, new stream)") only if they
  describe the *native* transport; if they describe the deprecated `strand-proto` package, leave
  them (that package is deprecated and out of scope). Confirm before editing — do not churn
  deprecated-package docs.
- **No downstream consumers break.** `cadre-host`, `cadre-cli`, `reference-app-*`, and
  `integration-tests` do not reference `FormationMode`/`FormationDatabaseMessage`/`initiatorCreates`
  (verified: their `mode:` usages are `addStrand`/`strandFilter` modes). A successful
  `cadre-core` typecheck + build is the gate.

## Validation

- `yarn workspace @serfab/cadre-core build` (tsc) — must pass with no unused-symbol or
  missing-type errors.
- `yarn workspace @serfab/cadre-core test` — stream output with `tee`; the formation specs
  (`strand-formation-protocol.spec.ts`, `strand-solicitation.spec.ts`) must pass.
- `yarn lint` (or the cadre-core-scoped lint) — no new violations.
- If any failure surfaces that is plainly pre-existing / outside this diff, follow the
  `tickets/.pre-existing-error.md` flagging protocol rather than chasing it here.

## TODO

- [ ] `strand-formation-protocol.ts`: remove `FormationMode`, `FormationDatabaseMessage`,
      `validateDatabaseResult?`, `FormationDialOptions.mode`, `FormationDialOptions.provisionStrand?`;
      collapse the `runSession` and `dialFormation` mode branches to the single `responderCreates`
      path; update module + catch comments.
- [ ] `strand-formation-manager.ts`: drop `FormationMode` import; narrow `validateToken` to
      `{ valid: boolean }`; remove `mode: 'responderCreates'` from the `dialFormation` call.
- [ ] `strand-solicitation.ts`: remove `validateDatabaseResult` from the
      `FormationResponseValidator` interface and `createDefaultFormationResponseValidator`;
      drop the now-unused `FormationDatabaseMessage` import; update the doc comment.
- [ ] `index.ts`: drop `FormationMode` and `FormationDatabaseMessage` re-exports.
- [ ] `strand-formation-protocol.spec.ts`: update the two `validateToken` mocks to omit `mode`.
- [ ] Grep-confirm zero remaining `initiatorCreates` / `FormationMode` / `FormationDatabaseMessage`
      / `validateDatabaseResult` hits in non-deprecated, non-doc `cadre-core` source.
- [ ] Build + test + lint cadre-core (stream output); flag any pre-existing failure per protocol.
