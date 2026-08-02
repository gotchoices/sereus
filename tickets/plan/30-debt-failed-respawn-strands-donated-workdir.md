---
description: When the lending computer tries and fails to restart a machine it lent out, it forgets which process that machine was, so later cleanup can no longer delete the machine's files — they sit on disk forever.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/donation/donation-service.ts
difficulty: medium
---

# A failed re-spawn strands the donated node's working directory

Found during review of `donated-node-respawn-core`. Not reachable yet — nothing
calls `DonationService.respawn()` in production until the supervisor lands — but
it is wrong the moment that path runs, and a failed re-spawn is exactly what the
supervisor's retry/give-up logic exists to handle.

## What happens

Every donated node has a working directory on the host holding its identity key,
its config, its log, and its storage. The host tracks a running node by an opaque
handle id, and that id is recorded on the donation record.

`HostProcessOrchestrator.createContainer` now begins by discarding the handle
left over from any previous spawn of the same node (`dropStaleHandle`) — this is
what stops re-spawns from leaking ports. The discard happens *before* the new
child is launched. So if the launch then fails:

- the orchestrator no longer holds a handle for the old id, and
- the donation record still names that old id.

Cleanup goes through the recorded id. `stopContainer` and `removeContainer` both
look the id up and throw "Container not found"; `DonationService.terminate`
catches and logs that, so `terminate()` reports success while the working
directory is never deleted. The node also vanishes from the local UI's node list
even though its files are still there.

## Why it matters

The supervisor's give-up path sets the donation to `error` and expects a later
`terminate()` to reclaim the workdir. After a failed re-spawn that reclaim
silently does nothing, so identity keys and storage for dead loans accumulate on
the host with no way to remove them short of manual deletion.

## Expected behaviour

A re-spawn attempt that fails must leave the host able to fully clean up the
donation afterwards: `terminate()` deletes the working directory and the node
disappears from the node list, exactly as it would have without the failed
attempt. Whatever the fix, re-spawning must still not leak the four host ports
each spawn reserves — that leak is what `dropStaleHandle` was added to close.

Note the tension to resolve: the old handle's ports are released *before* the new
ports are allocated specifically so a re-spawn reuses the same ports. Keeping the
stale handle around until the launch succeeds changes that.
