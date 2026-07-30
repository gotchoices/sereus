description: A party's node can now ask an outside approval service whether a would-be joiner may join, and check the answer it gets back. Nothing calls it yet — hooking it into the join flow is a separate ticket.
files: packages/cadre-core/src/formation-approval.ts (new), packages/cadre-core/test/formation-approval.spec.ts (new), packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-solicitation.spec.ts, docs/api.md, docs/architecture.md
difficulty: medium
----

# Review: formation approval client (types, HTTP transport, sign/verify)

## What shipped

**New module `packages/cadre-core/src/formation-approval.ts`.** Everything the *client* side of
an invitation's `ValidationUrl` needs — the request/answer types, an HTTP transport, and the two
digest helpers. Nothing is wired into the redemption path; that is
`feat-formation-approval-wiring`.

- `FormationApprovalRequest` — the five fields the approver signs (`token`, `usageStampId`,
  `strandId`, `peerId`, `disclosure`) plus `validationUrl` (where to ask; not signed).
- `FormationApproval` — `{ validationKey, validationSignature }`.
- `FormationApprover` — the one-method interface the transport implements.
- `FormationApprovalError` with `failure: 'refused' | 'unavailable' | 'malformed' |
  'misconfigured'`. Exported from the package index; the wiring ticket switches on it.
- `signFormationApproval(request, validationKey, privateKeyB64)` and
  `verifyFormationApproval(request, approval)`. Both build their bytes through
  `formationVouchMessage` (imported from `control-database.ts`), never a hand-written field
  list, so the client and the SQL `FormationUsage.Authorized` check can't drift.
- `createHttpFormationApprover({ timeoutMs = 10_000, fetchImpl })` — `POST` the five fields as
  JSON, `redirect: 'error'`, abort via `AbortController`, 64 KiB response cap. Global `fetch` +
  `AbortController` only; no `node:` imports.

**Dead surface removed** (was reachable only from its own unit test, and its two-argument shape
could not produce a signature the database accepts): `StrandSolicitationService.
validateStrandFormation`, `FormationSigner`, `StrandSolicitationServiceOptions.formationSigner`
and its field/assignment, `ValidateFormationResult` from `types.ts`, the `FormationSigner` index
export, and the `describe('validateStrandFormation')` block. Repo-wide grep confirms no other
caller in any package.

**Docs.** `docs/api.md` → "Validate Strand Formation (approval hook)" is now the hook operator's
integration surface: who contacts the hook and why, the request/response JSON, a
status→outcome table, operational notes (no redirects, 64 KiB cap, 10 s default, `http:`
permitted but clear-text), what the signature covers, and a runnable Express hook example
using `signFormationApproval`. `docs/architecture.md` line ~1189 no longer advertises
`validateStrandFormation`.

## How to validate

Gates run, all green, from `packages/cadre-core`:

- `npx tsc -p tsconfig.typecheck.json --noEmit` — clean.
- `yarn build` — clean.
- `npx eslint <the six touched files>` from the repo root — clean.
- `npx vitest run` (full cadre-core suite) — **72 files, 1126 passed, 1 skipped**. The single
  skip is pre-existing and unrelated.

Note: the first suite attempt tripped the stale-build guard on the sibling `../quereus`
workspace (`@quereus/quereus` dist older than its src). Fixed out-of-band with
`yarn --cwd C:/projects/quereus workspace @quereus/quereus build`. Not caused by this ticket; if
a reviewer hits it again, that is the remedy.

### Use cases the tests pin (`test/formation-approval.spec.ts`, 30 cases)

Digest helpers:

- sign → verify round-trip.
- verify returns **false** when each of the five signed fields is mutated **individually** —
  five separate cases, deliberately not combined, so a shared-prefix bug in the field encoding
  reddens exactly one of them.
- `validationUrl` differing does **not** break verification (it is outside the digest).
- `disclosure: ''` signs and verifies, and is not conflated with `' '`.
- a different approver key fails; garbage key/signature returns `false` rather than throwing.

HTTP transport (all with a stub `fetchImpl`):

- happy path: returns the approval, and the posted body is asserted to be **exactly** the five
  keys, with `disclosure` byte-identical to the input (unicode + trailing spaces in the
  fixture); method/headers/`redirect: 'error'`/`signal` all asserted.
- `http:` hook accepted (LAN case).
- `401` and `403` → `refused`; a `403` carrying a well-formed approval body is **still**
  `refused` (status decides, not body shape).
- `500` → `unavailable`; a rejected fetch → `unavailable` with the original error as `cause`;
  a rejected redirect → `unavailable`; a response with `redirected === true` → `unavailable`
  (covers runtimes that ignore `redirect: 'error'` instead of rejecting).
- non-JSON 200, `{}`, a JSON array, blank/missing/non-string fields → `malformed`.
- oversized body two ways: declared `content-length` over the cap (rejected without reading),
  and an undeclared 256 KiB stream (the test asserts the reader stopped early — `pulled <
  CHUNKS` — so the cap is a real early bail, not a post-hoc length check).
- `file:` URL and an unparseable URL → `misconfigured`, with the stub asserting **zero** fetch
  calls were made.
- absent `globalThis.fetch` → `misconfigured`, message naming the global.
- timeout: a hook that never answers rejects `unavailable` within `timeoutMs`, and the test
  asserts the abort signal actually fired.
- timeout covers the **body** read: a hook that returns headers instantly then dribbles still
  times out (proves the timer is not cleared at headers).
- timer hygiene: `vi.getTimerCount() === 0` after both a success and a failure.

### Manual smoke (optional)

Run the Express example from `docs/api.md` against `createHttpFormationApprover()` with a real
`fetch` — the doc example and `signFormationApproval` are the same code path the tests exercise
with a stub, so this only adds coverage of the real network stack.

## Known gaps / where to push

Honest list — treat the tests above as a floor:

- **No real-network test.** Every transport case uses an injected `fetchImpl`. The real
  `undici`/browser `fetch` differs in exactly the places that matter (does `redirect: 'error'`
  reject or resolve? does aborting mid-body surface as `AbortError` or a stream error?). Both
  branches are handled, but only the stub's behaviour is pinned. A reviewer wanting more
  confidence should stand up a throwaway HTTP server in a test and drive the real global
  `fetch` through it.
- **No test asserts the client's bytes are the bytes the database accepts.** The helpers go
  through `formationVouchMessage`, and `control-formation-invite.spec.ts` independently pins
  that the SQL check verifies the same digest — but nothing yet signs with
  `signFormationApproval` and feeds the result to `ControlDatabase.recordFormationUsage`. That
  end-to-end link naturally belongs to the wiring ticket; if a reviewer wants it sooner it is a
  cheap addition to the existing control-formation spec.
- **The 64 KiB cap is approximate on the non-streaming path.** Where `Response.body` has no
  reader (React Native's fetch), the whole body is read via `response.text()` and *then*
  measured. On that platform a hostile hook can still make the runtime buffer an arbitrary
  amount before we reject. Streaming platforms (Node, browsers) bail early, which is the case
  that matters for a cadre host. Not currently tested on the RN path — the test suite runs in
  Node, where `body.getReader` always exists; the fallback branch is reached only by the
  `content-length` case.
- **`content-length` is trusted only to reject, never to accept.** A hook that under-declares
  still gets counted for real. Deliberate, but worth a reviewer's eye.
- **Error messages carry only the hook's `origin`**, not the full URL, because a
  `ValidationUrl` path/query may carry a hook secret and these strings reach logs and (via the
  wiring ticket) a joiner's rejection reason. If operators find that too thin for debugging,
  that is the trade-off to revisit.
- **`timeoutMs` default of 10 s is unvalidated against the responder's provisioning budget.**
  `debt-formation-provision-step-timeout` owns that budget; nothing here enforces the
  relationship beyond a doc comment.

## Review findings

_(reviewer fills this in)_
