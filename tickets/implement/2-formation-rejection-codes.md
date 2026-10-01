description: When an inviter turns a join request down, the joining device gets only a sentence of text. Give each refusal a fixed code so a device can tell "try again later" from "this invitation is dead" without reading the wording.
architecture: docs/architecture.md#strand-formation
files: packages/cadre-core/src/strand-formation-protocol.ts (FormationResultMessage ~156, ResponderProvisionOutcome ~128, runSession send sites ~453/627-677, dialFormation ~795-845), packages/cadre-core/src/strand-formation-manager.ts (reasons ~74-97, validateToken ~386, provisionAsResponder ~444-541, issueBoundMembershipInvite ~575-600), packages/cadre-core/src/strand-solicitation.ts (FormationUsageRecorder.isTokenValid ~91), packages/cadre-core/src/control-formation-recorder.ts (isTokenValid ~75), packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/strand-solicitation.spec.ts, docs/architecture.md (Strand Formation), docs/api.md (formStrand)
----
# Typed rejection codes on the formation wire

Part of gotchoices/sereus#25 (split from the plan ticket `durable-pending-join`). Two later tickets depend on this: `invitation-names-every-party-machine`, which decides whether to try the next machine, and `pending-join-retry-loop`, which decides whether to retry or stop.

## Today

A rejecting responder sends `{ approved: false, reason: '<free text>' }`. `dialFormation` throws `new Error('Formation rejected: <reason>')`. A transport failure (dial refused, deadline passed, stream closed early) throws other plain `Error`s. The only way a caller can tell a retryable outcome from a final one is to match the wording, and the wording is also what humans read in logs.

## Wire change

`FormationResultMessage` gains `code?: FormationRejectionCode`, required by the responder whenever `approved === false`. `reason` stays as the human text. `ResponderProvisionOutcome`'s rejecting arm carries `{ approved: false; code; reason }`, so the code is chosen where the reason is chosen today.

```ts
export type FormationRejectionCode =
  | 'token-unknown'          // no FormationInvite row for this token on THIS responder (it may not have replicated here yet)
  | 'token-spent'            // the invitation expired, or every allowed use is recorded (incl. InvitationExhaustedError)
  | 'consent-invalid'        // the joiner's consent signature does not verify
  | 'disclosure-invalid'     // disclosure validator refused it
  | 'disclosure-too-large'
  | 'approval-refused'       // FormationApprovalFailure 'refused'
  | 'approval-unavailable'   // FormationApprovalFailure 'unavailable'
  | 'approval-invalid'       // 'malformed' | 'unenrolled' | 'misconfigured' (the inviter's hook setup is wrong)
  | 'host-strand-unavailable'      // MEMBERSHIP_INVITE_UNAVAILABLE_REASON and 'Host strand not yet available on this responder'
  | 'host-strand-must-be-recreated' // HOST_STRAND_MUST_BE_RECREATED_REASON
  | 'busy'                   // 'Too many concurrent formation sessions'
  | 'provisioning-timeout'   // 'Formation provisioning timed out'
  | 'conflict'               // 'Formation conflict, retry'
  | 'internal';              // 'Internal formation error'
```

One exported table, `FORMATION_REJECTION_RETRYABLE: Record<FormationRejectionCode, boolean>`, is the single place that says which codes are worth retrying. Retryable: `token-unknown`, `approval-unavailable`, `host-strand-unavailable`, `busy`, `provisioning-timeout`, `conflict`, `internal`. Final: everything else.

**The token split.** Today `INVALID_TOKEN_REASON` covers three states: no row, expired, and used up. They become two codes. `token-spent` (expired or used up) is final. `token-unknown` is retryable, because once `invitation-names-every-party-machine` lands, a sibling machine of the inviter that has not yet received the `FormationInvite` row answers this way. This leaks nothing new. Only a caller who already holds the token can ask, and an unknown token means the same as one never minted. The existing rule still holds: the loser of a redemption race and a latecomer get the same answer (`token-spent`). `FormationUsageRecorder.isTokenValid` returns `{ valid: false, reason: 'unknown' | 'expired' }` so the manager can choose. A recorder that omits `reason` (test stubs) maps to `token-unknown`.

## Joiner side

`dialFormation` throws one of two typed errors, both exported from the package index:

- `FormationRejectedError extends Error { code: FormationRejectionCode | 'unrecognized'; reason: string; retryable: boolean }`. A missing code, or one this build does not know, becomes `'unrecognized'` with `retryable: true`. Formation runs between two parties on different versions, and retrying an unknown answer until the invitation expires is safe, while giving up on one is not.
- `FormationUnreachableError extends Error` (always retryable) for every failure before a result frame is read: no address parses, every address fails to dial, the dial or response deadline passes, or the stream closes or ends early. Keep the existing message text (including `describeAllAddressesFailed`'s per-address detail) and set the original as `cause`.

A result frame that arrives but fails validation (`'Responder result failed validation'`, missing provision result) stays a plain `Error`. That is a misbehaving responder, not a rejection.

## Edge cases & interactions

- **Rejection parity.** A rejection still discloses no responder identity, addresses or keys. The added `code` is the only new field. Verify by inspection of every `send({ approved: false ... })` site.
- **Late provisioning outcome adopted within the grace** (`runSession` ~535): it carries the hook's code through unchanged. Inspection.
- **`FormationAbortedError`** keeps being rethrown rather than mapped (the listener's timeout path owns that reply, with code `provisioning-timeout`). Inspection.
- **Every rejection site gets a code.** Make the type force it: `ResponderProvisionOutcome`'s rejecting arm and the internal `send` helper take a required `code`, so a missing one fails `tsc`.
- **The `log` lines** keep the free text. Operators read those, and the exhausted-invite log already names uses recorded against the total.

## Tests

- One table-driven test in `strand-formation-protocol.spec.ts` (or the existing rejection-parity describe): a mock responder sends each code, and the joiner throws `FormationRejectedError` with the matching `retryable`. Also: an absent code becomes `'unrecognized'`/retryable, and an unparsable-address or refused dial becomes `FormationUnreachableError`. This pins the classification, which later tickets branch on.
- One recorder-level test: an unknown token gives `token-unknown`, and an expired one gives `token-spent`. Extend the existing control-formation-recorder spec.
- Update existing assertions that match `'Formation rejected: Invalid token'` text to assert on `code` instead. Do not add per-site tests.

## TODO

- Add `FormationRejectionCode`, `FORMATION_REJECTION_RETRYABLE`, `code` on `FormationResultMessage` and the outcome type; thread a code through every rejection site in protocol and manager.
- Split `isTokenValid`'s result into unknown and expired in the recorder interface and `ControlFormationUsageRecorder`; map them in `validateToken`.
- Add the two error classes; throw them from `dialFormation` and `openFormationStream`; export them from `index.ts`.
- Update tests that matched rejection text.
- Docs: the Strand Formation section of `docs/architecture.md` (a short table of codes and whether each is retried) and `docs/api.md` (`formStrand` throws). Add a release-note bullet in `.release-notes.pending.md` (a joiner can now branch on `error.code`).
- `yarn lint`, `yarn workspace @serfab/cadre-core test`.
