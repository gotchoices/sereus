description: Build the piece that lets a party's node ask an outside approval service whether a would-be joiner may join, and check the answer it gets back. Nothing is wired to it yet — that is a follow-up ticket.
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/formation-approval.ts (new), packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/formation-approval.spec.ts (new), docs/api.md
difficulty: medium
----

# Formation approval client: types, HTTP transport, sign/verify helpers

An invitation (`FormationInvite`) may carry a `ValidationUrl` — a web hook the inviting party
wants consulted before the invitation is redeemed. The control database already enforces the
approval (`FormationUsage.Authorized` verifies a signature against an enrolled `ValidationKey`
row), and `formationVouchMessage` in `control-database.ts` already builds the exact bytes an
approver signs. What is missing is everything on the *client* side: a type for the request, a
transport that contacts the hook, and helpers to produce/check the signature.

This ticket builds only that surface. Wiring it into the redemption path is
`feat-formation-approval-wiring`; enrolling approver keys is
`feat-validation-key-enrollment`.

## Who contacts the hook — settled

**The inviting party's node (the formation responder) contacts the hook.** Not the joiner. Three
reasons, and this is not revisited downstream:

- The trust relationship is the party's: the party enrolled the approver key and published the
  `ValidationUrl`. A joiner allowed to fetch its own approval chooses which approver to ask.
- The approval signature is bound to a single-use nonce (`UsageStampId`) and to the strand id.
  Only the redeeming node mints the nonce and knows the strand id, so only it can guarantee that
  the nonce signed is the nonce inserted.
- The joiner never sees the party's control database and cannot perform the redeeming write.

The cost is an outbound HTTP request from the party's node during formation. That is bounded by
an explicit timeout here, and by the provisioning-step budget in
`debt-formation-provision-step-timeout`.

## Interfaces (new `packages/cadre-core/src/formation-approval.ts`)

```ts
/** Everything one approval is bound to. Mirrors formationVouchMessage's field set. */
export interface FormationApprovalRequest {
  /** Invitation token being redeemed. */
  token: string;
  /** Single-use nonce for THIS redemption, already minted by the redeeming node. */
  usageStampId: string;
  /** The strand (network) being joined. */
  strandId: string;
  /** The joining peer (written to FormationUsage.PeerId). */
  peerId: string;
  /**
   * The EXACT text that will be written to FormationUsage.Disclosure. The approver signs
   * these bytes verbatim and MUST NOT re-serialize them — the redeeming node computes this
   * string once and uses the identical string for both the signature and the insert.
   */
  disclosure: string;
  /** The invite's ValidationUrl (the hook to contact). Not part of the signed digest. */
  validationUrl: string;
}

export interface FormationApproval {
  /** Public key the approval claims; must match an enrolled ValidationKey row. */
  validationKey: string;
  /** base64url ed25519 signature over formationVouchMessage(request). */
  validationSignature: string;
}

export interface FormationApprover {
  requestApproval(request: FormationApprovalRequest): Promise<FormationApproval>;
}

export type FormationApprovalFailure =
  | 'refused'      // the hook answered, and the answer is no
  | 'unavailable'  // could not get an answer (network, timeout, 5xx, redirect)
  | 'malformed'    // got an answer that is not a usable approval
  | 'misconfigured'; // the ValidationUrl or the runtime is unusable (bad scheme, no fetch)

export class FormationApprovalError extends Error {
  constructor(readonly failure: FormationApprovalFailure, message: string, options?: { cause?: unknown });
}
```

`FormationApprovalError` must be exported from the package index — the wiring ticket switches on
`failure` to pick a rejection reason the joiner sees.

## HTTP transport

```ts
export function createHttpFormationApprover(options?: {
  /** Abort the request after this long. Default 10_000. Must stay under the responder's
   *  provisioning budget (see debt-formation-provision-step-timeout). */
  timeoutMs?: number;
  /** Injectable for tests / non-standard runtimes. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}): FormationApprover;
```

Wire contract — document it in `docs/api.md`, it is the integration surface for hook operators:

- `POST <ValidationUrl>`, `content-type: application/json`, `accept: application/json`.
- Request body is exactly `{ token, usageStampId, strandId, peerId, disclosure }` — the five
  signed fields and nothing else. Never send owner keys, bootstrap addresses, or membership keys.
- `200` with `{ "validationKey": "...", "validationSignature": "..." }` → approval.
- `401` / `403` → `refused`.
- Any other non-2xx, a network error, a timeout, or a redirect → `unavailable`.
- `2xx` whose body is not JSON, or is JSON missing/blanking either field → `malformed`.

Behaviour requirements:

- Timeout via `AbortController`; clear the timer on every exit path (success and throw).
- Reject any `validationUrl` whose scheme is not `http:` or `https:` **before** any request —
  `misconfigured`. `http:` stays permitted (self-hosted hooks on a LAN are a real case) but note
  in the doc comment that it exposes the disclosure in clear text.
- Do not follow redirects (`redirect: 'error'`); a redirect is `unavailable`. A hook that moved
  should be re-published, not chased at redemption time.
- Cap the response body at 64 KiB (check `content-length` when present; otherwise stop reading /
  reject once the text exceeds the cap) → `malformed`. A broken or hostile hook must not be able
  to stream unbounded data into the redeeming node.
- No `fetch` on `globalThis` and none injected → `misconfigured`, naming the missing global.
- Cross-platform: global `fetch` + `AbortController` only. No `node:` imports, no `undici`.

## Sign / verify helpers

```ts
/** Approver side: produce the approval for a request. Used by tests and by anyone writing a
 *  hook in TypeScript. `privateKeyB64`'s public half must be the enrolled ValidationKey. */
export function signFormationApproval(
  request: FormationApprovalRequest,
  validationKey: string,
  privateKeyB64: string
): FormationApproval;

/** Redeeming side: does this approval actually verify against the bytes we are about to write?
 *  A local pre-check so a bad approval becomes a legible rejection instead of an opaque
 *  `CHECK constraint failed: Authorized`. NOT the authority — the database still re-verifies
 *  against the STORED ValidationKey row, which is what stops a redeemer approving itself. */
export function verifyFormationApproval(
  request: FormationApprovalRequest,
  approval: FormationApproval
): boolean;
```

Both build their bytes with `formationVouchMessage` (imported from `./control-database.js`) —
never a hand-written field list. `sign`/`verify` come from `@optimystic/quereus-plugin-crypto`
with message encoding `'bytes'` and signature/key encoding `'base64url'`, matching
`control-database.ts`'s signing callbacks and `peer-authorization.ts`'s verify calls.

## Dead code this replaces

`StrandSolicitationService.validateStrandFormation` is called by nothing except its own unit
test; the real responder path (`strand-formation-manager.ts`) never goes through it, and its
two-argument `FormationSigner.signFormation(token, disclosure)` cannot produce a signature the
database accepts (it lacks the nonce, strand, and peer). Delete rather than widen — the wiring
ticket puts the real call in the recorder, and there is no back-compat requirement:

- delete `StrandSolicitationService.validateStrandFormation`
- delete `FormationSigner` and `StrandSolicitationServiceOptions.formationSigner` (plus the
  field, constructor assignment, and index export)
- delete `ValidateFormationResult` from `types.ts` and its index export
- delete the `describe('validateStrandFormation')` block in `test/strand-solicitation.spec.ts`
  and its `FormationSigner` import; keep the rest of that file compiling

Replace the "Validate Strand Formation" section of `docs/api.md` with the hook HTTP contract
above plus a short TypeScript example of a hook that answers using `signFormationApproval`, and
drop the "Wiring the responder side up to call this is `tickets/plan/...`" sentence.

## Edge cases & interactions

- **Timer leak on the success path** — the abort timer must be cleared when the fetch resolves,
  not only when it rejects. A leaked timer keeps a node's event loop alive.
- **Abort vs. slow body** — the timeout must cover reading the body, not only the response
  headers. A hook that returns headers instantly and dribbles the body must still time out.
- **Disclosure is opaque** — the transport must not parse, reformat, or re-encode `disclosure`.
  Round-trip it as a JSON string field; the bytes the approver signs are the bytes we hold.
- **Signature over a different request** — `verifyFormationApproval` must return false when ANY
  one of the five fields differs. Test all five individually; a shared-prefix bug in the digest
  encoding would otherwise pass.
- **Empty-string fields** — `disclosure` may legitimately be `''`. Sign/verify must handle it,
  and `''` must not be conflated with a missing field.
- **`misconfigured` is not `unavailable`** — a bad scheme is an operator error that retrying
  never fixes; the wiring ticket surfaces them differently.
- **Non-2xx with a JSON body** — a `403` carrying a well-formed `{validationKey,...}` is still
  `refused`. Status decides, not body shape.

## TODO

Phase 1 — types + helpers

- Create `packages/cadre-core/src/formation-approval.ts` with the request/approval/approver
  types, `FormationApprovalError`, `signFormationApproval`, `verifyFormationApproval`.
- Export the new surface from `packages/cadre-core/src/index.ts`.

Phase 2 — HTTP transport

- Implement `createHttpFormationApprover` in the same module, per the wire contract and the
  behaviour requirements above.

Phase 3 — remove the dead signer surface

- Delete `validateStrandFormation`, `FormationSigner`, `formationSigner`,
  `ValidateFormationResult`, and their index exports + the unit-test block that covers them.

Phase 4 — tests (`packages/cadre-core/test/formation-approval.spec.ts`)

- sign → verify round-trip; verify fails when each of the five fields is mutated in turn.
- `createHttpFormationApprover` with a stub `fetchImpl`: 200-happy, 403 → `refused`,
  500 → `unavailable`, network throw → `unavailable`, redirect → `unavailable`,
  non-JSON 200 → `malformed`, `{}` 200 → `malformed`, blank-string fields → `malformed`,
  oversized body → `malformed`, `file:` URL → `misconfigured`, absent fetch → `misconfigured`.
- Timeout: a `fetchImpl` that never settles rejects as `unavailable` within the configured
  `timeoutMs`, and the abort signal is actually fired.
- Request body assertion: exactly the five fields, `disclosure` byte-identical to the input.

Phase 5 — docs + gates

- Rewrite `docs/api.md` → "Validate Strand Formation" as the hook contract + example.
- `yarn build`, `yarn lint`, and the cadre-core vitest suite pass.
