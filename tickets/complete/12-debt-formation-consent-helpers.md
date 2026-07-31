description: Added the small building blocks needed for a joining peer to prove it agreed to join a network — a new tag for that kind of signature, the exact bytes the joiner signs, and a checker that re-verifies a stored signature. Nothing calls them yet; the review pass expanded their tests and filled in the missing "why" comments.
files: packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-authorization.spec.ts
difficulty: easy
----

# Formation consent — additive signing helpers (complete)

Landed exactly the additive pieces the implement ticket specced, plus the review pass's
inline fixes. All of it is inert until `debt-formation-consent-core` wires the schema
and the callers.

- `control-authorization.ts` — `ControlAction` gained `'consent'`, with a doc bullet
  distinguishing it from `'vouch'`: the joiner self-signs with its own key, the
  approver signs off over the same table with a different one.
- `control-database.ts` — `formationConsentMessage(fields)` beside its sibling
  `formationVouchMessage`: `buildAuthorizationMessage` over the
  `'CadreControl.FormationUsage'` domain, `'consent'` action, field vector
  `[token, usageStampId, peerKey, disclosure]`.
- `peer-authorization.ts` — `formationConsentDigest` (the base64url twin of that
  vector) and `verifyFormationConsent` (never-throws verifier, debug-logged on
  failure, same contract as `verifyCadrePeerVoucher`).
- `index.ts` — all three exported.

## Review findings

**Design conformance — checked, no findings.** Held the diff against the settled design
in `debt-formation-consent-core` (which is explicitly marked do-not-re-open): the field
vector, its order, the `'consent'` action tag, the choice of the joiner's Ed25519 public
key rather than a libp2p peer-id string, and the deliberate omission of `StrandId` all
match. The `StrandId` omission looked like an asymmetry with the vouch sibling on first
read and is not one — it is a settled decision with a recorded rationale.

**Comments — two real gaps, both fixed in this pass.**
- `formationConsentMessage`'s doc named the schema constraint `FormationUsage.PeerConsented`
  as though it existed. It does not yet; a reader grepping the schema for it finds
  nothing. Reworded to say the helpers land ahead of that constraint and of every caller.
- Neither helper explained why `strandId` is absent while the vouch sibling binds it —
  the single most likely thing for a future reader to mistake for an oversight. Pulled
  the rationale in from the settled design (the joiner cannot know the strand when it
  signs; the responder cannot substitute one, since a bound invite is pinned by
  `Authorized` and an unbound redemption mints a fresh strand). `formationConsentDigest`'s
  doc now points at that one home rather than restating it.

**Tests — one real gap, fixed in this pass.** The implementer's single test was honest
about being narrow. Rewrote the block into nine focused cases sharing a signing helper
and a `beforeEach` fixture, matching the `verifyPeerAuthorization` block above it:
round-trip, wrong key, a mutation matrix over each signed field (`token`,
`usageStampId`, `disclosure`), tampered signature, malformed signature / empty
signature / garbage key all returning `false` without throwing, and two cases that were
missing outright and are the ones worth having:

- **Action-tag disjointness** — an approver's `'vouch'` signature presented as the
  joiner's `PeerSig` is rejected. That disjointness is the entire reason `'consent'` is
  a separate action, and nothing exercised it.
- **Twin agreement** — signing `formationConsentMessage`'s raw bytes and verifying
  through `formationConsentDigest`'s base64url form. One field vector is mirrored in two
  modules with nothing tying them together; if either drifts, every real consent fails
  closed *without throwing*, which a type-check cannot see. This was the only genuine
  correctness risk in the diff and it is now pinned.

**Source hygiene — checked, no findings.** `peer-authorization.ts` is 259 lines and the
new functions are short and single-purpose. `control-database.ts` is 1684 lines and this
added 21, which is not this ticket's problem to solve. No dead code, no `any`, no eaten
exceptions (both catch arms log), nothing to clean up — the helpers are pure functions
with no resources to release.

**Docs — checked, nothing to update.** No file under `docs/` enumerates the
`ControlAction` values, so adding `'consent'` created no drift. `docs/api.md`'s
FormationUsage vouch-digest description is stale only with respect to the *wiring*
(`peerId` → `peerKey`), which `debt-formation-consent-tests-docs` already owns.

**Major findings — none, so no new tickets were filed.** Everything a reviewer would
reach for here is already owned: the exhaustive schema- and protocol-level negative
matrix and the doc updates are `debt-formation-consent-tests-docs`, the schema and
caller wiring is `debt-formation-consent-core`. Filing anything else would duplicate
them.

**Tripwires — none recorded, deliberately.** The one concern that could have been parked
as conditional — two copies of one field vector in two modules — is not conditional. It
is wrong the moment either copy is edited, so it got a test instead of a comment.

**Pre-existing failures — none.** No `.pre-existing-error.md` written. The
implementer's handoff flagged that its final test run was blocked by the
`test-harness/build-freshness.ts` stale-build guard tripping on the linked sibling
workspace `C:\projects\quereus`, whose `src` had been edited after its last build. That
is an environment condition, not a failing test: it was cleared by running the guard's
own printed remedy (`yarn workspace @quereus/quereus build` in that repo — a build
artifact, nothing in that repo's source touched or reverted), after which every suite
ran. The implementer's untested spec addition does pass.

## Validation run

All from a clean state after the sibling rebuild:

- `yarn build` (repo root): green.
- `yarn lint` (repo root): 0 errors. 6 warnings, all pre-existing unused
  `eslint-disable` directives in `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`,
  untouched by this change.
- `yarn workspace @serfab/cadre-core typecheck`: clean. Note this does *not* cover test
  files today (see `tickets/plan/16-debt-widen-typecheck-to-test-files.md`), so the spec
  was validated by running it, not by type-checking it.
- cadre-core unit suite (`yarn test` in `packages/cadre-core`): 81 files,
  **1274 passed, 1 skipped** — the implementer's 1265 plus the nine consent cases, with
  every other suite unchanged, as expected for a change nothing calls yet.
