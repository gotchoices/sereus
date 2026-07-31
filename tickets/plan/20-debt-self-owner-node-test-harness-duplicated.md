description: Four test files each keep their own copy of the same code for booting a test node that signs its own control writes; move it to one shared helper so a fix lands once instead of four times.
files: packages/cadre-core/test/publish-strand.spec.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/test/publish-formation-invite.spec.ts, packages/cadre-core/test/validation-key-enrollment.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, packages/cadre-core/test/membership-gate-helpers.ts
difficulty: easy
----

# Hoist the duplicated "self-owner node" test boot into one helper

## What is duplicated

Several control-plane specs need the same starting point: a running `CadreNode` whose libp2p
identity key is also enrolled as an owner key, so the writes the node signs for itself pass
the control schema's authorization constraints. Each spec grew its own copy:

- `packages/cadre-core/test/publish-strand.spec.ts` — **twice**: `startSelfOwnerNode(enrollOwner)`
  in the publish describe, and a second `startNode()` in the `addStrand` founder describe.
- `packages/cadre-core/test/strand-unpublish.spec.ts` — `startSelfOwnerNode()`.
- `packages/cadre-core/test/publish-formation-invite.spec.ts`.
- `packages/cadre-core/test/validation-key-enrollment.spec.ts`.

The bodies are near-verbatim: generate an Ed25519 key, derive its base64 public key via
`ed25519KeyPairFromLibp2p`, construct a `CadreNode` with a unique party id and no bootstrap
nodes, `start()`, then `insertOwnerKey(publicKeyB64)` on the control database.

## Why it matters

Any change to node construction (a new required option, a different profile default, a
teardown step) has to be applied in five places, and the copies have already drifted — one
takes an `enrollOwner` flag to cover the not-an-owner rejection path, the others do not.

## Expected outcome

One shared helper module under `packages/cadre-core/test/` exporting the boot (and its
enroll-or-not variant), with the four specs importing it and their local copies deleted.
The package already has this convention: `test/control-constraint-helpers.ts` and
`test/membership-gate-helpers.ts`. Test behavior and coverage must be unchanged.

## Relationship to the other helper-duplication ticket

Distinct from `backlog/debt-strand-spec-helpers-duplicated`, which covers duplicated
*strand-database* setup (opening a test database and seeding rows) across a different set of
`strand-*.spec.ts` files. Same class of cleanup, non-overlapping files; either can land first.
