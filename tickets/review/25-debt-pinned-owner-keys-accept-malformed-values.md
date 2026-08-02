description: A typo in an operator-supplied trusted-owner key used to be accepted at startup and only surface much later as "this node won't join", with no message pointing at the typo. That gap is now closed.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/start-pins.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-trusted-owners.spec.ts, packages/cadre-core/src/ed25519-key.ts
difficulty: easy
----

# Pinned owner keys now reject malformed values at the point of entry

## What changed

All three places a pinned owner key can enter the system now run the same
base64url/32-byte shape check the replicated control keys already had
(`requireEd25519PublicKeyB64` in `packages/cadre-core/src/ed25519-key.ts`, itself
unchanged by this ticket):

1. **`--pin-owner-key` flag / `CADRE_OWNER_KEYS` env** (`packages/cadre-cli/src/commands/start.ts`) —
   new `validatePinnedOwnerKeys(keys: string[]): string[]` (line 63) validates every key
   before the `start` action builds the node config. A malformed pin throws, caught by the
   action's top-level try/catch → `console.error` naming the bad value + `process.exit(1)`.
   `collectPinnedOwnerKeys` (trim/dedupe) is untouched, kept validation-free on purpose so
   it stays easy to unit-test with plain placeholder strings.

2. **`CadreNodeConfig.trustedOwners.pinnedKeys`** (`packages/cadre-core/src/cadre-node.ts`,
   `initializeTrustedOwnerStore()`, line 865) — every config pin is validated **before** any
   of them is trusted, so a malformed entry can't leave earlier valid pins anchored.

3. **`CadreInvite.ownerKeys`** (`packages/cadre-core/src/cadre-node.ts`, `trustOwnerKeys()`,
   line 950) — the runtime enrollment seam used when redeeming an invite. All keys in the
   batch are validated up front before any is trusted.

**Decision made (was the open question in the plan ticket): whole-batch atomicity.**
A malformed key anywhere in a batch (config pins, or an invite's `ownerKeys`) rejects the
*entire* call before a single key is anchored — not "drop the bad one, trust the rest with
a warning." This matches the persisted trusted-owner store's existing
whole-record-or-nothing policy for a corrupt snapshot entry (`trusted-owner-store.ts`'s
`unusableEntry: 'discard-all'`), and avoids silently anchoring fewer owners than an invite
claimed. Rationale is also recorded in `trustOwnerKeys()`'s docstring in `cadre-node.ts`.

## Test coverage for reviewer

- `packages/cadre-cli/test/start-pins.spec.ts` → `describe('validatePinnedOwnerKeys')`:
  valid keys pass through unchanged; a malformed entry throws naming the bad value and the
  source ("pinned owner key (--pin-owner-key / CADRE_OWNER_KEYS)"); a non-base64url entry
  throws too.
- `packages/cadre-core/test/cadre-node-trusted-owners.spec.ts`:
  - Two pre-existing tests that used non-shaped placeholder strings (`'PINNED_INVITE_KEY'`,
    `'RUNTIME_KEY'`) now use real generated Ed25519 keys — they would otherwise now fail
    validation, which is itself a signal the new check is live.
  - New: `trustOwnerKeys rejects a malformed key and anchors none of the batch` — a
    good+bad mixed batch rejects the whole call, and the good key is confirmed NOT
    anchored (the atomicity guarantee).
  - New: `a malformed config pin fails start() closed`.

Run commands used during implementation (reviewer can re-run to confirm):
```
yarn workspace @serfab/cadre-core build
yarn workspace @serfab/cadre-cli build
yarn workspace @serfab/cadre-core test
yarn workspace @serfab/cadre-cli test
yarn eslint packages/cadre-cli/src/commands/start.ts packages/cadre-cli/test/start-pins.spec.ts packages/cadre-core/src/cadre-node.ts packages/cadre-core/test/cadre-node-trusted-owners.spec.ts packages/cadre-core/src/ed25519-key.ts
```

Results (re-confirmed during this review pass, not just claimed by the plan pass):
- Both builds clean.
- `cadre-core`: 1392 passed, 1 skipped, 5 failed — all 5 are the already-tracked
  `control-revocation-reissue.spec.ts` / `control-revocation-replay.spec.ts` failures in
  `tickets/.pre-existing-known.md` → `10-revocation-reissue-same-pk-update-unique-collision`
  (blocked). Unrelated subsystem (schema-level UNIQUE-constraint collision on revocation
  reissue). Not re-reported.
- `cadre-cli`: 181/181 passed.
- `yarn eslint` on all five touched files: clean.

## Known gaps (carried from the plan pass, not closed by this ticket)

- **Off-curve-but-well-formed keys are still accepted.** `requireEd25519PublicKeyB64`
  deliberately only checks base64url decode + 32-byte length, not curve membership (see
  its own docstring). A well-formed-but-invalid-curve-point key still passes this check
  and fails later at signature-verification time instead — same tradeoff the earlier
  `debt-control-key-enrollment-accepts-malformed-keys` ticket made for replicated control
  keys. If a reviewer wants curve-membership validation closed too, that is a new ticket,
  not a defect in this one.
- **`cadre-host` / `cadre-provider` callers untouched.** They set `CADRE_OWNER_KEYS` for
  real, already-Ed25519-shaped keys from the donation flow, so they're unaffected by
  design. Their existing unit tests (`orchestrator-pin-keys.test.ts`,
  `container-owner-keys.test.ts`) stub the CLI rather than exercising the real `start`
  command, so they don't cover this validation path either way.

## Review checklist

- Confirm `validatePinnedOwnerKeys` runs BEFORE `pinnedKeyTrustPolicy(pinnedKeys)` is
  built in `start.ts` (line 119) — i.e. a malformed key can never reach the trust policy
  construction, not just the `CadreNodeConfig`.
- Confirm the "anchors none of the batch" test actually asserts the good key is absent
  from the store afterward (not just that the call rejected) — that's the atomicity claim,
  not just a "throws" claim.
- Confirm `git status`/diff shows only the five files listed above — no incidental changes
  elsewhere.
