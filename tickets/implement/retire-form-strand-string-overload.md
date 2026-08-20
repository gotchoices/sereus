----
description: One function still accepts two different kinds of argument because an older way of calling it was kept working. Only the newer way is used for real, so the older one should be dropped and the function given a single, honest signature.
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/src/cadre-node.ts
difficulty: easy
----

# Drop the legacy string arm of `StrandSolicitationService.formStrand`

## What exists today

`StrandSolicitationService.formStrand` (`packages/cadre-core/src/strand-solicitation.ts:294`)
declares `invitation: OpenInvitation | string` and immediately narrows:

```ts
// Handle legacy API where just token was passed
const token = typeof invitation === 'string' ? invitation : invitation.token;
```

The `string` arm is the old call shape, kept working. It has two consequences beyond the extra
type: the real-protocol branch is guarded as `typeof invitation !== 'string' && node`, and the
doc comment advertises "(or just token for legacy API)" as part of the public contract.

Nothing real passes a string. `CadreNode.formStrand` (`cadre-node.ts:5442`) already types its
parameter as `OpenInvitation` and forwards it. Both reference apps go through `decodeInvitation`
and hand over a full `OpenInvitation`. The only string callers in the repo are three assertions in
`packages/cadre-core/test/strand-solicitation.spec.ts` (lines 38, 52, 53).

## What changes

- The parameter becomes `invitation: OpenInvitation`.
- `const token = invitation.token;`, and the "legacy API" comment goes.
- The real-protocol guard collapses from `typeof invitation !== 'string' && node` to `node`.
- The `@param invitation` doc drops "(or just token for legacy API)".

The three spec cases move to a real `OpenInvitation` literal — token, `sAppId`, a future
`expiration`, and a `bootstrap` array. They are exercising the **no-`node`** path (see below), so
`bootstrap: []` is fine; what they assert (a generated member key, a distinct key per call) is
unaffected by the argument shape.

## Explicitly not in scope

The **no-`node` placeholder path** at the end of `formStrand` — "Fallback: placeholder strandId
(for testing without network)", which fabricates `strand-<timestamp>-<random>` and returns it as a
real result. That is test scaffolding rather than a compatibility affordance, it stays reachable
after this change (`node` is still an optional parameter), and the three specs above are exactly
what depends on it. Removing it is a larger question about the solicitation service's test seam,
parked as backlog `debt-form-strand-nodeless-placeholder`. Do not fold it into this ticket.

## Edge cases & interactions

- **Two reference apps type-check in their own programs.** `reference-app-rn` and
  `reference-app-web` are separate workspaces; a signature change that compiles in `cadre-core`
  can still break them. Both were passing `OpenInvitation` at plan time, so this should be a
  no-op for them — verify it rather than assume it, by running each package's type-check.
- **`integration-tests` calls `formStrand` in five scenarios** (`multi-party-workflows`,
  `rbac-signed-write`, `strand-formation-concurrent-redemption`, `strand-formation-e2e`), several
  through `ReturnType<CadreNode['formStrand']>` type gymnastics that will re-resolve against the
  new signature. Type-check that package too; it is a real-network suite and may be too slow to
  run in full, but its type-check is not.
- **Do not "fix" the narrowing by widening elsewhere.** If a caller turns up that genuinely holds
  only a token, the correct move is to give it the `OpenInvitation` it should have had, not to
  restore the overload.
- **`invitation.token` is used before the real-protocol branch** (it feeds the log line and the
  consent digest). Confirm the single `token` binding still dominates every use after the edit.

## TODO

- Narrow the `formStrand` parameter to `OpenInvitation`; replace the ternary with
  `invitation.token`; collapse the real-protocol guard to `node`; update the `@param` doc.
- Update the three string-token cases in `packages/cadre-core/test/strand-solicitation.spec.ts`
  to build a real `OpenInvitation`.
- Grep `formStrand` across the repo for any remaining string argument.
- Run `yarn workspace @serfab/cadre-core test` and the type-checks for `@serfab/cadre-core`,
  `@serfab/reference-app-rn`, `@serfab/reference-app-web`, and `@serfab/integration-tests`.
- Run `yarn lint`.
