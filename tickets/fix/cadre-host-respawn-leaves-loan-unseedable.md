description: When cadre-host restarts a donated node while the previous process for that node is still running, the new process dies on a port clash, the host records the restart's new seed token anyway, and the loan can never be completed — the still-running node rejects the host's seed with 401 and the donation is stuck at "awaiting_seed" forever.
files:
  - packages/cadre-host/src/orchestrator/host-process-orchestrator.ts (spawn / respawn, `.startup-token`, port reuse)
  - packages/cadre-host/src/orchestrator/port-allocator.ts (`reserveNodePorts`, reuse of a dropped handle's ports)
  - packages/cadre-host/src/donation/donation-service.ts (seed delivery, donation status)
repro: verified
----

# A respawned donated node leaves its loan permanently unseedable

## Observed (2026-09-16, cadre-host in donor mode on Windows)

A phone requested a node. The host provisioned `grn_1SrppkgMdQprQKAh` on ports 10010–10014 and the
node came up: its log shows the usual "Pinned 1 owner key(s)", "Health server on port 10010",
"Connected to control network". Then the same container was spawned a **second** time:

```
Starting cadre node...
✓ Pinned 1 owner key(s) for cold-start seed trust
Failed to start cadre node: listen EADDRINUSE: address already in use 0.0.0.0:10010
```

The second process died because the first was still holding the ports. Its consequences persisted:

- `<workdir>/.startup-token` for that container is **empty**, while every healthy container's file
  holds its token.
- `donations.json` for the donation was rewritten with a **new** `seedToken` (observed changing from
  `5rFXDip0…` to `0xyKasuH…` between two reads).
- The live node still expects the **original** token, so the host's seed delivery is refused:
  `POST http://localhost:10010/seed` with the recorded bearer returns `401 {"success":false,"error":"unauthorized"}`
  (verified by hand against the running node).
- The phone's request fails at the seeding stage with the host's own code `seed_failed`, surfaced as
  "The lent node would not accept this cadre's seed."
- The donation stays `awaiting_seed` and the node keeps running, holding its ports and its quota slot.

## Why it matters

The loan cannot recover: the token the host holds will never be accepted, and the grant's `maxNodes`
slot stays consumed by a node nobody can use. The user-visible message blames the node ("would not
accept this cadre's seed"), which points away from the actual fault.

## Where to look

- What triggered a respawn while the original was alive? A health check, a watchdog on
  `awaiting_seed`, or state reconciliation at startup are the candidates. The original process was
  healthy throughout (`/health` answered 200 the whole time).
- A respawn that fails must not leave the recorded token, the `.startup-token` file and the running
  process disagreeing. Either keep the old token when the new spawn fails, or tear the old process
  down first and only then rotate — but not both halves independently.
- `EADDRINUSE` on any of a node's five ports should fail the respawn loudly and restore the previous
  handle's state, rather than being swallowed into a half-updated record.
- Consider making the node's seed endpoint report *why* it refused (token mismatch vs malformed seed)
  in its log; nothing on the node side recorded the rejected attempt, which made this slow to find.

## Repro sketch

Provision a donation, let the node come up, then force a second spawn of the same container (or
restart the host while the child survives). Expect: the second spawn fails on ports, and the donation
is left unseedable with a token the live node will not accept.
