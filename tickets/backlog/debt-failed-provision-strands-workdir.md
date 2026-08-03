---
description: When the lending computer fails to start a machine it agreed to lend out, the folder it created for that machine is left behind on disk with nothing able to remove it.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts
repro: static
---

# A provision that never spawns leaves its working directory behind

Noticed while planning `debt-failed-respawn-strands-donated-workdir`. Same
symptom (an undeletable working directory), different and simpler cause, so it
is filed separately rather than folded in.

## What happens

When someone redeems a grant, `DonationService.provision` writes a donation
record and then asks the orchestrator to start a node. The orchestrator's first
step is to create that node's working directory and write it an identity key —
`createContainer` calls `ensureNodeIdentity(workdir)` before anything else,
precisely so an unreadable key fails before any port is reserved.

If the spawn then fails for any reason, the record is marked `error` and the
call throws. But the record never got a handle id (`dockerId`), because none was
ever produced. Every cleanup path keys off that id:

- `terminate()` skips its stop-and-reclaim entirely when the record has no
  `dockerId`;
- the stuck-`provisioning` reap asks the orchestrator to resolve the id from the
  container name, and there is no handle to resolve.

So `<rootDir>/<donationId>/` stays on disk — an `identity.key`, and whatever
else the failed spawn got as far as writing — with nothing that will ever remove
it. Every failed provision adds another.

## Why it is not urgent

The directory is small (a keypair plus, at most, a config file and an empty log)
and a provision that fails outright is rare — it means the host could not start
a child process at all. Nothing is leaked besides disk: no ports are held, and
the record is correctly marked `error`, so the grant's quota frees.

## What is wanted

A provision whose spawn never produced a handle should not leave a working
directory behind. Either the orchestrator cleans up a workdir it created for a
spawn that never started, or the donation layer reclaims by container name.

**The obvious shortcut is wrong.** Deleting the workdir on any failed
`createContainer` would break the re-spawn path, where the *whole point* of the
surviving workdir is that the node comes back with the same identity key and the
same node-local stores. Whatever is built must distinguish "this spawn created
the directory" from "this spawn was reusing an existing one".

Worth checking as part of the work: whether `cadre-provider`'s equivalent path
has the same hole, and whether a periodic sweep for workdirs no donation record
names is a better shape than an unwind-on-failure.
