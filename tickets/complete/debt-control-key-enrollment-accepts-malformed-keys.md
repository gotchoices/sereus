description: A shared format check now blocks a typo'd or garbled approver/owner key from being saved as if it were a real key, so the failure surfaces immediately with a clear message instead of silently breaking invitations later.
files: packages/cadre-core/src/ed25519-key.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/ed25519-key.spec.ts, packages/cadre-core/test/validation-key-enrollment.spec.ts, packages/cadre-core/test/control-database-genesis.spec.ts, packages/cadre-cli/test/subcommand-wiring.spec.ts, docs/architecture.md
----

# Key enrollment accepts malformed keys — complete

## What shipped

`requireEd25519PublicKeyB64(value, label)` lives in `packages/cadre-core/src/ed25519-key.ts`
and is exported from the package entry point. It trims, decodes the value as base64url, and
requires exactly 32 decoded bytes; anything else throws an error naming what was wrong (blank,
undecodable, or decoded to the wrong byte count). It is a shape check only — 32 bytes that are
not a point on the Ed25519 curve are accepted here and fail later at signature verification
like any other wrong key, which was a deliberate scope decision at plan time.

It guards the two operator-facing writes of a replicated control key:

- `CadreNode.enrollValidationKey` — the approver keys behind `cadre validation-key add`.
- `ControlDatabase.ensureOwnerKey` — the founding owner key inserted at genesis, which had no
  format guard at all before this.

The CLI needed no change: `cadre validation-key add` calls `enrollValidationKey`, and the
existing `runSubcommand` error handling turns the refusal into `<failure>: <message>` on stderr
with exit 1.

Left alone on purpose: `removeValidationKey` (removing a malformed value is already a harmless
no-op), the raw table writers `insertOwnerKey` / `insertValidationKey` (the low-level
replication and test seam — every operator-facing path reaches them through a guarded caller),
the node-local pinned-owner anchor (`trustOwnerKeys` / `--pin-owner-key` — a different store,
now tracked separately, see below), and `schemas/control.qsql` (a CHECK constraint would only
catch a writer that bypasses `cadre-core`, and no such writer exists in this repo).

## Review findings

**Checked:** the full implement diff read before the handoff summary; every call site that
writes an owner or approver key anywhere in `packages/` (including the integration-test
harnesses and `cadre-host`); the decoder's real behavior on malformed input, verified by
running it rather than trusting the claim; whether the tests exercise both throw branches;
`docs/architecture.md`'s description of the affected CLI surface; source hygiene of the new
function and of the tests; lint and the two full package test suites.

**Fixed in this pass (minor):**

- The new guard was not exported from `packages/cadre-core/src/index.ts`, so the CLI test could
  not reach it and had hand-copied twelve lines of the decode-and-length logic into its fake
  node — a duplicate that would silently drift from the real check the moment either changed.
  Exported the function; the fake node now calls the same guard the real node calls, so that
  test asserts against the production message instead of a restatement of it.
- The decode failure was caught and discarded (`catch { throw new Error(...) }`), against the
  house rule about not eating exceptions. It now carries `{ cause: error }`, matching the
  idiom already used across `control-database.ts`, `key-store-file.ts`, and `fs-atomic.ts`. A
  test locks the cause in so a future edit cannot quietly drop it again.
- `docs/architecture.md`'s `cadre validation-key` entry described the read-before-write
  behavior but predated the format check. It now states what is refused, that the check is
  shape-only and not curve validation, and why the raw table writers stay unguarded.

**Verified, not changed:**

- The claim that `fromString(value, 'base64url')` genuinely throws on bad input holds. Ran it
  directly: `'not valid!!'` and `'has+slash/and=pad'` throw `Non-base64url character`,
  `'not-a-real-key'` throws `Unexpected end of data`. So the string used in three of the tests
  actually exercises the *decode-failure* branch, not the length branch the handoff assumed —
  the assertions are regex alternations covering both messages, so they pass either way, but
  the length branch's real coverage comes from the explicit 16-byte case in
  `ed25519-key.spec.ts`. Both branches are exercised.
- Guarding the raw writers instead of (or in addition to) their callers is not viable as a
  small change: roughly a dozen `cadre-core` tests call `insertValidationKey` with synthetic
  identifiers like `val-replay-xk3f9`, by design, because those tests are about the
  authorization constraints rather than key material. Guarding at the writer would break them
  all. The layering — public API validates, raw writer does not — is now documented rather than
  implicit.
- The handoff flagged the absence of a spawn-the-real-binary CLI test as a possible gap. It is
  not one worth closing: every command in `subcommand-wiring.spec.ts` uses a fake node, real
  commander parsing, and real `runSubcommand` control flow, and with the duplicate logic
  removed the fake now runs the production guard. The node-side path is covered against a real
  `CadreNode` and a real control database in `validation-key-enrollment.spec.ts`.

**Filed as a new ticket (major):** `backlog/debt-pinned-owner-keys-accept-malformed-values` —
the operator-supplied trusted-owner pins (`--pin-owner-key`, `CADRE_OWNER_KEYS`, and an
invitation's `ownerKeys` list) reach `trustOwnerKeys` with no shape check at all. A typo there
is fail-safe (a bad pin can never grant trust) but undiagnosable: the node starts, looks
healthy, and then rejects every seed with a message about the *seed's* signer rather than about
the pin. Same class of defect, different store, and the invite-sourced route needs a decision
the other two do not — so it is its own ticket rather than scope creep here.

**Recorded as a tripwire, not a ticket:** the decode-failure message interpolates the entire
rejected value so an operator can see their typo. Fine for a key typed at a terminal; if a
caller ever passes a value that came from a remote peer, an unbounded echo becomes an unbounded
log line. Parked as a `NOTE:` comment at the throw site in `ed25519-key.ts`.

**Noted, no action:** the blank-value branch restates the message from `requireNonBlank` in
`cadre-node.ts` rather than sharing it. Deduplicating means either moving a general-purpose
identifier guard into a key-specific module or adding a module for six lines, and
`cadre-node.ts` cannot be the source since it already imports `ed25519-key.ts`. One duplicated
string, both in `cadre-core`, judged the lesser cost.

**Empty categories:** no correctness, error-handling, resource-cleanup, or type-safety defects
found in the diff beyond the swallowed cause noted above — the function is eleven lines with no
allocation, no I/O, and no async, and both callers propagate its throw without catching.

## Verification

- `yarn workspace @serfab/cadre-core test` — 81 files, 1264 passed, 1 pre-existing skip
  (win32-gated `key-store.spec.ts`), 0 failures.
- `yarn workspace @serfab/cadre-cli test` — 13 files, 161 passed, 0 failures.
- `yarn workspace @serfab/cadre-core test test/ed25519-key.spec.ts` after the added
  cause-preservation test — 15 passed.
- `yarn workspace @serfab/cadre-core build` — clean (required before the CLI tests, which
  resolve `@serfab/cadre-core` through its build output).
- `yarn lint` (whole repo, not just touched files) — **0 errors**. Six warnings, all
  `Unused eslint-disable directive` in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, a scratch
  scenario added by the in-flight `control-delete-while-alone-tombstone` work and untouched by
  this ticket. Pre-existing and outside this diff; the root `lint` script is a bare `eslint .`
  with no `--max-warnings`, so the gate is green.
- `yarn eslint` on the four files this review touched — clean.
