---
description: A new check that a lent-out machine really does save its network credentials to disk was written but never actually run, because the test it lives in takes several minutes and starts two real background programs.
files: packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts
difficulty: easy
---

# Run the node-donation scenario and confirm the new workdir assertions hold

## What is unverified

`cadre-host-node-donation.integration.ts` gained a step (`step 6b`) asserting that after a
real donated node accepts a real seed, its working directory on disk holds three things:

- `identity.key`, whose peer id matches the one the requester approved, and
- a `bootstrap-peers.<party>.json` file, and
- a `trusted-owners.<party>.json` file.

Those three are the whole point of giving a donated node a durable identity key — without the
key, the node's software never creates the other two files at all, and a restart forgets both
who the node is and the addresses it was told to dial.

The step compiles and the reasoning behind it was checked by reading the code paths, but the
scenario itself was **not executed** during the review that added it: it starts two real
peer-to-peer nodes and budgets 90 seconds apiece, which is longer than that review pass could
spend. So nobody has seen it pass.

## What to do

Run the scenario end to end and confirm the step passes. If it does, this ticket is done —
nothing to change.

If it fails, the interesting question is *which* of the three files is missing, because that
distinguishes two very different outcomes:

- The identity key is missing or its peer id doesn't match — the spawn wiring is wrong, and
  that is a real defect in the change this ticket came from.
- The key is there but one of the other two files is absent — then the durable identity is
  working but the node's own software is not creating its local records where we believed it
  would, which is a separate defect worth its own ticket.

Either way, file what you find rather than relaxing the assertion.

## Notes

The scenario needs `@serfab/cadre-cli` and `@serfab/cadre-host` built first (it resolves the
real CLI binary rather than a stub). Everything is loopback; no network access is required.
