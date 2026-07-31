description: Added the small building blocks needed for a joining peer to prove it agreed to join a network — a new tag for that kind of signature, the exact bytes the joiner signs, and a checker that re-verifies a stored signature. Nothing in the codebase calls these yet, so this change is inert on its own.
files: packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-authorization.spec.ts
difficulty: easy
----

# Formation consent — additive signing helpers (implemented)

Landed exactly the additive pieces specced in the implement ticket, no more:

- `control-authorization.ts` — `ControlAction` gained `'consent'`; doc comment above
  it (the bullet list explaining `'add'`/`'remove'`/`'vouch'`/`'publish'`) extended
  with a `'consent'` bullet distinguishing it from `'vouch'` (self-signed by the
  joiner's own key vs. the approver's sign-off over the same table).
- `control-database.ts` — `formationConsentMessage(fields)` added right after its
  sibling `formationVouchMessage`, same shape (`buildAuthorizationMessage` over the
  `'CadreControl.FormationUsage'` domain, `'consent'` action, ordered field vector
  `[token, usageStampId, peerKey, disclosure]`).
- `peer-authorization.ts` — `formationConsentDigest` (base64url digest, mirrors
  `taggedDigest` usage of its siblings) and `verifyFormationConsent` (never-throws
  verifier, logs at debug on failure, same contract as `verifyCadrePeerVoucher`)
  appended at the end of the file.
- `index.ts` — exported `formationConsentMessage` from the control-database block,
  `formationConsentDigest` + `verifyFormationConsent` from the peer-authorization
  block.

## Test coverage added

`test/peer-authorization.spec.ts` gained one new `describe('verifyFormationConsent')`
block (mirrors the existing `verifyPeerAuthorization` round-trip test right above it):
generates a throwaway ed25519 seed, derives the public half via
`ed25519PublicKeyFromPrivate`, signs `formationConsentDigest(...)` over a fake
`{ token, usageStampId, peerKey, disclosure }` row, and asserts:
- `verifyFormationConsent` returns `true` against the joiner's own key/signature.
- `verifyFormationConsent` returns `false` when the row's `peerKey` is swapped for a
  different key (signature no longer matches the claimed identity).

This is the "optional cheap positive test" the implement ticket called out — a spec
file for this module already existed, so it was added rather than skipped. It is
deliberately narrow (one round-trip + one negative case); it does not exercise
malformed-input/garbage-key/tampered-signature paths the way
`verifyPeerAuthorization`'s block does. Those never-throws edge cases are the same
`verify(...)` call already covered structurally by the sibling functions' tests
(same `try/catch`, same `verify` call shape) — genuinely exhaustive negative coverage
for the consent path specifically is explicitly deferred to
`debt-formation-consent-tests-docs` (see `tickets/implement/12.5-...`), which already
plans an exhaustive matrix once the schema wiring (`12.1-debt-formation-consent-core`)
lands and there's a real write path to test end-to-end.

## Validation run

- `yarn build` (repo root): green.
- `yarn lint` (repo root): 0 errors (6 pre-existing warnings in an unrelated
  integration-tests scratch file, untouched by this change).
- `yarn workspace @serfab/cadre-core typecheck`: clean, no output.
- cadre-core unit suite (`yarn test` in `packages/cadre-core`), run BEFORE the test
  file addition: 81 files, 1265 passed, 1 skipped — confirms the additive production
  changes (nothing calls them yet) left the whole suite byte-for-byte green, per the
  ticket's design intent.

**Known gap in this handoff**: after adding the new `verifyFormationConsent` spec, a
final re-run of the full cadre-core suite hit `test-harness/build-freshness.ts`'s
stale-build guard — `@quereus/quereus: dist is stale — src was edited after the last
build`. This is a sibling workspace (`C:\projects\quereus`, linked in via
`resolutions`) that another concurrent process had uncommitted, in-flight edits in at
the time (`git status` there showed modified `packages/quereus/src/schema/catalog.ts`
and test files, changing between successive checks) — not anything this ticket
touched, and not a static defect: rebuilding on top of someone else's uncommitted
work would be the wrong move. In its place: `yarn workspace @serfab/cadre-core
typecheck` passed clean including the new spec file, and the new test is a
line-for-line structural mirror of the already-passing `verifyPeerAuthorization`
round-trip test directly above it in the same file (same signing helper pattern, same
assertion shape). Re-running `yarn test` in `packages/cadre-core` once the sibling
workspace's build settles should be a formality, not a real risk area — flagging it
so the reviewer can re-run rather than assume it was skipped.
