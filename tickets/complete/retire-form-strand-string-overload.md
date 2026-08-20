description: One function used to accept two different kinds of argument because an older way of calling it was kept working. Only the newer way was ever used for real, so the older one is gone and the function now has a single, honest signature.
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/src/cadre-node.ts, docs/api.md, docs/architecture.md
difficulty: easy
---

# Legacy string arm of `StrandSolicitationService.formStrand` — retired

## Outcome

`StrandSolicitationService.formStrand` takes `invitation: OpenInvitation` only. The
`OpenInvitation | string` union, the `typeof invitation === 'string'` ternary, and the
`typeof invitation !== 'string' && node` guard are gone; the guard is now `if (node)` and
the token binding is `const token = invitation.token;`. `CadreNode.formStrand`
(`cadre-node.ts:5442`) was already `OpenInvitation`-typed and forwards unchanged.

The **no-`node` placeholder-strandId fallback** at the end of `formStrand` was deliberately
left in place — `node` is still optional and the two nodeless specs still exercise it. Its
removal is a separate question, tracked as backlog `debt-form-strand-nodeless-placeholder`.

## Review findings

**Checked:** the implement diff read cold before the handoff summary; the full current body of
`formStrand`; the `CadreNode` forwarder; every `formStrand` reference across `packages/` and
`docs/` (grep, 90+ hits); leftover `OpenInvitation | string` unions repo-wide; whether
`decodeInvitation` actually reconstructs `expiration` as a `Date` (it does —
`cadre-node.ts:5481` — so the newly-mandatory `OpenInvitation` is honest at runtime, not just
at compile time); test coverage of the changed paths; the backlog ticket the handoff claims
covers the deferred work (it exists).

**Major — none.** Stated with a reason rather than as a pass: the diff is a compile-time
narrowing whose runtime path is mechanically identical for every real caller (each already
passed an object, so `token` resolved to `invitation.token` before and after; the
real-protocol branch already required `node` to be truthy). The proof that no caller broke is
the type-check across all five consuming workspaces, not a behavioral test — and it passes.

**Minor — three found, all fixed in this pass:**

- `docs/api.md:56` still documented the *retired* signature —
  `formStrand(token: string, disclosure: object): { memberKey, invitePrivateKey }`. That is
  precisely the legacy shape this ticket removed, so the change would have shipped with the
  public API doc advertising the dead arm. Replaced with the real signature (`invitation`,
  `disclosure`, optional `node`) and the real `FormStrandResult` (it also omitted `strandId`
  and `memberPrivateKey`, stale independently of this ticket).
- `docs/architecture.md:568` — the strand-formation sequence diagram labelled its arrow
  `formStrand(token, disclosure)`. Now `formStrand(invitation, disclosure)`, consistent with
  the prose two sections earlier (`architecture.md:522`) which was already correct.
- DRY, `packages/cadre-core/test/strand-solicitation.spec.ts` — the implementer replaced two
  string literals with three near-identical seven-line `OpenInvitation` literals whose fields
  no assertion reads. Collapsed into one `nodelessInvitation(token)` helper at file scope,
  named for the path it serves. The real-protocol cases further down the file build their
  invitations from `createOpenInvitation` and were left alone.

**Tripwires — none recorded.** Nothing in the diff is of the "fine now, becomes work if X"
shape; the change strictly removes a branch rather than deferring one.

**New tickets — none filed.** No finding survived that needed one, and no site in the diff
was already claimed by an open ticket (checked `tickets/{backlog,fix,plan,implement,review}`
for `strand-solicitation`; the only hit is the pre-existing
`debt-form-strand-nodeless-placeholder`, which covers scope this ticket correctly declined).

**Accepted-tradeoff `NOTE:`s at the touched sites — none present**, so nothing was
re-litigated.

**Explicitly not a finding:** `packages/cadre-core/dist/strand-solicitation.d.ts:231` still
declares the old `OpenInvitation | string` union. It is a stale build artifact and is
gitignored (`git check-ignore` confirms `.gitignore:2:dist/`); it is regenerated on build.

**No new tests added, with a reason.** The change is a type narrowing — the behavior it
removes is unreachable from TypeScript, so no runtime test can assert it is gone. The
compile-time equivalent (all five workspaces type-checking against the narrowed signature)
is the coverage, and it is exercised. The pre-existing nodeless specs continue to cover the
fallback branch, and the real-protocol branch is covered by the eight `node`-passing cases
later in the same spec file.

## Verification

Run in this review pass, after the fixes above:

- `yarn workspace @serfab/cadre-core typecheck` — pass.
- `yarn lint` (repo-wide) — pass.
- `yarn workspace @serfab/cadre-core test` — 104 files, 1644 passed / 1 skipped. The single
  skip is pre-existing and unrelated to strand formation.

Not re-run, deliberately: the `reference-app-rn`, `reference-app-web` and `integration-tests`
type-checks. The implementer ran all three clean, and this review's edits touch only two
markdown files and one `cadre-core`-internal spec — nothing those packages compile against.

**Known residual gap (unchanged from the handoff):** `integration-tests` is a real-network
libp2p suite; its scenarios were type-checked but not executed in either pass. Five of them
call `formStrand` through the changed signature. Runtime confidence there needs that suite
run out-of-band — it is multi-minute and not agent-runnable inside a ticket.
