---
description: When someone lends spare capacity to another person's group, the machine that gets lent out forgets who it is and how to reach that group every time it restarts, so the loan silently stops working.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-host/src/donation/donation-service.ts
difficulty: medium
---

# Donated nodes keep nothing across a restart

## What is wrong

`cadre-host` can lend a spare node to somebody else's group ("node donation"). The
requester sends their group's join information to that node once, over an internal
`POST /seed` call, and the node is then expected to keep working — including keeping
itself trying if the group was momentarily unreachable at that moment.

Two things are thrown away every time that node's process restarts:

- **Its network identity.** The lent-out node is launched with no identity key of any
  kind, so it generates a brand-new one on every start. The group that approved it
  approved the *old* identity; after a restart it is, to that group, a stranger.
- **The addresses it should keep dialing.** The just-landed durable store for those
  addresses is only opened when the node was launched with an identity key file
  (`packages/cadre-cli/src/commands/start.ts`). A lent-out node has none, so it silently
  falls back to the throwaway in-memory store — the exact case the store was built for.
  Nothing re-sends the join information after a restart either: the requester sends it
  once, on request, and never again.

The result is that a lent-out node that could not reach the requester's group on its
first try never gets in, and even one that *did* get in comes back after a restart as an
unrecognised machine.

## Where it comes from

`HostProcessOrchestrator.createContainer` (the lend-out path) writes the child's config
with no identity block and spawns `cadre-cli start` with no identity argument — unlike
`ensureOwnerNode`, which passes the host's own identity key. Every launcher other than
this one supplies an identity key, which is why the gap is specific to donated nodes.

## Expected behaviour

- A lent-out node keeps the same network identity across restarts of its process and of
  the host, so the group that approved it still recognises it.
- It keeps the addresses it was told to dial across those same restarts, and keeps
  retrying, with no second request from the requester and no operator action.
- Whatever it persists lives inside that node's own working directory, so terminating
  the loan and deleting that directory still removes everything.

## Notes

- Both node-local stores (`FileBootstrapPeerStore`, `FileTrustedOwnerStore`) are today
  gated on the identity key file's directory purely as a convenient location. The
  addresses are not secret and dialing grants no authority, so there is no security
  reason they must sit beside a key — the node's working directory would do. Whether to
  give donated nodes a real identity key file (which fixes both problems at once) or to
  decouple the stores from the key path is the call to make.
- The trusted-owner anchor recovers on its own for these nodes today, because the host
  re-supplies the pinned owner key through the environment on every spawn — so it is the
  identity and the dial addresses that actually go missing.
- The seed itself is never re-sent on restart (`DonationService.applySeed` is driven by
  the requester's one-time call), so "just re-seed it" is not an available recovery path.
