description: One function still accepted two different kinds of argument because an older way of calling it was kept working. Only the newer way is used for real, so the older one has been dropped and the function now has a single, honest signature.
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/src/cadre-node.ts
difficulty: easy
---

# Legacy string arm of `StrandSolicitationService.formStrand` — dropped

## What changed

`packages/cadre-core/src/strand-solicitation.ts`:
- `formStrand`'s `invitation` parameter is now `OpenInvitation` only (was `OpenInvitation | string`).
- `const token = invitation.token;` replaces the `typeof invitation === 'string'` ternary.
- The real-protocol guard is now just `if (node)` (was `if (typeof invitation !== 'string' && node)`).
- `@param invitation` doc no longer says "(or just token for legacy API)".
- The comment above the guard reworded from "If we have a full invitation and a node" to "If we have a node" — the invitation is always full now, only `node` is optional.

`packages/cadre-core/test/strand-solicitation.spec.ts`: the two string-token cases
(`'test-token'`, `'token-1'`/`'token-2'`) now build a real `OpenInvitation` literal
(`token`, `sAppId`, `expiration`, `bootstrap: []`) and pass no `node` — same as before,
they exercise the no-`node` placeholder-strandId fallback at the end of `formStrand`,
which is untouched and out of scope (tracked separately, see below).

## What was NOT touched (by design)

- **No-`node` placeholder path** — "Fallback: placeholder strandId (for testing without
  network)" at the end of `formStrand`. Stays reachable; `node` is still optional. Its
  removal is tracked as backlog `debt-form-strand-nodeless-placeholder`, per the original
  ticket's explicit scope note.
- `CadreNode.formStrand` (`cadre-node.ts:5442`) was already `OpenInvitation`-typed and
  simply forwards — confirmed unchanged, no edit needed there.

## Verification performed

- `yarn workspace @serfab/cadre-core typecheck` — pass.
- `yarn workspace @serfab/reference-app-rn typecheck` — pass (was already passing
  `OpenInvitation`, confirmed no-op as the ticket predicted).
- `yarn workspace @serfab/reference-app-web typecheck` — pass (same).
- `yarn workspace @serfab/integration-tests typecheck` — pass, including the
  `ReturnType<CadreNode['formStrand']>` type-gymnastics call sites in
  `strand-formation-e2e.integration.ts`, `strand-formation-concurrent-redemption.integration.ts`,
  `rbac-signed-write.integration.ts`, `multi-party-workflows.integration.ts`.
- `yarn workspace @serfab/cadre-core test` — 104 files, 1644 passed / 1 skipped (pre-existing
  skip, unrelated).
- `yarn lint` (repo-wide) — pass.
- Repo-wide grep for `formStrand(` confirmed every remaining call site (integration-tests,
  reference-app-web, reference-app-rn, cadre-node.ts, strand-formation-manager.spec.ts) already
  passes an `OpenInvitation` object, not a bare string.

## Gaps / things the reviewer should know

- Verification was typecheck + unit tests + lint only. `integration-tests` is a real-network
  suite (per the original ticket, "may be too slow to run in full") — its **type-check** ran
  clean but its actual test scenarios were not executed in this pass. If the reviewer wants
  runtime confidence on the five scenarios that call `formStrand` through the changed signature,
  that suite would need to be run separately (real libp2p network, likely multi-minute).
- No behavior change intended or observed beyond the signature/guard simplification — the
  `token` value flowing into the log line and consent digest is identical for the `node`-present
  path (previously `invitation.token` when non-string; now always `invitation.token`).
