description: Added an automated test proving that when a device joins a group chat, that group's network connection actually announces itself under its own separate network identity instead of accidentally reusing the device's main connection identity.
files: packages/cadre-core/src/cadre-node.ts (launchStrand ~L3161-3212, unchanged), packages/cadre-core/src/strand-transport-key.ts (unchanged), packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts (new)
----

# Cover the strand-launch wiring, not just the key helper

## What was done

The ticket arrived with `packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts` already
drafted (uncommitted) in the working tree. This run verified the draft rather than writing new
code:

- Read current `launchStrand` (`cadre-node.ts:3161-3212`) and confirmed the ordering claim in
  the ticket still holds: `transportKey` is derived (L3182-3184) strictly before
  `resolveCohortSeed` is called (L3191), so the seed-resolution short-circuit
  (`resolveCohortSeed` returning an empty seed when `controlNode`/`controlDatabase` are unset)
  cannot mask or substitute for the key-derivation path under test.
- Read the draft spec and the injection pattern it copies from
  `test/cadre-node-strand-seed.spec.ts` (private-field injection via `as unknown as {...}`
  casts, no real libp2p node started). Pattern is consistent between the two files.
- No production code changes — test-only ticket, and none were needed.

## Coverage added (`cadre-node-strand-launch-key.spec.ts`, 4 tests)

- Launching a strand hands `startStrand` a `privateKey` whose peerId differs from the control
  node's identity peerId.
- That key is byte-equal (`.raw`) to `strandTransportKey(identityKey, strandId)` — i.e. the
  actual derived key, not merely *a* distinct key (a freshly generated random key would also be
  distinct but would break peerId stability across hibernate/wake).
- Two strands launched sequentially on the same node get two distinct keys (no cross-call state
  leakage).
- With no identity key configured, `privateKey` is `undefined` (real production path — nodes
  without `keyStore`/`privateKey` configured — not just a defensive branch).

## Validation

- `yarn vitest run test/cadre-node-strand-launch-key.spec.ts` from `packages/cadre-core` —
  **4/4 passed**, isolated run.
- `yarn eslint packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts` from repo root —
  **clean**.
- `yarn vitest run` (full `packages/cadre-core` suite) — **76 files / 1195 passed, 1 skipped**,
  no failures, no interaction with the new spec (shared `debug` namespaces, ports, etc. all
  fine).

## Gaps for the reviewer

- This run only ran `packages/cadre-core`'s own suite, not the monorepo-wide test/typecheck
  gates (`yarn workspace @serfab/cadre-core typecheck`, cross-package `integration-tests`, or
  other packages that might import `cadre-node.ts`). Nothing in this ticket's diff touches
  exported types or call signatures, so a wider run is expected to be a formality, but it was
  not executed here.
- The single pre-skipped test in the full-suite run was not investigated — not part of this
  ticket's file list and present in isolation runs too (pre-existing, not introduced by this
  diff).
