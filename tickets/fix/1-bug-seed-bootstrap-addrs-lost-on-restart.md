---
description: A machine that is invited to a group but cannot reach it on its first try will keep retrying — until it is restarted, at which point it forgets where the group is and gives up forever.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-cli/src/commands/start.ts
difficulty: medium
---

# Seed bootstrap addresses do not survive a restart

## What happens

Joining a party works like this: the newcomer is handed a **seed** — a small signed
bundle naming the party's owner machines and the network addresses they can be reached
at. Applying the seed makes the newcomer dial those owners. If that dial fails (owner
briefly offline, network hiccup, not yet approved), the newcomer now keeps retrying in
the background until it gets in. That retry was added by `cold-start-control-redial` and
works.

The addresses it retries against are held **only in memory**. Restart the process — a
phone app relaunch, a container restart, a crash — and they are gone. The newcomer has
nothing left to dial and no record of the party in its database (that database only fills
in *after* a connection succeeds), so it is stranded permanently, exactly as it was
before the retry existed.

## Why it matters

The failure needs no unusual conditions: "applied a seed while the owner happened to be
unreachable, then restarted" is an ordinary Tuesday for a mobile app. From the user's
point of view the invitation silently does nothing, forever, with no error and no way to
tell the difference between "still trying" and "gave up". The only recovery is for a
human to obtain and apply a fresh seed.

## Expected behaviour

A node that has accepted a seed should still be trying to reach that party after a
restart — with no operator action and no second seed. Whatever a node needs in order to
find its way back into a party it was legitimately invited to should outlive the process
that received the invitation.

## Notes for whoever picks this up

- The in-memory holder is `CadreNode.controlBootstrapPeers` (peer id → the seed's
  addresses), filled by `recordSeedBootstrapPeers` on both seed intake paths.
- Applying a seed writes nothing to the control database — it only populates the libp2p
  peer store and dials. So there is currently no on-disk trace that a seed was ever
  applied.
- The headless CLI partly masks this: `cadre-cli start --seed <blob>` re-applies the seed
  on every start, so an operator who keeps passing `--seed` never sees the bug. Nodes
  that receive a seed at runtime — over the `/sereus/seed/1.0.0` protocol, or via the
  host's `PUT /grants/:id/seed` donation flow — have no such second chance.
- Anything persisted here is attacker-influenced only to the extent the seed was: seeds
  are signature-checked against a trust anchor before they are accepted. Worth deciding
  whether re-validation on load is wanted anyway.
- Storage is not uniform across targets (node, browser, React Native), so "just write a
  file" is not automatically the answer — see how the trusted-owner anchor and key store
  solve the same problem.
