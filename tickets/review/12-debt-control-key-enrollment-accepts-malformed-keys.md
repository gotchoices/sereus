description: A shared format check now blocks a typo'd or garbled approver/owner key from being saved as if it were a real key, so the failure surfaces immediately with a clear message instead of silently breaking invitations later.
files: packages/cadre-core/src/ed25519-key.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/ed25519-key.spec.ts, packages/cadre-core/test/validation-key-enrollment.spec.ts, packages/cadre-core/test/control-database-genesis.spec.ts, packages/cadre-cli/test/subcommand-wiring.spec.ts
----

# Key enrollment accepts malformed keys — implemented

## What changed

Added `requireEd25519PublicKeyB64(value, label)` to `packages/cadre-core/src/ed25519-key.ts`,
next to `ed25519KeyPairFromLibp2p`. Behavior:
- Trims first; empty/whitespace-only reuses the existing blank-value message ("A {label} is
  required (received an empty or whitespace-only value)").
- Decodes the trimmed value as base64url (`fromString(trimmed, 'base64url')` from
  `uint8arrays`); an undecodable string throws `` `A {label} must be a base64url-encoded
  Ed25519 public key (could not decode "{trimmed}" as base64url)` ``.
- Asserts decoded length is exactly 32 bytes; otherwise throws `` `A {label} must be a
  base64url-encoded 32-byte Ed25519 public key (decoded to {n} bytes)` ``.
- Returns the trimmed value (same contract as the pre-existing `requireNonBlank`).
- Deliberately does NOT check the decoded bytes are a valid point on the Ed25519 curve — an
  off-curve-but-32-byte value is accepted here and fails normally at signature verification
  later, per the ticket's explicit scope decision.

Wired in at the two replicated-control-key write paths:
- `CadreNode.enrollValidationKey` (`packages/cadre-core/src/cadre-node.ts`) — was
  `requireNonBlank(key, 'validation key')`, now `requireEd25519PublicKeyB64(key, 'validation
  key')`.
- `ControlDatabase.ensureOwnerKey` (`packages/cadre-core/src/control-database.ts`) — had no
  format guard at all before this; now calls `requireEd25519PublicKeyB64(key, 'owner key')`
  before checking `hasOwnerKey()`/inserting.

Untouched, per the ticket's explicit scope decisions (see ticket body for the "why" on each):
`CadreNode.removeValidationKey` (still `requireNonBlank` — removing a malformed value is
already a harmless no-op), `CadreNode.trustOwnerKeys` / `--pin-owner-key` /
`TrustedOwnerStore` (a different, unreplicated trust-anchor mechanism), and
`schemas/control.qsql` (no CHECK constraint added — would only catch a writer that bypasses
`cadre-core` entirely, and no such writer exists in this repo).

No CLI-side (`packages/cadre-cli/src/commands/validation-key.ts`) change was needed or made:
the CLI's `add` subcommand calls `node.enrollValidationKey`, which now validates in
`cadre-core`, so the refusal propagates up through the CLI's existing `runSubcommand` error
handling (catches, prints `<failure>: <message>` to stderr, exits 1) automatically.

## Test coverage added

- `packages/cadre-core/test/ed25519-key.spec.ts` — new `describe('requireEd25519PublicKeyB64')`
  block: valid key (trimmed), blank/whitespace (blank-value message), invalid base64url
  characters (decode-failure message), wrong decoded length (length-mismatch message naming
  actual byte count), and a well-formed-but-off-curve 32-byte value (must still be ACCEPTED —
  guards against a future regression that adds curve validation by mistake).
- `packages/cadre-core/test/validation-key-enrollment.spec.ts` — new test: `enrollValidationKey`
  rejects `'not-a-real-key'` with the base64url/length message, and nothing gets enrolled.
- `packages/cadre-core/test/control-database-genesis.spec.ts` — new test: `ensureOwnerKey`
  rejects a malformed key with the same style of message rather than reaching the schema's
  `Authorized` CHECK as an opaque constraint error; `hasOwnerKey()` stays false afterward.
- `packages/cadre-cli/test/subcommand-wiring.spec.ts` — new test under "cadre validation-key
  over the shared scaffolding": `cadre validation-key add not-a-real-key` exits 1, stderr
  matches `/base64url-encoded/i`, and the fake node's enrolled set / write log stay empty.
  The fake node's `enrollValidationKey` mock reproduces the same shape check
  (`requireEd25519PublicKeyB64`'s decode-and-length logic inlined) so this test exercises the
  CLI's error-propagation path with a realistic message, without spinning up a live
  `CadreNode` — mirrors how the pre-existing closed-strand-refusal test in the same file mocks
  node-level refusal behavior rather than driving a real control database.

## Verification run

- `yarn workspace @serfab/cadre-core test` — 81 files, 1264 passed, 1 pre-existing skip, 0
  failures.
- `yarn workspace @serfab/cadre-cli test` — 13 files, 161 passed, 0 failures.
- `yarn eslint` on all seven touched files — clean, no errors or warnings.

## Known gaps / things the reviewer should specifically re-check

- I did NOT add a dedicated end-to-end test that actually drives `cadre validation-key add
  <bad-key>` through the real CLI binary/process (spawn + parse real stdout/stderr/exit code).
  The CLI-level coverage added goes through `validationKeyCommand.parseAsync` against a fake
  node (the same pattern every other test in `subcommand-wiring.spec.ts` uses), which exercises
  real commander parsing + real `runSubcommand`/`reportPlan` control flow, but the node-side
  validation itself is a hand-mirrored mock, not the real `CadreNode.enrollValidationKey`. The
  real code path IS covered end-to-end at the node level in
  `validation-key-enrollment.spec.ts` (real `CadreNode`, real `ControlDatabase`). If a fully
  wired CLI-to-real-node integration test is wanted, that's a gap, not something I ruled out —
  I judged the existing split (fake-node for CLI wiring, real-node for cadre-core behavior) as
  consistent with every other command tested in this file and adequate, but flagging it since
  it's a judgment call, not a verified equivalence.
- `'not-a-real-key'` (used in the `cadre-node`/`ensureOwnerKey`/CLI tests) decodes cleanly as
  base64url but to the wrong byte length, so those three tests exercise the length-mismatch
  branch. The decode-*failure* branch (invalid base64url characters) is separately verified in
  `ed25519-key.spec.ts` with `'not valid!!'` and `'has+slash/and=pad'` — confirmed by manual
  spot-check that `fromString(..., 'base64url')` from `uint8arrays` actually throws
  (`Non-base64url character`) on such input rather than silently stripping it, so both throw
  branches in `requireEd25519PublicKeyB64` are real, exercised code paths, not just spec'd.
- Did not run the full monorepo `yarn lint` (only targeted `yarn eslint` at the seven touched
  files) — ticket's TODO says "run yarn lint across touched packages," which this satisfies in
  substance, but a full-package lint run was not additionally performed.
