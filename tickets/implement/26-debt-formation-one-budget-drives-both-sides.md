description: Finish adding tests for a fix already landed in code — the joiner's connection-wait time is now automatically set a bit longer than the host's own timeout, and that behavior needs test coverage plus a lint/test run before handoff.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/strand-formation-manager.spec.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/formation-consent-helper.ts
difficulty: easy
----

<!-- resume-note -->
Second interrupted run of this ticket (same file, hit BUDGET_WARNING again). **Both the
source-code fix AND the new test file are DONE** — only verification (typecheck/test/lint)
and the review handoff remain, and neither has been attempted yet this run so there is no
failure to diagnose, just commands not yet executed.

## What already landed (do not redo)

### Source fix (from the first interrupted run, already confirmed clean by `tsc` previously)

`packages/cadre-core/src/strand-formation-protocol.ts`:
- Added `export const PROVISION_RESPONSE_TRAVEL_MARGIN_MS = 3_000;`.
- `DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS = DEFAULT_PROVISION_TIMEOUT_MS + PROVISION_RESPONSE_TRAVEL_MARGIN_MS`.

`packages/cadre-core/src/strand-formation-manager.ts`:
- Imports `PROVISION_RESPONSE_TRAVEL_MARGIN_MS` from `strand-formation-protocol.js`.
- Private `initiatorProvisionTimeoutMs()` (right after `getActiveSessionCounts()`, ~line 247):
  returns `host && host > 0 ? host + PROVISION_RESPONSE_TRAVEL_MARGIN_MS : undefined` where
  `host = this.config.provisionTimeoutMs`.
- `formStrand`'s `dialFormation` call passes `provisionTimeoutMs: this.initiatorProvisionTimeoutMs()`
  instead of `this.config.provisionTimeoutMs`. The `FormationListener` built in the constructor is
  UNCHANGED — it still gets `this.config.provisionTimeoutMs` directly (the responder's own budget).
- `StrandFormationManagerConfig.provisionTimeoutMs`'s doc comment describes it as the
  RESPONDER's budget only, with the initiator's wait derived automatically.

### New test file (written this run, NOT yet compiled/run)

`packages/cadre-core/test/strand-formation-manager.spec.ts` — new file, does not touch any
existing spec. Drives a SINGLE `StrandFormationManager` as BOTH responder and initiator over a
hand-rolled in-memory duplex bridge (`QueueStream` + `makePair`, a live cross-wired push queue —
NOT the canned-inbound-frame `MockStream` the other two specs use, since `formStrand` needs to
actually write to and read from the manager's own responder handler). Three tests:

1. `"the host's own provisionTimeoutMs beats the derived (larger) initiator await-response
   budget"` — manager configured with `config.provisionTimeoutMs: 200`, `strandProvisioner`
   whose `provisionStrand` never resolves. Registers the manager as responder via a captured
   libp2p handler, then calls `formStrand` through a `Libp2p` double whose `dialProtocol` bridges
   directly into that captured handler via `makePair`. Asserts `formStrand` rejects with
   `/Formation rejected: Formation provisioning timed out/` — i.e. the RESPONDER's own ~200ms
   clean timeout reply arrives while the initiator is still listening on its derived
   ~3200ms budget, not a generic `Formation await-response timed out after 200ms` (which is what
   a regression sharing one budget across both roles would produce instead).
2. `"provisionTimeoutMs omitted: both sides fall back to their own independent defaults"` — no
   `config` at all; a `strandProvisioner` that resolves after 20ms real delay. Asserts
   `formStrand` resolves with the expected `strandId` (would fail fast/NaN-timeout if
   `initiatorProvisionTimeoutMs()` mishandled `undefined`).
3. `"provisionTimeoutMs: 0 behaves as unset, same as omitting it"` — same shape with
   `config.provisionTimeoutMs: 0`, mirrors the protocol-layer's own zero-is-unset test at
   `strand-formation-protocol.spec.ts:322`.

## What's left (nothing attempted yet this run — start here)

1. Typecheck: `npx tsc --noEmit -p packages/cadre-core/tsconfig.json` from the repo root. The
   new spec file has not been compiled yet — check especially: `ControlStream` import/`implements`
   usage on `QueueStream`, the `JoinerConsent` type import from `formation-consent-helper.ts`
   (it is exported there as `export interface JoinerConsent`, but re-verify after any recent
   edits), and the inline `strandProvisioner` object literals (structurally typed against
   `StrandProvisioner`, no explicit import).
2. Run tests: `yarn workspace @serfab/cadre-core test` (from repo root, or `cd
   packages/cadre-core && yarn test`) — stream output, don't redirect silently (idle-timeout
   risk). Confirm the 3 new tests pass AND nothing in `strand-formation-protocol.spec.ts` /
   `strand-formation-consent.spec.ts` regressed.
3. Run lint: `yarn lint`.
4. Fix anything either step surfaces IN the new spec file or the two already-landed source
   files above. If a failure is clearly pre-existing/unrelated (not in this ticket's diff),
   follow the pre-existing-failure procedure in the ticket workflow rules (check
   `tickets/.pre-existing-known.md` first, then write `tickets/.pre-existing-error.md` — do not
   skip/loosen any test).

## After tests are green and lint passes

Write the `review/` handoff ticket per the normal `implement` → `review` transition:
- Summarize the fix: one config knob (`provisionTimeoutMs`) sets the RESPONDER's own budget;
  the INITIATOR's await-response wait is now derived automatically
  (`host + PROVISION_RESPONSE_TRAVEL_MARGIN_MS`) instead of being set to the same literal — no
  new validation/rejection logic needed, a mismatched pairing is now structurally unreachable.
- List the 3 new tests in `strand-formation-manager.spec.ts` and what each covers (see above).
- Flag gaps honestly: the new spec's in-memory `QueueStream` bridge is hand-rolled for this
  ticket and only exercises the native protocol path (no real libp2p transport, no two-process
  network hop — same limitation the existing formation specs already accept; real two-node
  coverage lives in `integration-tests` and is out of scope here). Also note if step 1 (tsc) or
  step 2 (test run) surfaced anything that required changes beyond what's described above, since
  this handoff was written before those commands were ever run.
Then delete this ticket file (per the normal stage-transition rule).

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
