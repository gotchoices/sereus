description: Add a test proving that when a sleeping group connection wakes back up, it comes back under the same network name it had before instead of a brand-new one.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts (launchConfigs retention ~L144/L218/L396-414, stopStrand clears at L451-465, resumeStrand at L406-446), packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts (new `describe('StrandInstanceManager resume transport identity')` block appended at the end)
difficulty: easy
----

# Pin that waking a hibernated strand reuses its transport identity

A cadre node runs each strand it participates in as its own network (libp2p) node with its own
network identity — a peerId derived once at launch from the cadre identity key plus the strand
id. Idle strands are put to sleep ("hibernated") and woken on demand. Waking rebuilds the strand's
runtime from a launch config the manager retained at launch, which is what makes the woken strand
come back under the *same* peerId.

## Status: implementation already done during planning

This ticket's scope turned out to be a single, well-bounded test addition with no open design
questions, so the planning pass wrote and validated it directly rather than deferring to a
separate implement run. The working tree already contains the change described below — this
ticket exists to carry it through the normal implement -> review handoff.

### What was added

Four new tests in a new `describe('StrandInstanceManager resume transport identity')` block
appended to `packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts` (after the
existing `describe('StrandInstanceManager quiesce/resume (hibernation)')` block). They reuse that
file's existing `vi.mock` doubles for `@optimystic/db-p2p`'s `createLibp2pNode` and
`../src/strand-database.js`'s `StrandDatabase` (hoisted `mocks` object, already in the file) — no
new mocking infrastructure needed. A `generateKeyPair` import from `@libp2p/crypto/keys` was added
at the top of the file to mint real `PrivateKey` values, matching the pattern already used in
`test/cadre-node-strand-launch-key.spec.ts`.

1. **`resume rebuilds the libp2p node with the same private key it launched with`** — starts a
   strand with a generated `PrivateKey`, quiesces it, resumes it, and asserts the second
   `createLibp2pNode` call's `privateKey.raw` bytes equal the first call's (byte-equal, not just
   both-present).
2. **`resume overrides (bootstrap addrs, mode) replace only those fields, leaving the key
   untouched`** — same setup, but resume passes `{ bootstrapNodes, mode }` overrides; asserts the
   rebuilt call received the new `bootstrapNodes` while `privateKey.raw` is still the original.
3. **`a strand launched with no private key resumes with none`** — starts a strand with no
   `privateKey` in the config, quiesces, resumes; asserts both the first and second
   `createLibp2pNode` calls have `privateKey: undefined` (resume does not acquire one).
4. **`fully stopping a strand drops the retained config, so a later launch does not inherit the
   old key`** — starts with key A, quiesces, fully stops (`stopStrand`), asserts `resumeStrand`
   now rejects with `/not tracked/` (pre-existing behavior, re-asserted here for context), then
   starts a *new* strand instance under the same strand id with key B and asserts the
   `createLibp2pNode` call used key B's bytes, not key A's — i.e. the retained launch config was
   actually dropped, not silently reused.

A `lastCreateLibp2pNodeArgs()` helper reads `mocks.createLibp2pNode.mock.calls` (cast through
`unknown[][]` since the mock's `vi.fn` factory has no declared parameter type) to inspect the most
recent call's config object.

### Verification already run

- `yarn vitest run test/strand-instance-manager-hibernation.spec.ts` (from
  `packages/cadre-core`): **11/11 passed** (7 pre-existing + 4 new).
- `yarn typecheck` (from `packages/cadre-core`): clean, exit 0.
- `yarn eslint packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts` (from repo
  root): clean, exit 0.

One environment wrinkle hit during planning, not a code issue: the first test run failed with
"Stale build detected... `@optimystic/db-p2p`: dist is stale" from the repo's build-freshness
guard (`test-harness/build-freshness.ts`), because the linked sibling checkout at
`../optimystic` had edited `src` more recently than its `dist`. Ran `yarn workspace
@optimystic/db-p2p build` in `C:\projects\optimystic` to refresh it (that sibling repo's own
concern, not this one's — the guard is deliberately strict with no bypass, see the module
docstring), then re-ran the suite above green. If this recurs for the next agent, the same rebuild
is the fix; it is not a sereus defect.

## Edge cases & interactions

These are already covered by the four tests above — listed here so the review pass can check
each is actually exercised, not just asserted-adjacent:

- **Byte-equality, not just "defined"**: a regression that rebuilds `resumeConfig` from scratch
  (e.g. drops `...launchConfig` spread, or reconstructs `privateKey` some other way) could still
  leave `privateKey` *truthy* while being a different key. Test 1 compares `.raw` bytes, not
  presence.
- **Override interaction**: `resumeStrand`'s override merge (`{ ...launchConfig, bootstrapNodes:
  overrides?.bootstrapNodes ?? ..., mode: overrides?.mode ?? ... }`) only touches two named
  fields. Test 2 pins that a broader refactor of that merge (e.g. switching to a shallow object
  merge from the overrides object itself) can't silently start dropping `privateKey`.
  - Note the same test's initial `startStrand` call also disagrees with `createSAppConfig()` on
    the record — no such conflict exists here; both `bootstrapNodes` and `mode` are set explicitly
    at launch so the override is visibly *replacing* a prior value, not just filling an absence.
- **No-key path**: a strand launched without a `privateKey` relies on libp2p generating its own
  transient key each `createLibp2pNode` call. Test 3 guards against a future change that starts
  synthesizing/caching a key across quiesce/resume for this case (which would silently change a
  currently-ephemeral-per-runtime-build strand's identity behavior).
- **Full-stop boundary**: quiesce alone must retain the config (existing coverage); only a full
  `stopStrand` clears `launchConfigs`. Test 4 is the one place that ties the config-clearing
  behavior (already covered generically by the pre-existing "stopStrand after quiesce... clears
  the retained launch config" test) specifically to the key not leaking into a same-id relaunch.
- **Not covered here (out of scope)**: real libp2p peerId derivation/stability end-to-end — this
  suite mocks `createLibp2pNode` entirely, so it proves the *config* passed to that call is
  correct, not that libp2p itself would honor it. That correspondence is covered elsewhere (e.g.
  `cadre-node-strand-launch-key.spec.ts` for the launch-time derivation, and real-node integration
  suites for end-to-end peerId stability).

## TODO

- Confirm the four tests still pass on a fresh checkout (rerun `yarn vitest run
  test/strand-instance-manager-hibernation.spec.ts` from `packages/cadre-core`) — the sibling
  `../optimystic` build-freshness issue above is environment-dependent and may or may not recur.
- Hand off to `review/` with a normal implement handoff once confirmed; no further code changes
  are expected.
