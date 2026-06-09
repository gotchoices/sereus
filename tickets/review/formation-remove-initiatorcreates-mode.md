description: Review the removal of the dead `initiatorCreates` 3-message formation mode and the collapse of the now-single-value `FormationMode`/`mode` discriminator from the native cadre-core strand-formation transport, manager, and solicitation layer. Verify only `responderCreates` survives, no vestigial single-value type remains, and disclosure-timing / provision-result invariants are unchanged.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts
----

# Review: remove the `initiatorCreates` formation mode

## What was done

The dead, unreachable `initiatorCreates` provisioning mode was removed from the native
cadre-core formation transport, and the `mode` discriminator (which collapsed to a
single value, `responderCreates`) was eliminated entirely rather than left as a
single-value union. `responderCreates` is now the only — and implicit — flow: the
responder provisions (or, under provision-then-record, resolves + records consent
against) the strand and returns the result on approval.

### Changes by file

**`strand-formation-protocol.ts`**
- Module doc: the "Two provisioning modes are preserved…" paragraph reduced to describe
  the single 2-message `responderCreates` flow.
- `FormationMode` type: **removed** (the `// ── Roles / modes ──` header is now `// ── Roles ──`).
  `FormationParty` kept (`createdBy: FormationParty` still used).
- `FormationDatabaseMessage` interface: **removed**.
- `FormationResultMessage.provisionResult`: kept; comment simplified to "The provisioned
  strand/db result (always present on approval)."
- `FormationListenerOptions.validateToken`: return type narrowed `{ valid: boolean; mode: FormationMode }`
  → `{ valid: boolean }`.
- `FormationListenerOptions.validateDatabaseResult?`: **removed**.
- `FormationListener.runSession`: the `if (tokenResult.mode === 'responderCreates')` wrapper
  removed and its body inlined as the only path; the `initiatorCreates` branch (approve-without-result
  + `await-database` read + `validateDatabaseResult`) **deleted**. The `wroteFrame`
  defense-in-depth guard + re-throw **kept**; only the mode-specific comment wording retired.
- `FormationDialOptions.mode` and `.provisionStrand?`: **removed**.
- `dialFormation`: `const mode = …` and the `if (mode === 'responderCreates')` wrapper removed
  (always returns `response.provisionResult`); the `initiatorCreates` provision-locally +
  echo-`FormationDatabaseMessage` branch **deleted**. The
  `throw new Error('Missing provision result for responderCreates mode')` guard **kept**.

**`strand-formation-manager.ts`**
- `FormationMode` import dropped.
- `validateToken` signature narrowed to `Promise<{ valid: boolean }>`; the
  `const mode: FormationMode = 'responderCreates'` and all `mode` return fields dropped.
- `mode: 'responderCreates'` removed from the `dialFormation` call in `formStrand`.

**`strand-solicitation.ts`**
- `FormationDatabaseMessage` import dropped (now unused).
- `FormationResponseValidator.validateDatabaseResult?` method removed from the interface.
- `createDefaultFormationResponseValidator().validateDatabaseResult` impl removed; doc
  comment's `validateDatabaseResult` sentence dropped.

**`index.ts`**
- `type FormationMode` and `type FormationDatabaseMessage` removed from the
  `strand-formation-protocol.js` re-export block.

**`strand-formation-protocol.spec.ts`**
- The two `validateToken` mocks updated to omit `mode`
  (`{ valid: true }` / `{ valid: false }`). No other test changed.

## Validation performed (all green)

- `yarn workspace @serfab/cadre-core build` (tsc) — **exit 0**, no unused-symbol / missing-type errors.
- `yarn workspace @serfab/cadre-core test` — **350/350 passed** across 28 files.
- `npx eslint packages/cadre-core/src packages/cadre-core/test` — **exit 0**, no new violations.
  (cadre-core has no package-scoped `lint` script; the root `yarn lint` is `eslint .`.)
- Grep across `packages/` (and `integration-tests/`, `tess/`) for `FormationMode`,
  `initiatorCreates`, `FormationDatabaseMessage`, `validateDatabaseResult`: **zero hits** in
  non-deprecated, non-doc source. Remaining hits are all in the deprecated `strand-proto/`
  package and the docs that describe it.

## Review focus / things to double-check

- **No vestigial single-value type.** Confirm there is NO `FormationMode` symbol anywhere in
  cadre-core (type, import, export, or `mode:` field). The decision was to collapse the
  discriminator entirely, not leave `FormationMode = 'responderCreates'`.
- **`provisionResult` invariant on the dialer.** `dialFormation` must still throw
  `'Missing provision result for responderCreates mode'` when `response.approved === true` but
  `response.provisionResult` is absent. Verify the guard survived the branch collapse (it did —
  see `dialFormation`). Note: this throw path is **not** directly covered by a unit test in
  `strand-formation-protocol.spec.ts` (the spec exercises `isValidResponderCreatesResult` and
  the listener side, not a dialer with an approved-but-resultless response). A reviewer wanting
  belt-and-suspenders could add a `dialFormation` unit test with a mock stream that returns
  `{ approved: true }` and no `provisionResult` — flagged as a known coverage gap, not a regression.
- **Disclosure-timing guarantees.** The four rejection paths (invalid token, invalid disclosure,
  concurrency cap, post-validation provisioning rejection) plus the approval path are covered by
  the existing spec and pass unchanged. `getResponderIdentity()` is still read ONLY on the
  approval path (the `identityDisclosed()` assertions stay green).
- **`wroteFrame` defense-in-depth.** The internal-error→non-disclosing-rejection conversion in
  `runSession`'s catch is retained and still covered by the "converts an unexpected provisioning
  throw…" test. Only comment wording changed. Confirm the catch still re-throws (does not eat
  the error) — it does.
- **Docs deliberately left unchanged.** `docs/strand-proto.md` and `docs/STATUS.md:147` describe
  the *deprecated* `@serfab/strand-proto` package (protocol id `/sereus/bootstrap/1.0.0`,
  `initiatorCreates` on a NEW stream), not the native cadre-core transport, so per the ticket
  they were left untouched. Confirm this judgement holds if the reviewer reads those docs.

## Known gaps / honest notes

- No new tests were added — the change is a pure removal of dead surface, and the existing
  formation spec already exercised only `responderCreates`. The one untested code path that now
  carries the sole `provisionResult` guard is the dialer's missing-result throw (see above);
  consider adding a small unit test there if the reviewer wants the floor raised.
- `strand-solicitation.spec.ts` was not modified (it never referenced the removed surface); it
  passes as part of the full 350-test run but was not individually re-inspected for
  `initiatorCreates` assumptions beyond the grep sweep (which found none).
