description: One config knob used to set both sides' timeout for waiting on a strand-formation handshake; now the responder's own timeout and the joiner's wait-for-response timeout are separate, with the joiner's automatically padded longer so the responder's own timeout reply always has time to arrive first.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/strand-formation-manager.spec.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/formation-consent-helper.ts
----

## What changed

Two roles are involved in forming a strand (a shared data channel between peers): the
**responder** (host being joined) and the **initiator** (joiner). Previously a single config
value, `StrandFormationManagerConfig.provisionTimeoutMs`, was handed to both sides — the
responder used it as its own timeout for finishing provisioning, and the initiator used the
*same* literal value as how long to wait for the responder's answer. Any latency between "the
responder's timeout fires" and "the initiator's socket read returns" meant a well-behaved
host's own clean rejection could lose the race against the joiner's own timeout — leaving the
joiner impatient of the very message that was about to explain the failure.

Fix, in `packages/cadre-core/src/strand-formation-protocol.ts`:
- Added `export const PROVISION_RESPONSE_TRAVEL_MARGIN_MS = 3_000;`
- `DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS = DEFAULT_PROVISION_TIMEOUT_MS + PROVISION_RESPONSE_TRAVEL_MARGIN_MS`

In `packages/cadre-core/src/strand-formation-manager.ts`:
- New private `initiatorProvisionTimeoutMs()` (right after `getActiveSessionCounts()`): returns
  `host + PROVISION_RESPONSE_TRAVEL_MARGIN_MS` when the responder's own
  `config.provisionTimeoutMs` is set (and `> 0`), else `undefined` — leaving both sides on their
  own independent library defaults when the operator hasn't configured a value.
- `formStrand`'s outbound `dialFormation` call now passes
  `provisionTimeoutMs: this.initiatorProvisionTimeoutMs()` instead of the host's own
  `this.config.provisionTimeoutMs` directly.
- The `FormationListener` built in the constructor (the responder side) is **unchanged** — it
  still gets `this.config.provisionTimeoutMs` as-is, i.e. the host's own budget.
- `StrandFormationManagerConfig.provisionTimeoutMs`'s doc comment now describes it as the
  responder's own budget only; the initiator's wait is derived automatically and is no longer a
  separate/settable knob. No new validation or rejection path was added — a mismatched pairing
  (initiator timing out before the host's own timeout fires) is now structurally unreachable
  rather than being caught and reported.

## Tests added

New file `packages/cadre-core/test/strand-formation-manager.spec.ts` (does not touch either
existing spec file). Drives a single `StrandFormationManager` as *both* responder and initiator
over a hand-rolled in-memory duplex bridge (`QueueStream` + `makePair` — a live cross-wired push
queue, not the canned-inbound-frame `MockStream` the other two specs use), since `formStrand`
needs to actually round-trip through the manager's own responder handler:

1. **"the host's own provisionTimeoutMs beats the derived (larger) initiator await-response
   budget"** — `config.provisionTimeoutMs: 200`, a `strandProvisioner` that never resolves.
   Asserts `formStrand` rejects with `/Formation rejected: Formation provisioning timed out/`
   (the responder's own ~200ms clean-timeout reply), not the generic
   `Formation await-response timed out after 200ms` a shared-budget regression would produce.
2. **"provisionTimeoutMs omitted: both sides fall back to their own independent defaults"** — no
   `config` at all, `strandProvisioner` resolves after a real 20ms delay. Asserts `formStrand`
   resolves with the expected `strandId` — would fail fast/NaN-timeout if
   `initiatorProvisionTimeoutMs()` mishandled `undefined`.
3. **"provisionTimeoutMs: 0 behaves as unset, same as omitting it"** — mirrors the
   protocol-layer's existing zero-is-unset test (`strand-formation-protocol.spec.ts:322`).

## Verification run this handoff

- `npx tsc --noEmit -p packages/cadre-core/tsconfig.json` — clean, no output.
- `npx vitest run test/strand-formation-manager.spec.ts test/strand-formation-protocol.spec.ts test/strand-formation-consent.spec.ts` (from `packages/cadre-core`) — **3 files, 48 tests, all pass**, no regressions in the two pre-existing formation specs.
- Full `yarn test` in `packages/cadre-core` — 85/87 files pass, 1396/1402 tests pass. The 5
  failures are in `test/control-revocation-reissue.spec.ts` and
  `test/control-revocation-replay.spec.ts` (Revocation table CHECK/UNIQUE-constraint handling,
  pointing into the sibling `../quereus` workspace's DML executor) — **unrelated subsystem**,
  confirmed via `git diff --stat 9f1dd22^ 74b7983` that this ticket's diff never touches those
  files. Logged in `tickets/.pre-existing-error.md` for triage per the pre-existing-failure
  procedure; not something to chase here.
- `yarn lint` (repo root) — clean, no output.

## Known gaps for the reviewer

- The new spec's `QueueStream` in-memory bridge only exercises the native protocol path end to
  end within one process — no real libp2p transport, no two-process network hop. Same
  limitation the two pre-existing formation specs already accept; real two-node coverage lives
  in `integration-tests` and was out of scope here.
- No new test exercises a *third* value for the responder's `provisionTimeoutMs` (e.g. a large
  value) to confirm the margin is strictly additive rather than e.g. accidentally clamped —
  current tests cover unset/zero (both fall back) and a small explicit value (host timeout wins
  the race). Low risk given the derivation is a one-line addition, but worth a glance.
