---
description: If the lending computer is shut down at the exact moment it is setting up a machine for a friend, that half-finished loan is remembered forever and permanently uses up one of the friend's allowed machines.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-store.ts
difficulty: easy
---

# A donation stuck mid-setup permanently consumes the requester's quota

Pre-existing; noticed while reviewing `donated-node-respawn-core` (that ticket
did not cause it and does not touch it).

## What happens

Each person the host lends nodes to gets a cap on how many they may run at once.
A loan counts against that cap while it is in any of three states: being set up,
set up and waiting to be handed its join credentials, or fully joined.

The host writes the "being set up" row to disk *before* it starts the child
process. If the host dies in that window — power loss, a kill during a slow
spawn — the row survives with nothing left to advance it. On restart no code path
moves it forward, and the existing cleanup sweep only collects loans stuck in the
*waiting-for-credentials* state, not this one.

The result: a row that will never become a node, still counted against the
requester's cap. Enough of them and the requester can no longer provision
anything, with no way to clear them but hand-editing the host's `donations.json`.

## Expected behaviour

A loan that has been stuck mid-setup for longer than any plausible spawn should
be cleaned up automatically — resolved to a terminal state so it stops counting
against the cap — the same way an abandoned waiting-for-credentials loan already
is. Cleanup must not disturb a setup that is genuinely still in flight, and it
should reclaim any host resources the half-finished spawn left behind.
