description: A typo in an operator-supplied trusted-owner key is accepted at startup and only shows up much later as "this node won't join", with no message pointing at the typo.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/start-pins.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-trusted-owners.spec.ts, packages/cadre-core/src/ed25519-key.ts
difficulty: easy
----

# Pinned owner keys accept malformed values

## Status: implementation already landed in the plan pass

The design question this ticket exists to resolve (see "Decision" below) had a clear
default, so the plan pass went ahead and implemented, tested, and verified it rather than
handing off an open question. **The code below is already written and all tests pass** —
this ticket is a verify-and-commit handoff, not a from-scratch implementation.

## What changed

Same up-front shape check the replicated control keys already have
(`requireEd25519PublicKeyB64` in `packages/cadre-core/src/ed25519-key.ts`, unchanged by
this ticket) is now applied to all three pinned-owner-key ingestion routes:

1. **`--pin-owner-key` flag / `CADRE_OWNER_KEYS` env** — `packages/cadre-cli/src/commands/start.ts`:
   - `collectPinnedOwnerKeys` is unchanged (still just trims/dedupes; kept easy to unit-test
     against plain placeholder strings).
   - New `validatePinnedOwnerKeys(keys: string[]): string[]` maps each key through
     `requireEd25519PublicKeyB64(key, 'pinned owner key (--pin-owner-key / CADRE_OWNER_KEYS)')`.
   - The `start` command action now calls
     `validatePinnedOwnerKeys(collectPinnedOwnerKeys(...))` before building the trust
     policy / node config. A malformed pin throws, which the action's existing top-level
     try/catch turns into a `console.error` + `process.exit(1)` — refuses to start, names
     the bad value, exits non-zero.

2. **`CadreNodeConfig.trustedOwners.pinnedKeys`** (the config path `start.ts` also feeds,
   and any other embedder that constructs `CadreNodeConfig` directly) —
   `packages/cadre-core/src/cadre-node.ts`, `initializeTrustedOwnerStore()`: now validates
   every pin (`requireEd25519PublicKeyB64(key, 'pinned owner key')`) **before** trusting
   any of them, so a malformed entry fails `start()` closed without partially anchoring
   the valid pins ahead of it.

3. **`CadreInvite.ownerKeys`** (the runtime enrollment seam) —
   `packages/cadre-core/src/cadre-node.ts`, `trustOwnerKeys()`: now validates every key
   in the batch up front (`Array.from(keys, key => requireEd25519PublicKeyB64(key, 'pinned owner key'))`)
   before trusting any of them. A malformed entry rejects the whole call before a single
   key is anchored.

### Decision: whole redemption fails, not drop-with-warning

For the invite route, the ticket asked us to decide between failing the whole redemption
vs. dropping the bad entry with a warning. Went with **whole redemption fails** (all three
routes are now atomic: validate everything, then trust everything, or trust nothing) —
matching the existing whole-record-or-nothing policy the persistent trusted-owner store
already applies to a corrupt snapshot entry (`trusted-owner-store.ts`'s
`unusableEntry: 'discard-all'`), and matching the ticket's own "Expected behavior" bullet
("An invitation whose `ownerKeys` list contains a malformed entry is refused as a
malformed invitation"). Silently dropping an entry would re-introduce the same
diagnosability gap this ticket exists to close — a redemption that "worked" but silently
anchored fewer owners than the invite claimed.

This is documented in `trustOwnerKeys()`'s docstring in `cadre-node.ts`.

## Tests added / updated

- `packages/cadre-cli/test/start-pins.spec.ts` — new `describe('validatePinnedOwnerKeys')`
  block: valid keys pass through unchanged; a malformed entry throws naming the bad value;
  a non-base64url entry throws with a message pointing at "pinned owner key".
- `packages/cadre-core/test/cadre-node-trusted-owners.spec.ts` — the two existing tests
  that used non-shaped placeholder strings (`'PINNED_INVITE_KEY'`, `'RUNTIME_KEY'`) now use
  real generated Ed25519 keys (they'd otherwise now fail validation). Two new tests added:
  `trustOwnerKeys rejects a malformed key and anchors none of the batch` (mixed
  good+bad batch → whole call rejects, the good key is NOT anchored), and
  `a malformed config pin fails start() closed`.

## Verification already run

- `yarn workspace @serfab/cadre-core build` and `yarn workspace @serfab/cadre-cli build` —
  both clean.
- `cadre-core` full suite: 1392 passed, 1 skipped, **5 failed** — all 5 are the
  pre-existing, already-tracked `control-revocation-reissue.spec.ts` /
  `control-revocation-replay.spec.ts` failures (see
  `tickets/.pre-existing-known.md` → `10-revocation-reissue-same-pk-update-unique-collision`,
  blocked). Unrelated subsystem (schema-level UNIQUE-constraint collision on revocation
  reissue), not touched by this change. Do not re-triage.
- `cadre-cli` full suite: 181/181 passed.
- `yarn eslint` on all five touched files: clean.

## TODO (for the implement-stage / reviewer pass)

- Skim the diff against the description above to confirm it matches (no drift between
  this writeup and the actual code).
- No further coding expected — this is a confirm-and-forward to `review/`.

## Edge cases & interactions

- **Empty pin lists**: `validatePinnedOwnerKeys([])` / an empty `trustOwnerKeys([...])` /
  empty config `pinnedKeys` all no-op correctly (nothing to map/validate) — unchanged from
  before.
- **Partial-batch atomicity**: covered by the new `trustOwnerKeys rejects a malformed key
  and anchors none of the batch` test — a good key ahead of a bad one in the same call is
  NOT left anchored when the call rejects.
- **Idempotent re-trust of an already-anchored key**: unaffected — validation runs before
  `store.trust()`, which still short-circuits on an already-known key; re-validating an
  already-valid key on every call is cheap (no curve check, just decode + length).
- **Restart / stop()→start() cycle**: config-pin validation runs again on every `start()`
  via `initializeTrustedOwnerStore()`; since pins are re-validated and `trust()` is
  idempotent, this is a no-op for already-anchored valid pins.
- **cadre-host / cadre-provider spawning the CLI with `CADRE_OWNER_KEYS`**: unaffected by
  design — they set the env var for a real, already-Ed25519-shaped requester key from the
  donation flow, so validation passes through transparently. Their unit tests
  (`orchestrator-pin-keys.test.ts`, `container-owner-keys.test.ts`) stub a fake CLI, not
  the real `start` command, so they don't exercise this validation and needed no changes.
- **Off-curve-but-well-formed keys**: `requireEd25519PublicKeyB64` deliberately does not
  check curve membership (see its own docstring) — a 32-byte base64url string that decodes
  fine but isn't a real curve point still passes shape validation and fails later at
  signature-verification time, same as any other wrong key. Out of scope here (matches the
  prior `debt-control-key-enrollment-accepts-malformed-keys` ticket's same tradeoff).
