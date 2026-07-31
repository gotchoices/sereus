description: Add an end-to-end test that stands up a real local approval server and checks that an invitation requiring outside sign-off can actually be redeemed — and is correctly refused in the four ways it should be.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/test/formation-approval-real-fetch.spec.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, schemas/control.qsql, docs/api.md, docs/STATUS.md
difficulty: medium
----

# End-to-end test: redeeming an invitation that needs outside approval

## Background in plain terms

An invitation can require sign-off from an outside approver before someone may redeem it.
The party publishes an invitation carrying the approver's web address (`ValidationUrl`); when
a newcomer tries to redeem it, the party's node calls that address over HTTP, gets back a
signed approval, and only then writes the join record. The party decides which approvers it
trusts by enrolling their public keys (`CadreControl.ValidationKey`).

Each piece already has its own tests. What has never been run is the **whole path in one
go**: real HTTP server → real approval client → real control database → real libp2p
formation handshake. That is what this ticket adds.

## What already exists (do not duplicate it)

`packages/integration-tests/test/formation-approval-real-fetch.spec.ts` already drives
`createHttpFormationApprover()` against a real `node:http` server and the real
`globalThis.fetch` — covering redirects, timeouts, the 64 KiB body cap, a dead socket, and
caller abort. **Do not re-test transport behaviour.** This ticket covers the seam *above* it:
does a real approval, obtained over a real socket, actually let a real joiner through the
real formation protocol and land a valid `FormationUsage` row?

## Design (settled — build this)

### Where the test goes

A new **Phase 5** `describe` block appended to
`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`, alongside the
existing Phase 4 ("Responder consent enforcement (real recorder)").

Phase 4 is the template. Reuse its helpers verbatim — they are already in that file:

- `responderService(party)` — a `StrandSolicitationService` wired to
  `new ControlFormationUsageRecorder(party.controlDatabase)`.
  **Critically: pass no `approver` option.** The recorder's constructor then defaults to
  `createHttpFormationApprover()`, i.e. the real HTTP client. That default is the entire
  point of this test; injecting a fake would void it.
- `ownerSigner(party)` — signs control-row authorization bytes with the party's owner key.
- `invitationFor(token, sAppId, party)` — builds the `OpenInvitation` envelope.
- `readFormationUsage(party, token)` — reads back the single recorded usage row.

Phase 5 needs its own `describe` with its own `TestCadreNetwork` + `beforeAll`/`afterAll`,
matching Phase 4's shape. Lift `responderService` / `ownerSigner` / `invitationFor` /
`readFormationUsage` to a scope both phases share rather than copying them.

### The approval-hook fixture

Extract the throwaway-HTTP-server pattern into a reusable harness fixture:
`packages/integration-tests/src/harness/fixtures/approval-hook-server.ts`.

Copy the `startServer` / `readRequestBody` / `TestServer` shape from
`test/formation-approval-real-fetch.spec.ts` (lines 74–118) — including the socket-tracking
`close()` that destroys open sockets, without which a non-ending handler hangs `server.close()`.
Leave that spec file's local copy alone: it is a `test/`-scope unit spec that deliberately
needs no harness wiring, and rewriting it is out of scope.

Fixture surface:

```ts
export interface ApprovalHookServer {
	/** `http://127.0.0.1:<port>/hook` — the exact string to publish as ValidationUrl. */
	readonly validationUrl: string;
	/** Public key of the keypair this hook signs with (base64url) — the key to enroll. */
	readonly validationKey: string;
	/** How many times the hook has been asked. Proves the responder really called out. */
	readonly requestCount: number;
	/** The five signed fields of the most recent request, or null if never asked. */
	readonly lastRequest: FormationVouchFields | null;
	close(): Promise<void>;
}

export interface ApprovalHookOptions {
	/**
	 * Decide each request. Default: approve, signing over the posted fields.
	 *  - 'approve'  → 200 + `signFormationApproval(fields, validationKey, privateKeyB64)`
	 *  - 'refuse'   → 403 + `{"error":"no"}`
	 *  - a `FormationApproval` → 200 with exactly that body (used for the replay case)
	 */
	decide?: (fields: FormationVouchFields) => 'approve' | 'refuse' | FormationApproval;
	/** Sign with this key instead of a freshly generated one. */
	privateKeyB64?: string;
}

export function startApprovalHook(options?: ApprovalHookOptions): Promise<ApprovalHookServer>;
```

Generate the approver keypair with `generatePrivateKey('ed25519', 'base64url')` and derive
the public half with `ed25519PublicKeyFromPrivate` (both already used by the real-fetch spec).
Sign with `signFormationApproval` from `@serfab/cadre-core`.

Wrap the handler body in a `.catch()` that answers `500` — a throw inside the handler is
otherwise an unhandled rejection and the client hangs to its own 10s timeout, reporting
`unavailable` and hiding the real cause (the real-fetch spec has this note; keep it).

Re-export the fixture from `packages/integration-tests/src/harness/index.ts` so scenarios
import it the same way they import `waitUntil` / `createSignedSAppConfig`.

Note `vitest.config.ts` excludes `**/fixtures/**` from coverage — correct for this file, and
the sibling `harness/fixtures/manifest-server.ts` is the precedent for the location.

### Enrolling and un-enrolling the approver key

`TestParty` holds a `ControlDatabase` and owner keys, not a `CadreNode`, so enrollment goes
through the same two calls `CadreNode.enrollValidationKey` / `removeValidationKey` bottom out
in — byte-identical owner-signed writes:

```ts
await party.controlDatabase.insertValidationKey(key, party.ownerPublicKey, ownerSigner(party));
await party.controlDatabase.deleteValidationKey(key, party.ownerPublicKey, ownerSigner(party));
```

This is deliberate, not a shortcut. Do **not** add a `@serfab/cadre-cli` dependency to
`packages/integration-tests` to drive `applyAdd`/`applyRemove`: those are pure
read-then-decide plan functions already unit-tested in cadre-cli against a fake
`ValidationKeyStore`, and reaching them from here would need a test-only adapter shim — a
shim under test is not the operator path. Add a two-line comment in the test recording that
tradeoff so a reader does not "improve" it later.

`deleteValidationKey` returns `true` when a row was actually removed; assert it, otherwise a
silently-absent key would make the "removed after the invitation went out" case pass for the
wrong reason.

### Publishing the gated invitation

```ts
await party.controlDatabase.insertFormationInvite(token, sAppId, party.ownerPublicKey, sign, {
	totalUses: 1,
	validationUrl: hook.validationUrl,
	expiresAtMs: Date.now() + 365 * 24 * 3600_000,
});
```

Leave `strandId` unset (the unbound / responder-provisions path), exactly as Phase 4 (i) does.
The unbound path routes through `ControlFormationUsageRecorder.provisionAndRecord`, which
mints the strand id and obtains the approval over it in one go — the shortest real path to a
committed `FormationUsage` row carrying a `ValidationKey` + `ValidationSignature`.

### The rejection reason strings

`StrandFormationManager` maps each `FormationApprovalFailure` to a distinct wire reason
(`APPROVAL_REJECTION_REASONS`, `packages/cadre-core/src/strand-formation-manager.ts:50`), and
`formStrand` surfaces it as a thrown `Formation rejected: <reason>`. Assert on these exact
strings — a distinct reason per category is a property worth pinning:

| case | failure category | thrown message contains |
| --- | --- | --- |
| hook answers 403 | `refused` | `Formation approval refused` |
| approver key never enrolled | `unenrolled` | `Formation approval key is not enrolled` |
| approver key removed before redemption | `unenrolled` | `Formation approval key is not enrolled` |
| replayed sign-off | `malformed` | `Formation approval invalid` |

The `unenrolled` category comes from the recorder's **local** pre-check
(`ControlDatabase.queryValidationKeyStampId` returning null), never from the HTTP client — see
`formation-approval.ts`'s `FormationApprovalFailure` docs.

### Why the replay case lands on `malformed`, not on a database `unique` violation

The approver's digest covers `(token, usageStampId, strandId, peerKey, disclosure)`. A second
newcomer mints its own `usageStampId` and has its own `peerKey`, so an approval replayed
verbatim from the first redemption fails
`verifyFormationApproval` — the recorder's local pre-check — **before** any write is
attempted. `FormationUsage.UsageStampId`'s `unique` column is the second, independent guard
and is not what fires here.

Assert the reason string (`Formation approval invalid`) and add a comment saying which of the
two guards fired and why, so a future change that reorders the pre-checks fails loudly instead
of quietly passing on the other mechanism.

To build the replay: run one successful redemption while capturing the hook's issued approval,
then restart (or reconfigure) the hook with `decide: () => capturedApproval` and redeem with a
second joiner party. A fresh invite token is needed for the second attempt, since the first
invite is single-use — publish a second `totalUses: 1` invite naming the same hook.

## Test list (Phase 5)

Each is a variation on the first. Give each its own parties (`network.createParty`) so a
failure cannot leak state into the next, and follow Phase 4's convention of
`unregisterResponder` at the end of the case.

- **(i) happy path.** Hook approves. Assert: `formStrand` resolves with a `strandId`;
  `countFormationUsage(token) === 1`; `hook.requestCount === 1`; the hook's `lastRequest`
  carries the same `token` / `strandId` / `peerKey` the recorded row does; the recorded row's
  `PeerKey` matches `ed25519PublicKeyB64FromPeerId(result.memberKey)`; and
  `verifyFormationConsent(row)` is true (the joiner's own consent signature still re-verifies
  alongside the approval).
  Also assert the hook was posted **exactly the five signed fields and nothing else** —
  `Object.keys(hook.lastRequest!).sort()` equals
  `['disclosure','peerKey','strandId','token','usageStampId']`. No `validationUrl`, no owner
  keys, no bootstrap addresses ever reach an outside approver; that is a privacy property, and
  this is the only place it is checked end to end.

- **(ii) approver refuses.** Hook answers 403. Assert the throw contains
  `Formation approval refused`, `countFormationUsage(token) === 0` (the invitation is **not**
  consumed), and that a subsequent redemption against the same token with an approving hook
  still succeeds — proving the refusal really left the seat unspent rather than merely
  leaving the count at zero.

- **(iii) key never enrolled.** Hook approves with a key that was never written to
  `ValidationKey`. Assert `Formation approval key is not enrolled` and
  `countFormationUsage(token) === 0`.

- **(iv) key removed after the invitation went out.** Enroll, publish the invite, then
  `deleteValidationKey` (assert it returned `true`), then redeem. Assert
  `Formation approval key is not enrolled` and `countFormationUsage(token) === 0`.

- **(v) replayed sign-off.** As described above. Assert `Formation approval invalid` and that
  the second token's usage count is 0 while the first token's stays 1.

## Edge cases & interactions

The implementer must cover or consciously dismiss each of these; the reviewer will check.

- **Hook fixture lifetime.** Every case must `close()` its hook in a `finally`, or a leaked
  listener holds the vitest fork open past the suite. `fileParallelism: false` means one file
  at a time, but sockets still outlive a failed assertion.
- **Port assignment.** Bind `0` on `127.0.0.1` and read the actual port from
  `server.address()`. Do **not** use the harness `allocatePort()` — that pool is for libp2p
  nodes, and mixing the two invites collisions.
- **Approval client timeout vs. responder budget.** The default HTTP approver budget is 10s
  (`DEFAULT_TIMEOUT_MS`) and must stay under the responder's provisioning budget. A local hook
  answers in single-digit milliseconds, so no case here should approach either — but if a case
  ever hangs, that interaction (not the fixture) is the thing to look at. Do not shorten
  `timeoutMs` in these tests: the default path is what is under test.
- **Test timeouts.** Phase 4 cases use `30_000`; match that. The file-level default is
  `60_000`.
- **Owner-key convergence.** `insertValidationKey` is a replicated control write on the
  responder party's own owner node, and the redemption reads it back on that same node, so
  there is no cross-node convergence gap here. Do not add a `waitUntil` for enrollment — if
  one appears necessary, that is a real finding, not a flake to paper over (file it
  separately per the note below).
- **Removal ordering.** `deleteValidationKey` writes the row delete *and* its `Revocation`
  tombstone in one transaction (`ValidationKey.RevocationRecorded`). Case (iv) must go through
  that call, not a raw delete.
- **Single-row read premise.** `readFormationUsage` returns whichever row the scan yields
  first; every case here uses `totalUses: 1`, so pin that with a
  `countFormationUsage(token) === 1` assertion before reading, exactly as Phase 4 (iii) does.
- **Disclosure bytes must not be re-serialized.** The approver signs the disclosure string
  verbatim. The fixture must sign the exact string it received from the posted JSON — never
  `JSON.stringify(JSON.parse(...))` it. Getting this wrong makes case (i) fail with
  `Formation approval invalid`, which is the most likely way this test is mis-built.
- **Handler errors.** A throw inside the hook handler must answer 500, not reject unhandled
  (see fixture note above).
- **Nothing leaks into Phase 4.** Phase 5 must not enroll a validation key on a party any
  other phase reuses; every phase-5 case creates its own parties.

## Docs to update when the test lands

- `docs/api.md` — the approval hook's request/response contract. Confirm what is written
  there matches what the fixture actually implements (five fields posted; `200` +
  `{validationKey, validationSignature}`; `401`/`403` = refusal). Correct the doc if it drifts;
  it is the contract a third-party hook operator builds against.
- `docs/STATUS.md` — the formation-approval section records this end-to-end gap. Replace the
  gap entry with what is now covered, naming the Phase 5 block.

## Note

This is coverage for behaviour believed to work, not a known defect. If the test turns up a
real bug, **file it as a separate `fix/` ticket** and do not fold the fix into this one —
this ticket is done when the path is covered.

## TODO

Phase A — fixture

- Create `packages/integration-tests/src/harness/fixtures/approval-hook-server.ts` with
  `startApprovalHook` / `ApprovalHookServer` / `ApprovalHookOptions` as specified above.
- Re-export it from `packages/integration-tests/src/harness/index.ts`.

Phase B — tests

- Lift `responderService` / `ownerSigner` / `invitationFor` / `readFormationUsage` out of the
  Phase 4 `describe` into a scope Phase 4 and Phase 5 share, leaving Phase 4 unchanged in
  behaviour.
- Add the Phase 5 `describe` with its own `TestCadreNetwork` + `beforeAll`/`afterAll`.
- Write case (i) happy path, including the five-fields-and-nothing-else assertion.
- Write cases (ii) refused, (iii) never enrolled, (iv) removed after issue, (v) replayed.
- Comment the replay case with which guard fires and why.
- Comment the enrollment call with the "why not cadre-cli's `applyAdd`" tradeoff.

Phase C — validate + document

- `yarn lint` and `yarn typecheck` clean.
- Run the scenario file streamed to a log:
  `yarn workspace @serfab/integration-tests test 2>&1 | tee /tmp/formation-approval-e2e.log`
  (or vitest with the single file). Never redirect silently — the runner's idle timer needs
  output.
- Update `docs/api.md` and `docs/STATUS.md` per the section above.
