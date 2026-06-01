----
description: Integration tests assert on TODO stubs and never cover RBAC or schema-signature rejection on a real strand
files: packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/scenarios/happy-path.integration.ts, packages/integration-tests/src/scenarios/multi-party-sync.integration.ts, packages/integration-tests/src/fixtures/index.ts
----
Sereus's `integration-tests` package is meant to give real, cross-package, real-network confidence that control-network-driven invitation/join, cross-cadre synchronization, signed-write RBAC, and ed25519 sApp schema verification actually work end to end. Several of the currently-green scenarios instead assert against fabricated harness state, and the authorization and schema-rejection paths have no integration coverage at all. The result is false confidence: the suite passes while the very guarantees it appears to exercise are never driven through real code.

## Stubbed harness methods drive fake assertions

`TestCadreNetwork`'s invitation/join/sync surface is explicitly stubbed with `TODO`s rather than wired to the control network:

- `createInvitation` returns a fabricated `invite-${Date.now()}-...` token without ever inserting into the `FormationInvite` table via `ControlDatabase` (`packages/integration-tests/src/harness/test-network.ts:139`).
- `joinStrand` does nothing but `strand.parties.push(joiner.partyId)`; the documented real steps (insert `FormationUsage`, insert the `Strand` row in the joiner's control network, wait for the strand instance to start) are left as a `TODO` (`packages/integration-tests/src/harness/test-network.ts:166-172`).
- `waitForControlSync` does not query any control database for convergence; it just `await sleep(100)` as a placeholder (`packages/integration-tests/src/harness/test-network.ts:186-189`).

`happy-path.integration.ts` and `multi-party-sync.integration.ts` build their assertions entirely on this fake state — e.g. asserting `expect(strand.parties).toHaveLength(2)` against the array the stub mutated — so they verify the stub, not the system. `multi-party-sync.integration.ts` never reads or writes a single row despite its name. These scenarios give false confidence that control-network-driven invitation/join and cross-cadre sync work when none of that path is exercised.

## RBAC has zero integration coverage

The only fixture that encodes authorization constraints is `SIMPLE_SAPP_LOGIC`, whose schema carries `context.MemberKey` / `context.Signature` `verify()` checks (`packages/integration-tests/src/fixtures/index.ts:24-43`). It is consumed solely by the stubbed happy-path scenario. Every real-strand scenario (the multi-party-workflows, convergence-stress, and strand-formation-e2e families) uses auth-free schemas. Consequently signed-write authorization has no integration coverage: no test drives an authorized signed write and asserts it is accepted, and no test drives an unauthorized write and asserts it is rejected. The central consent/RBAC promise is untested at the integration level.

## Schema-signature rejection has no integration coverage

No integration scenario exercises the ed25519 sApp schema-verification rejection path. Every `addStrand` caller passes a correctly-signed config; none passes a tampered, unsigned, or wrong-key `SAppConfig` to assert that strand creation/join is refused. The only signature-rejection coverage in the suite is `cadre-host-update-notify`, which concerns update-release signing rather than sApp schema verification on a real strand.

## Dead fixture surface

`wrapSAppSchema`, `loadSimpleSApp`, and `simple-sapp.qsql` are never used (`packages/integration-tests/src/fixtures/index.ts:15-17,58-60`). This dead surface implies a schema-application flow the tests were intended to exercise but do not, reinforcing that the membership/RBAC and schema-application paths are unverified.

## Expected behavior

The harness invitation/join/sync methods should be replaced with real control-network-driven implementations: `createInvitation` inserts a `FormationInvite` row via `ControlDatabase`, `joinStrand` records `FormationUsage`, inserts the `Strand` row in the joiner's control network, and waits for the strand instance to start, and `waitForControlSync` queries each node's control database for actual convergence rather than sleeping. If a given scenario is genuinely not intended to cover those paths, it must be clearly marked as such rather than asserting against fabricated state. In addition, the suite must grow integration coverage for signed-write RBAC — an authorized signed write accepted and an unauthorized write rejected on a real strand using a fixture with `verify()`-gated constraints — and for sApp schema-signature rejection on a real strand, driving tampered, unsigned, and wrong-key `SAppConfig`s through the real creation/join path and asserting refusal. Unused fixture surface should either be wired into these new scenarios or removed.

## Key references

- `packages/integration-tests/src/harness/test-network.ts:139,166-172,186-189` — stubbed `createInvitation` / `joinStrand` / `waitForControlSync`.
- `packages/integration-tests/src/scenarios/happy-path.integration.ts`, `multi-party-sync.integration.ts` — scenarios asserting on fabricated harness state.
- `packages/integration-tests/src/fixtures/index.ts:24-43,15-17,58-60` — `SIMPLE_SAPP_LOGIC` RBAC fixture (used only by the stubbed path) and the dead `wrapSAppSchema` / `loadSimpleSApp` / `simple-sapp.qsql` surface.
- Related tickets: `sapp-schema-signature-gate-bypassable` (overlaps on the missing schema-signature negative-path integration coverage), `strand-membership-rbac-schema-not-applied` (the production-side reason RBAC is not enforced on a live strand), and `formationinvite-wrong-curve-and-unwired` (the production-side reason the real invitation/join path is not yet reachable).
