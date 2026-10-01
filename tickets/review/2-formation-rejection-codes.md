description: When an inviter turns a join request down, the joining device now gets a fixed reason code and a "worth retrying" flag instead of only a sentence of text, so it can tell "try again later" from "this invitation is dead".
architecture: docs/architecture.md#strand-formation
files: packages/cadre-core/src/strand-formation-rejection.ts (new), packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, docs/architecture.md, docs/api.md, .release-notes.pending.md
----
# Typed rejection codes on the formation wire — review handoff

Part of gotchoices/sereus#25. Two implement tickets build on this: `invitation-names-every-party-machine` (decides whether to try the next machine) and `pending-join-retry-loop` (decides whether to retry or stop).

## What changed

**New module `strand-formation-rejection.ts`** holds the types a joiner branches on:

- `FormationRejectionCode`: the 14 codes from the plan (`token-unknown`, `token-spent`, `consent-invalid`, `disclosure-invalid`, `disclosure-too-large`, `approval-refused`, `approval-unavailable`, `approval-invalid`, `host-strand-unavailable`, `host-strand-must-be-recreated`, `busy`, `provisioning-timeout`, `conflict`, `internal`).
- `FORMATION_REJECTION_RETRYABLE`: the one table saying which codes are retried. Retryable: `token-unknown`, `approval-unavailable`, `host-strand-unavailable`, `busy`, `provisioning-timeout`, `conflict`, `internal`.
- `isFormationRejectionCode`: an own-key lookup, so a peer sending `'constructor'` does not match.
- `FormationRejectedError` has `code` (a known code, or `'unrecognized'`), `reason` and `retryable`. A missing or unknown code becomes `'unrecognized'` and is retryable. Its constructor takes both values as `unknown` because they come straight off the wire. The message text is unchanged: `Formation rejected: <reason>`.
- `FormationUnreachableError` has `retryable = true` and keeps the underlying message, with the original error as `cause`.

All of these are exported from the package index, along with the `FormationRejection` and `FormationTokenCheck` types.

**Responder (`strand-formation-protocol.ts`).** `FormationResultMessage` gains `code?`. The wire type keeps it optional because a frame from another version may omit it. On the sending side the type requires it:

- `ResponderProvisionOutcome`'s rejecting arm is now `FormationRejection` (`{ approved: false; code; reason }`).
- `runSession`'s `send` only accepts `FormationRejection | ApprovedResultMessage`.
- The `busy` and `internal` frames are typed `FormationRejection`.

So a rejection without a code fails `tsc`. The listener's `validateToken` option now returns `FormationTokenCheck` (`{ valid: true } | { valid: false; code: 'token-unknown' | 'token-spent' }`).

**Manager (`strand-formation-manager.ts`).** Every rejection site picks its code:

- `APPROVAL_REJECTIONS` maps each approval-failure category to a full rejection. `malformed`, `unenrolled` and `misconfigured` share `approval-invalid`, and the reason text still names which one.
- `issueBoundMembershipInvite` returns `{ ok: false, rejection }`.
- `InvitationExhaustedError` maps to `token-spent` with the same `'Invalid token'` text as an up-front spent token. Rejection parity holds.
- `validateToken` maps the recorder's answer: expired → `token-spent`, used up → `token-spent`, missing row → `token-unknown`. A recorder that gives no reason also maps to `token-unknown`.

**Recorder.** `FormationUsageRecorder.isTokenValid` gains an optional `reason?: 'unknown' | 'expired'`. `ControlFormationUsageRecorder` fills it in.

**Joiner (`dialFormation`).** It is split into `exchangeContact` (open the stream, write the contact, read one frame, close the stream) and `acceptResult` (rejection → `FormationRejectedError`; failed validation or a missing provision result → plain `Error`, as before):

- Any failure before the frame is read becomes `FormationUnreachableError`. That includes a session deadline that fires first, tracked by a local `answered` flag.
- `parseResponderAddrs` and `describeAllAddressesFailed` throw or return `FormationUnreachableError` directly. The per-address message is unchanged, and the `AggregateError` is kept as `cause`.

## Behaviour changes a reviewer should weigh

- **The stream now closes before `validateResponse` runs.** Before, it closed after. The responder writes one frame and is done, so the protocol is unaffected, but the order did change.
- **A frame that arrives oversized or as non-JSON is classed as unreachable (retryable), not as a plain `Error`.** The plan listed only dial failures, deadlines and early closes. These two also fail inside the read step, before any answer exists, so they fall on that side. The reasoning is in the `exchangeContact` doc comment. Reclassify them if you disagree.
- **A session deadline that fires while a custom `validateResponse` is still running stays a plain `Error`.** At that point an answer was already read.
- **`token-unknown` and `token-spent` send the same reason text, `'Invalid token'`.** This was deliberate, to keep the change small and the parity rule simple. Only the code tells them apart, so a human reading only the message cannot.
- **Retrying `conflict` is safe only through a fresh `formStrand` call.** One cause of `conflict` is a reused joiner nonce. Every `formStrand` call mints a new nonce, so a retry loop must call `formStrand` again rather than resend the same contact frame. This is a constraint on `pending-join-retry-loop`, not a defect here.
- **`token-unknown` is retryable, so a forged token is retried too.** The retry loop must stop at invitation expiry. This is the plan's stated trade-off.

## Tests

Added (all in `test/strand-formation-protocol.spec.ts`, describe `dialFormation failure classification`):

- `throws FormationRejectedError carrying each code, retryable exactly for the retryable set`: loops over every code in the table. It checks `retryable` against a retryable list written out in the test, so editing the table alone fails it.
- `reads an absent or unknown code as unrecognized and retryable`: tries no code, `'from-a-newer-build'`, and `'constructor'` (the prototype-key case).
- `throws FormationUnreachableError when no address parses or every address refuses the dial`: checks the message, `retryable`, the per-address detail, and that `cause` is the original `AggregateError`.

Removed: the old `throws when the responder rejects the formation` text-matching test, which the first test above replaces.

Assertions switched from reason text to `code`, with no new tests:

- `strand-formation-consent.spec.ts`, through the real database-backed recorder and the manager:
  - (a) unknown token → `token-unknown`
  - (a) expired token → `token-spent`
  - (d), (e), (f) used-up invitation → `token-spent`
  - (p) `InvitationExhaustedError` → `token-spent`

  Together these pin the token split end to end.
- `control-formation-invite.spec.ts` `isTokenValid` now asserts `{ valid: false, reason: 'unknown' }` and `{ valid: false, reason: 'expired' }`.
- `strand-formation-protocol.spec.ts`:
  - The first rejection-parity test asserts `token-unknown`.
  - The settle-grace adoption test asserts `token-spent` on re-presentation.
  - The stubs carry the codes they now need.
- Integration scenarios `strand-formation-concurrent-redemption` (cases 2 and 3) and `strand-formation-e2e` (abort-adopt re-redeem) assert `{ code: 'token-spent', retryable: false }` instead of matching `/Invalid token/`.

## Validation run

- `yarn lint`: exit 0.
- `yarn workspace @serfab/cadre-core test`: 147 files, 2346 passed, 1 skipped.
- **Integration scenarios: not run.** Their assertions changed, but they run against cadre-core's built `dist` and a real network, and `../optimystic` was being reinstalled during this session (see below). A reviewer should run `strand-formation-concurrent-redemption` and `strand-formation-e2e` once the sibling is quiet.
- **`tsc -p tsconfig.typecheck.json` in cadre-core: fails on errors outside this ticket's files.** They are `@libp2p/interface` type-split errors in `cadre-node.ts`, `strand-instance-manager.ts` and about a dozen libp2p test setups. Cause: `../optimystic` reinstalled its dependencies during this session (node_modules dated 2026-09-30 23:04–23:11, uncommitted `yarn.lock` changes). Its `db-p2p` now resolves `@libp2p/interface` 3.3.0 against this repo's 3.1.0. `blocked/adopt-optimystic-address-dial-timeout` already predicts this split, so no pre-existing-error file was written. None of the errors is in a file this ticket touched.

## Docs

- `docs/architecture.md`:
  - New `#### Formation rejection codes` section at the end of Strand Formation, with the code table, the `'unrecognized'` rule and the reason for the token split.
  - The timeout, approval-unavailable and `InvitationExhaustedError` sentences now name codes.
- `docs/api.md`:
  - `formStrand` throws paragraph: both error types and their `code`/`retryable` fields.
  - The approval-failure table gains a code column.
- `.release-notes.pending.md`: new section "A failed join says whether to try again".
