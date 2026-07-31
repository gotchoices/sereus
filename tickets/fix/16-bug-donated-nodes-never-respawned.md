---
description: When a machine someone lent to another person's group crashes or the lending computer reboots, nothing ever starts it up again — the loan is silently dead until a human notices and the borrower asks for a new machine.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/server/routes/nodes.ts
---

# A donated node is never restarted after it dies

## What is wrong

cadre-host spawns a donated node once, from `DonationService.provision`, and that is the only
call to `createContainer` in the whole donation flow. Nothing brings it back afterwards:

- `HostProcessOrchestrator.init()` re-attaches to surviving children and marks the rest dead.
  It exposes them through `listDeadHandles()`, which **no production code calls** — only a test.
- `bin/host.ts` re-spawns the host's *own* owner node (when the founder role is enabled) and
  nothing else.
- The `/api/nodes/:id/start` and `/api/nodes/:id/restart` routes deliberately refuse
  non-owner nodes with `not_implemented`, pointing the caller at the donation surface — which
  has no restart operation.
- The only sweep that touches donations, `reapStaleAwaitingSeed`, *terminates* records rather
  than reviving them, and only ones still awaiting a seed.

So a donated node that crashes, is OOM-killed, or dies with the machine on a reboot stays
dead. Its donation record still reads `seeded`, the borrower's group silently loses the
capacity, and the only recovery is for the borrower to notice and provision a fresh node.

This is reachable by nothing more exotic than rebooting the lending computer.

## Expected behaviour

A donation that has not been terminated is expected to be *running*. When its node process
is gone, the host brings it back — on host startup and while the host is up — without the
borrower asking again and without operator action. The node comes back as the same node the
borrower's group already approved (see the `donated-node-durable-identity` work, which is what
makes that possible at all).

A donation the operator or borrower terminated must stay terminated, and a node that fails
repeatedly must not be respawned in a tight loop forever.

## Open questions for whoever plans this

These are policy decisions, not implementation details, which is why this is a specification
and not a plan:

- What triggers a respawn — host startup only, the existing `onStateChange` exit signal, a
  periodic sweep, or all three?
- How many failures in what window before the host gives up, and what does the donation
  record say then (a new status? `error`?) so the borrower can see it rather than guess?
- The listen port is re-allocated per spawn, so a respawned node keeps its peer id but
  announces a different port. Is republishing its own `CadrePeer` row on reconnect enough, or
  should the port be persisted with the handle and reused?
- Does the borrower need a signal that their node bounced, and if so over what surface?
