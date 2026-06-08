description: The native formation transport's `initiatorCreates` 3-message mode is fully implemented but unreachable through the public API (the manager hardcodes `responderCreates` and `validateToken` always returns it) and has no wire-level test. Decide whether to cover it with an end-to-end test or remove it as dead surface.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts
----

# Cover or remove the `initiatorCreates` formation mode

## Context

The native strand-formation transport (`strand-formation-protocol.ts`) preserves two
provisioning modes from the deprecated `strand-proto`:

- `responderCreates` (2 messages) — responder provisions and returns the strand. **This is
  the only mode wired through the public API.** `StrandFormationManager.formStrand` passes
  `mode: 'responderCreates'`, and the listener's `validateToken` hook always returns
  `{ valid, mode: 'responderCreates' }`.
- `initiatorCreates` (3 messages) — responder approves, the initiator provisions locally and
  echoes the strand/db back on the same live stream, the responder validates the echo. This
  path exists in `dialFormation` (the `provisionStrand` callback branch) and in
  `FormationListener.runSession` (the `await-database` branch + `validateDatabaseResult` hook),
  plus `createDefaultFormationResponseValidator().validateDatabaseResult`, but **nothing ever
  selects it**, so it is dead code with no coverage.

The implementer deliberately kept the db echo on the *same* stream (unlike strand-proto, which
opened a fresh stream and lost session correlation). That design is plausibly correct but
entirely unverified.

## Decision required

Pick one:

1. **Cover it.** Add an end-to-end test (mirroring `strand-formation-protocol.spec.ts`'s
   mock-stream harness, or a two-node libp2p test) that drives a full `initiatorCreates`
   exchange: responder approves without a `provisionResult`, initiator provisions and writes a
   `FormationDatabaseMessage`, responder's `validateDatabaseResult` runs and the session
   completes. Then expose a way for callers to actually request the mode (token-validation
   result, manager option, or invitation field) so it is reachable — otherwise the test only
   exercises a path no production caller can hit.

2. **Remove it.** Drop the `initiatorCreates` branches from `dialFormation`,
   `FormationListener.runSession`, the `FormationMode` union's second member, the
   `validateDatabaseResult` hooks, and `createDefaultFormationResponseValidator`'s
   `validateDatabaseResult`. Per AGENTS.md ("Don't worry about backwards compatibility yet",
   small single-purpose units), removing unused surface is defensible until a concrete
   initiator-provisions use case lands.

This is a future concern (the active formation flow works and is tested via `responderCreates`),
hence backlog rather than fix/plan.
