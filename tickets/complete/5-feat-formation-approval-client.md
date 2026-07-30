description: A party's node can now ask an outside approval service whether a would-be joiner may join, and check the answer it gets back. Nothing calls it yet — hooking it into the join flow is a separate ticket.
files: packages/cadre-core/src/formation-approval.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, docs/api.md, docs/architecture.md, docs/STATUS.md
----

# Complete: formation approval client (types, HTTP transport, sign/verify)

## What shipped

**`packages/cadre-core/src/formation-approval.ts`** — the client side of an invitation's
`ValidationUrl`: the request/answer types, an HTTP transport, and the two digest helpers. Nothing
in the redemption path calls it; wiring is `feat-formation-approval-wiring`.

- `FormationApprovalRequest` — the five fields the approver signs (`token`, `usageStampId`,
  `strandId`, `peerId`, `disclosure`) plus `validationUrl` (where to ask; not signed).
- `FormationVouchFields` — the five signed fields alone (`Omit<FormationApprovalRequest,
  'validationUrl'>`). This is the posted body, and what an approver types its request as.
- `FormationApproval` — `{ validationKey, validationSignature }`.
- `FormationApprover` — the one-method interface the transport implements.
- `FormationApprovalError` with `failure: 'refused' | 'unavailable' | 'malformed' |
  'misconfigured'`; exported from the package index for the wiring ticket to switch on.
- `signFormationApproval(fields, validationKey, privateKeyB64)` and
  `verifyFormationApproval(fields, approval)`. Both build their bytes through
  `formationVouchMessage` (from `control-database.ts`), never a hand-written field list, so the
  client and the SQL `FormationUsage.Authorized` check cannot drift.
- `createHttpFormationApprover({ timeoutMs = 10_000, fetchImpl })` — `POST`s the five fields as
  JSON, `redirect: 'error'`, aborts via `AbortController` (timer covers the body read), 64 KiB
  response cap, releases any body it declines to read. Global `fetch` + `AbortController` only,
  no `node:` imports.

**Dead surface removed** (reachable only from its own unit test, and its two-argument shape could
not produce a signature the database accepts): `StrandSolicitationService.validateStrandFormation`,
`FormationSigner`, `StrandSolicitationServiceOptions.formationSigner`, `ValidateFormationResult`,
the `FormationSigner` index export, and the corresponding `describe` block. Repo-wide grep at
review time confirms zero remaining references outside `tickets/`.

**Docs.** `docs/api.md` → "Validate Strand Formation (approval hook)" is the hook operator's
integration surface: who contacts the hook and why, the request/response JSON, a status→outcome
table, operational notes, what the hook is trusted with, what the signature covers, and a runnable
Express example. `docs/architecture.md` no longer advertises `validateStrandFormation`.
`docs/STATUS.md` carries a gap bullet for the unredeemable-`ValidationUrl`-invite state.

## Review findings

### Checked

Read the implement diff (`dfcc9d1`) cold — source, tests, and docs — before the handoff summary.
Verified the dead-surface removal repo-wide by grep (`validateStrandFormation`,
`ValidateFormationResult`, `FormationSigner`, `formationSigner`: zero hits outside `tickets/`), and
confirmed nothing but `control-database.ts` accepts a `validationKey`/`validationSignature` today.
Scrutinised digest agreement between client and SQL, resource cleanup (abort timers, stream
readers, sockets), error-path categorisation, type soundness of the public surface, cross-platform
constraints, and source hygiene (477 lines, small single-purpose functions, no oversized
function). Read `docs/api.md`, `docs/architecture.md`, `docs/STATUS.md`, and `docs/strands.md`
against the new reality rather than trusting them.

### Minor — fixed in this pass

- **Undrained response body leaked a connection on every failure decided from the status line.**
  A `403`, a `500`, a followed redirect, and the declared-oversize rejection all threw before
  reading a byte, leaving the body un-consumed — which keeps a socket checked out until GC. A node
  asking a flapping hook once per redemption would accumulate them. Added `discardBody()` and a
  `readApproval()` wrapper that releases the body on every rejecting path (skipping a body already
  locked by the streaming reader, which cancels its own). Two tests assert the cancel actually
  fires, on the status path and on the content-length path.
- **`signFormationApproval` / `verifyFormationApproval` demanded a field an approver never
  receives.** Both took a full `FormationApprovalRequest`, including `validationUrl` — but a hook
  is posted only the five signed fields, so the documented Express example had to lie about its
  request body with an unsound cast. Widened both helpers to `FormationVouchFields`, exported that
  type from the module and the package index, and fixed the doc example. A redeeming node holding a
  whole request still passes it straight in. The `Omit` derivation stays (rather than an
  `extends`), so a field added to the request still breaks the build until it is consciously routed
  into or out of the digest.
- **A duplicate signer in the database spec, and the missing end-to-end link.**
  `control-formation-invite.spec.ts` had its own `vouch()` helper assembling the same signature by
  hand. Rewired it through `signFormationApproval`, which removes the duplication *and* closes the
  gap the handoff listed second: the ~20 `Authorized` cases in that spec (including the
  vary-one-digest-field-at-a-time set) now sign with the shipped client helper and feed the result
  to the real `recordFormationUsage`, so the client's bytes are pinned as the bytes the database
  accepts.
- **The no-body-reader fallback was untested.** The React Native path (`Response.body` has no
  `getReader`) was reachable in production but never exercised — only the `content-length` branch
  touched it. Added two cases against a reader-less response: one accepting a valid approval, one
  rejecting an oversized body.
- **`timeoutMs: 0` silently broke every request.** A zero, negative, or `NaN` timeout armed an
  abort that fired before the request left, presenting a fine hook as permanently down.
  `createHttpFormationApprover` now rejects a non-positive or non-finite `timeoutMs` at
  construction as `misconfigured`; three cases pin it.
- **Docs read as though the hook were live.** `docs/api.md` described the contract with no
  indication that nothing contacts a hook yet — and the consequence is sharper than "unwired": an
  invitation carrying a `ValidationUrl` cannot be redeemed *at all* right now, because the database
  requires an approver signature the responder never asks for. Added an explicit note saying so,
  naming the two follow-on tickets. Added the matching gap bullet to `docs/STATUS.md`'s
  cross-party-formation section, which otherwise read as fully working. Also added what a hook is
  trusted with (it sees the disclosure text and the invitation token — a bearer credential, so a
  hook is party infrastructure, not a public endpoint), and pointed the signature section at
  `signFormationApproval` ahead of `formationVouchMessage`.

### Major — one new ticket

- `backlog/debt-formation-approval-real-fetch-coverage` — every transport test injects a stub
  `fetch`. Three behaviours the client branches on are the platform's to decide, not ours: whether
  `redirect: 'error'` rejects or resolves with `redirected === true`, how an abort during the body
  read surfaces, and how a real socket interacts with the 64 KiB early bail. Both branches are
  handled in code, but only the stub's behaviour is pinned. The ticket asks for a throwaway
  in-process HTTP server driven by the real global `fetch`.

No other major findings. The remaining item from the handoff's own gap list — a hook that
under-declares its `content-length` is still counted for real by the streaming byte count — is a
deliberate, documented trade-off with no defect behind it.

### Tripwires (recorded, not ticketed)

- `formation-approval.ts` `readCappedText` — `NOTE:` that on the no-reader path the cap is enforced
  only after the runtime has buffered the whole body, so an under-declaring hook can make that
  runtime hold an arbitrary amount. Harmless where it applies (React Native clients are not
  formation responders); needs a real streaming read only if a responder ever runs on such a
  platform.
- `formation-approval.ts` `FormationApprover.requestApproval` — `NOTE:` that there is no
  caller-supplied `AbortSignal`; the transport's own timeout is the only cancellation. Matters only
  if the responder gains a way to cancel a formation in flight.

### Gates

From `packages/cadre-core`, all green after the fixes above:

- `npx tsc -p tsconfig.typecheck.json --noEmit` — clean.
- `yarn build` — clean.
- `npx eslint` over every touched file, from the repo root — clean.
- `npx vitest run` — **72 files, 1133 passed, 1 skipped** (was 1126 passed; +7 from this pass). The
  single skip is `key-store.spec.ts`'s `it.skipIf(process.platform === 'win32')` POSIX file-mode
  case — a platform guard, not a disabled failure, and unrelated to this ticket.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written. The
handoff's note about the sibling `../quereus` stale-build guard did not recur.
