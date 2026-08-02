description: Four test files each keep their own copy of the same code for booting a test node that signs its own control writes; the shared helper exists and most call sites are migrated — finish the last file and confirm nothing broke.
files: packages/cadre-core/test/self-owner-node-helpers.ts, packages/cadre-core/test/validation-key-enrollment.spec.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/test/publish-formation-invite.spec.ts
difficulty: easy
----

# Finish hoisting the duplicated "self-owner node" test boot into the shared helper

## Progress so far (this is a continuation of `20-debt-self-owner-node-test-harness-duplicated`, split off under a `BUDGET_WARNING`)

The shared helper described by the original ticket has been created and three of the four
duplicate-holding spec files have been migrated to it. `npx tsc --noEmit -p packages/cadre-core`
is clean after these changes, but **the test suite itself has not been run yet** — only
typechecked. Do that first, before touching the remaining file, so a pre-existing regression
isn't mistaken for something the last file's edit introduced.

- **Created**: `packages/cadre-core/test/self-owner-node-helpers.ts` — exports
  `startSelfOwnerNode(partyIdPrefix: string, opts?: SelfOwnerNodeOptions): Promise<SelfOwnerNode>`
  where `SelfOwnerNode = { node: CadreNode; ownerKey: Ed25519KeyPair }` and `SelfOwnerNodeOptions`
  covers `enrollOwner` (default `true`), `strandWatchInterval`, `strandFilter`. Read this file
  before touching the last spec — its JSDoc explains the design.
- **Migrated, typechecked clean**: `publish-strand.spec.ts` (both describe blocks — the
  `publishStrand` suite's `startSelfOwnerNode(enrollOwner)` and the `addStrand` founder suite's
  separate `startNode()` both now call the shared helper), `strand-unpublish.spec.ts` (also
  dropped the old `WeakMap<CadreNode, Ed25519KeyPair>` tracking — `ownerKey` is now a plain
  `let` alongside `node`, set together via destructuring assignment, e.g.
  `({ node, ownerKey } = await startSelfOwnerNode('strand-unpublish-', { strandWatchInterval }))`),
  `publish-formation-invite.spec.ts`.
- **Not yet migrated**: `validation-key-enrollment.spec.ts` still has its own local
  `startSelfOwnerNode(enrollOwner = true)` (around line 44) with `partyId: 'validation-key-' + rand()`.
  Delete it and its now-unused `generateKeyPair`/`ed25519KeyPairFromLibp2p` imports (check first —
  `generateKeyPair` is still needed by the "throws when not started" test at the bottom of the
  file, which constructs a raw `CadreNode` directly; keep that import). Replace call sites
  (`node = await startSelfOwnerNode(true)` / `startSelfOwnerNode()` / `startSelfOwnerNode(false)`)
  with `({ node } = await startSelfOwnerNode('validation-key-', { enrollOwner: ... }));` — note
  one test (line ~153, "a redemption approved BEFORE removal survives the removal") independently
  re-derives the owner key via `ed25519KeyPairFromLibp2p((node as unknown as {...}).identityKey)`
  rather than using the helper's returned `ownerKey` — leave that test's derivation as-is, it is
  not part of this duplication (it reads the node's identity key directly, a different code path
  than the boot helper).

## Why this matters

Restated from the original ticket: any change to node construction (a new required option, a
different profile default, a teardown step) previously had to be applied in five places, and the
copies had already drifted — one took an `enrollOwner` flag the others didn't. The shared helper
fixes that once these four files all use it.

## TODO

- Run `yarn workspace @serfab/cadre-core test` (or `cd packages/cadre-core && npx vitest run`)
  filtered to at least the four affected spec files (`publish-strand`, `strand-unpublish`,
  `publish-formation-invite`, `validation-key-enrollment`) to confirm the three already-migrated
  files still pass — this has not been done yet, only `tsc --noEmit` was checked.
- Migrate `validation-key-enrollment.spec.ts` per the "Not yet migrated" section above.
- Run `npx tsc --noEmit -p packages/cadre-core` again — must stay clean.
- Run the full test command again to confirm the fourth file's migration didn't change behavior
  or drop coverage (same assertions run, same pass/fail outcome as before the refactor).
- Run `yarn lint` on the touched files (unused-import / unused-var rules are the ones most
  likely to catch a leftover from this kind of edit).

## Edge cases & interactions

- `strand-unpublish.spec.ts`'s `deleteStrandRow` helper now takes the owner key as an explicit
  parameter (`deleteStrandRow(n: CadreNode, key: Ed25519KeyPair, strandId: string)`) instead of
  looking it up from the old `WeakMap`. Both call sites were updated — confirm neither regressed
  when running that file's tests (the watcher-driven "sibling removal" tests are the ones that
  exercise this path).
- The shared helper always constructs `CadreNodeConfig` with `strandWatchInterval` and
  `strandFilter` passed through (`undefined` when not given) — confirm this is equivalent to the
  original per-file behavior of only spreading `overrides` when present (it should be: passing
  `strandWatchInterval: undefined` in an object literal has the same effect on `CadreNodeConfig`
  as omitting the key, since the type declares it optional and nothing in `CadreNode`
  distinguishes "key absent" from "key present with value `undefined`" — verify this holds if the
  test run above surfaces anything unexpected in the two watcher-interval tests).
- Each spec passes a distinct `partyIdPrefix` to the shared helper (`'publish-strand-'`,
  `'addstrand-founder-'`, `'strand-unpublish-'`, `'publish-fi-'`, and the new
  `'validation-key-'`) — keep these distinct so parallel suites' control-network party ids never
  collide; don't consolidate them into one shared constant.
