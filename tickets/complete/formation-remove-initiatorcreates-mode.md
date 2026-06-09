description: Removed the dead `initiatorCreates` 3-message formation mode and collapsed the now-single-value `FormationMode`/`mode` discriminator out of the native cadre-core strand-formation transport, manager, and solicitation layer. Only the implicit `responderCreates` 2-message flow survives.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts
----

# Complete: remove the `initiatorCreates` formation mode

## Summary

The unreachable `initiatorCreates` provisioning mode and the entire `mode` discriminator
(which had collapsed to the single value `responderCreates`) were removed from the native
cadre-core formation transport. The discriminator was eliminated outright rather than left
as a single-value union: there is no `FormationMode` symbol anywhere in cadre-core. The
sole, now-implicit flow is `responderCreates` (2 messages): the responder provisions (or,
under provision-then-record, resolves + records consent against) the strand and returns the
result on approval.

Removed surface: `FormationMode` type, `FormationDatabaseMessage` interface,
`FormationDialOptions.mode` / `.provisionStrand`, `FormationListenerOptions.validateDatabaseResult`,
`FormationResponseValidator.validateDatabaseResult`, and the `mode` field on `validateToken`'s
return type — plus the corresponding `index.ts` re-exports and the `initiatorCreates` branches in
`FormationListener.runSession` and `dialFormation`.

## Review findings

### Diff correctness (verified against `git show b0f6bb9`)
- **No vestigial single-value type.** Confirmed `FormationMode` is fully gone from cadre-core
  — no type, import, export, or `mode:` field. Grep over `packages/` for `FormationMode`,
  `initiatorCreates`, `FormationDatabaseMessage`, `validateDatabaseResult` returns hits ONLY in
  the deprecated `strand-proto/` package (and its own README/docs), which is out of scope.
- **`provisionResult` guard survived the branch collapse.** `dialFormation` still throws
  `'Missing provision result for responderCreates mode'` on `approved === true` with no
  `provisionResult` (`strand-formation-protocol.ts:411`).
- **Disclosure-timing invariants unchanged.** All four non-disclosing rejection paths (invalid
  token, invalid disclosure, concurrency cap, post-validation provisioning rejection) plus the
  approval path are intact; `getResponderIdentity()` is still read only on the approval path.
- **`wroteFrame` defense-in-depth intact.** `runSession`'s catch still writes a non-disclosing
  internal-error frame only when no frame went out, and re-throws (does not eat) the error.
- **No downstream breakage.** `cadre-core` builds clean; grep confirms no consumer outside the
  deprecated package referenced any removed symbol.

### Tests
- **Pre-existing spec checked** for happy path, the rejection matrix, post-validation rejection,
  and the internal-error conversion — all on the responder/listener side and all green.
- **Coverage gap closed (minor, fixed inline).** The implementer flagged that the dialer's
  `provisionResult` guard — now the *only* guard carrying that invariant — had no unit test.
  Added a `dialFormation provision-result invariant` describe block with three tests: returns the
  responder-provisioned strand on approval, **throws on approved-but-resultless** (the flagged
  guard), and throws on a responder rejection. Used the existing `MockStream` plus a small
  `dialNode` helper (mock `dialProtocol`). Suite now **353/353** (was 350).

### Docs
- **Correctly reflect the new reality, no change needed.** `docs/architecture.md` "Strand
  Formation" describes the native transport with **no** mode discriminator already (the apparent
  grep hit there is a false positive on "provision-then-record **mod**el"). `docs/strand-proto.md`
  and `docs/STATUS.md:147` describe the *deprecated* `@serfab/strand-proto` package (distinct
  protocol id, 3-message flow on a NEW stream) and were correctly left untouched.

### Other angles (SPP / DRY / cleanup / error handling / type safety)
- No dead imports or unused locals left behind (build + eslint clean). `stepTimeoutMs` is still
  used (await-contact); `ResponderProvisionOutcome` still used.
- The retained error string `'Missing provision result for responderCreates mode'` and the
  `responderCreates` naming throughout (`isValidResponderCreatesResult`, doc comments) are a
  deliberate, consistent name for the sole flow, **not** a vestige of the removed discriminator —
  left as-is. Not asserted by any test, so no fragility.

## Validation performed (all green)

- `yarn workspace @serfab/cadre-core build` (tsc) — exit 0.
- `yarn workspace @serfab/cadre-core test` — **353/353** across 28 files.
- `npx eslint packages/cadre-core/src packages/cadre-core/test` — exit 0.

## Disposition

No major findings; no new fix/plan/backlog tickets filed. The one minor finding (dialer guard
coverage) was fixed inline in this pass.
