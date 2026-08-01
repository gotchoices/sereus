description: Add a test proving that when a sleeping group connection wakes back up, it comes back under the same network name it had before instead of a brand-new one.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts (launchConfigs retention ~L144/L218/L396-414, stopStrand clears at L451-465, resumeStrand at L406-446), packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts (new `describe('StrandInstanceManager resume transport identity')` block, lines 189-291)
difficulty: easy
----

# Pin that waking a hibernated strand reuses its transport identity

A cadre node runs each strand it participates in as its own network (libp2p) node with its own
network identity — a peerId derived once at launch from the cadre identity key plus the strand
id. Idle strands are put to sleep ("hibernated") and woken on demand. Waking rebuilds the strand's
runtime from a launch config the manager retained at launch, which is what makes the woken strand
come back under the *same* peerId. This ticket adds regression coverage for that guarantee; no
production code changed.

## What was added

Four new tests in a `describe('StrandInstanceManager resume transport identity')` block appended
to `packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts` (lines 189-291, after
the pre-existing `describe('StrandInstanceManager quiesce/resume (hibernation)')` block). They
reuse the file's existing `vi.mock` doubles for `@optimystic/db-p2p`'s `createLibp2pNode` and
`../src/strand-database.js`'s `StrandDatabase` — no new mocking infrastructure. A
`generateKeyPair` import from `@libp2p/crypto/keys` mints real `PrivateKey` values, matching the
pattern already used in `test/cadre-node-strand-launch-key.spec.ts`.

1. **`resume rebuilds the libp2p node with the same private key it launched with`** (L236) —
   starts a strand with a generated `PrivateKey`, quiesces, resumes, asserts the second
   `createLibp2pNode` call's `privateKey.raw` bytes equal the first call's (byte-equal, not just
   both-present).
2. **`resume overrides (bootstrap addrs, mode) replace only those fields, leaving the key
   untouched`** (L249) — same setup, resume passes `{ bootstrapNodes, mode }` overrides; asserts
   the rebuilt call received the new `bootstrapNodes` while `privateKey.raw` is unchanged.
3. **`a strand launched with no private key resumes with none`** (L267) — starts a strand with no
   `privateKey` in the config, quiesces, resumes; asserts both `createLibp2pNode` calls have
   `privateKey: undefined` (resume does not acquire one).
4. **`fully stopping a strand drops the retained config, so a later launch does not inherit the
   old key`** (L279) — starts with key A, quiesces, fully stops (`stopStrand`), asserts
   `resumeStrand` now rejects with `/not tracked/` (pre-existing behavior, re-asserted for
   context), then starts a *new* strand instance under the same strand id with key B and asserts
   the `createLibp2pNode` call used key B's bytes, not key A's — the retained launch config was
   actually dropped, not silently reused.

A `lastCreateLibp2pNodeArgs()` helper reads `mocks.createLibp2pNode.mock.calls` (cast through
`unknown[][]`, since the mock's `vi.fn` factory has no declared parameter type) to inspect the
most recent call's config object.

## Verification (re-run at implement stage, fresh checkout)

- `yarn vitest run test/strand-instance-manager-hibernation.spec.ts` from `packages/cadre-core`:
  **11/11 passed** (7 pre-existing + 4 new). No stale-build guard issue this run (the planning
  pass had hit one against the linked `../optimystic` sibling checkout; not reproduced here).
- `yarn typecheck` from `packages/cadre-core`: clean, exit 0.
- `yarn lint packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts` from repo
  root: clean, exit 0.

## Edge cases & interactions (for the review pass to check each is actually exercised)

- **Byte-equality, not just "defined"**: a regression that rebuilds `resumeConfig` from scratch
  (e.g. drops `...launchConfig` spread, or reconstructs `privateKey` some other way) could still
  leave `privateKey` *truthy* while being a different key. Test 1 compares `.raw` bytes, not
  presence.
- **Override interaction**: `resumeStrand`'s override merge (`{ ...launchConfig, bootstrapNodes:
  overrides?.bootstrapNodes ?? ..., mode: overrides?.mode ?? ... }`) only touches two named
  fields. Test 2 pins that a broader refactor of that merge (e.g. switching to a shallow object
  merge from the overrides object itself) can't silently start dropping `privateKey`. Both
  `bootstrapNodes` and `mode` are set explicitly at initial launch (not left absent), so the
  override in this test is visibly *replacing* a prior value, not just filling a gap.
- **No-key path**: a strand launched without a `privateKey` relies on libp2p generating its own
  transient key each `createLibp2pNode` call. Test 3 guards against a future change that starts
  synthesizing/caching a key across quiesce/resume for this case, which would silently change a
  currently-ephemeral-per-runtime-build strand's identity behavior.
- **Full-stop boundary**: quiesce alone must retain the config (existing coverage); only a full
  `stopStrand` clears `launchConfigs`. Test 4 ties that config-clearing behavior (already covered
  generically by the pre-existing "stopStrand after quiesce... clears the retained launch config"
  test) specifically to the key not leaking into a same-id relaunch.
- **Not covered here (known, intentional gap)**: real libp2p peerId derivation/stability
  end-to-end — this suite mocks `createLibp2pNode` entirely, so it proves the *config* passed to
  that call is correct, not that libp2p itself would honor it. That correspondence is covered
  elsewhere: `cadre-node-strand-launch-key.spec.ts` for launch-time derivation, real-node
  integration suites for end-to-end peerId stability. Flagging so review doesn't treat it as a
  missed case — it's out of scope by design of this mocked unit-test suite.

## Suggested usage for the reviewer

- Confirm the 4 new tests actually fail if the guarantee is broken: e.g. temporarily change
  `resumeStrand` to build a fresh `privateKey`-less config instead of spreading `launchConfig`,
  confirm tests 1/2/4 fail, then revert — proves the assertions aren't vacuously true.
- Check byte-equality assertions use real `Uint8Array`/buffer comparison (not reference equality
  that'd pass even when both are `undefined`).

No known gaps beyond the intentionally out-of-scope end-to-end peerId item above. No follow-up
tickets expected from this change; it is test-only.
