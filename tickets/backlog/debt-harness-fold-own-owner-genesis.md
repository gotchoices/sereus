description: Two integration test files still write out the three lines that make a node its own owner, even though a shared helper already does exactly that; they can call the helper instead.
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts
difficulty: easy
tradeoffs: Test-only tidy with no user-visible effect; a maintainer may decline because in these two files the genesis pair sits right beside a later restart that re-wires seed-bootstrap on its own, and folding only half of that symmetry can read as less clear than the explicit lines.
----

# Two scenarios hand-roll the genesis that `makeOwnOwner` already is

## What is duplicated

`makeOwnOwner(node, key)` (`packages/integration-tests/src/harness/node-fixtures.ts`) makes a
freshly-started node its own control owner: derive the ed25519 pair from the libp2p key, insert
the public key into `OwnerKey`, and wire seed-bootstrap with the private key. About twenty-five
call sites across the scenario suite use it.

Three sites do not, and instead write the same two calls inline against a locally derived
key pair:

- `control-delete-while-alone-convergence.integration.ts` — the Phase-1 genesis (`insertOwnerKey`
  followed by `initializeSeedBootstrap`).
- `control-offline-read-after-restart.integration.ts` — the same pair in its Phase-1 founder
  bring-up.

Both files already hold the libp2p key (`aKey`) that `makeOwnOwner` takes, so each site is a
two-line-for-one-line substitution with no change to what the node ends up holding.

## Why they were left alone

Not an oversight in the helper's design: both files ALSO re-wire seed-bootstrap alone after a
restart (`initializeSeedBootstrap(privateKeyB64)` with no matching `insertOwnerKey`, because the
owner row survived on the reused store). That standalone re-wire genuinely needs the derived
private key in scope, so the local `ed25519KeyPairFromLibp2p(...)` destructure has to stay
either way. Folding the genesis pair therefore leaves a half-used destructure behind, which is
why it is a judgement call rather than an obvious cleanup.

Note the helper's signature does **not** need to change: it returns the owner public key, and
these sites keep their own private key for the restart path.

## Expected outcome

Each of the two files calls `makeOwnOwner` for its initial genesis and keeps its own derived
private key only for the post-restart re-wire, so `makeOwnOwner` is the single place genesis
happens. Both suites still pass unchanged — this is behaviour-preserving by construction, since
the helper's body is what the sites already inline.
