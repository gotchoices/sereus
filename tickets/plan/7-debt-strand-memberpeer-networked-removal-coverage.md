----
description: The new "clear a removed member's device records" feature is only tested on a single node; the failure it was built to detect can only happen when real machines talk over the network, so that safety net is currently unproven.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-membership-writer.ts (removeMemberPeer, listMemberPeers, scanMemberPeerIds)
difficulty: medium
----

# Device-record removal has no real-network test

## What is missing

A manager can now list a member's device records and delete them one at a time. Every test
of that lives in `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts`, which
runs a strand entirely inside one process. That is enough to prove the permission rules, but
not the part that actually motivated the safety net.

`removeMemberPeer` re-reads the record after deleting it and raises an error if it is still
there. It does that because the storage layer, when asked for one exact record by its full
key, sometimes answers "not found" for a record that provably exists — but only when the
lookup has to cross the network. In a single process the lookup never misses, so the guard
has never fired in a test and its error path is unproven.

The same gap covers the ordinary happy path: no test has ever removed a device record on a
real two-node strand.

## What good looks like

The existing real-network scenario
(`strand-membership-closed-strand-e2e.integration.ts`) already stands up two nodes, admits a
member, and registers a device record for it. Extending it to also remove that record —
both by the member itself and by a manager after a revocation — would exercise the real
path.

Expected behaviour:

- On a real two-node strand, a member removes its own device record and both nodes see it gone.
- After a manager revokes a member, the manager lists that member's leftover device records
  and clears each one; both nodes see them gone.
- If the storage layer's exact-key lookup does miss, the removal reports a clear failure
  rather than quietly claiming success.

## Why it is not urgent

Nothing in the running system reads device records yet — they are written but never
consulted — so a stale or unremovable record cannot currently affect behaviour. The
consequence of a missed lookup is a removal that silently does nothing, which is an
availability problem, never a permissions one: a missed lookup can only remove too little,
never too much.

Related: the underlying storage-layer weakness is tracked separately as
`debt-composite-pk-point-lookup-unreliable-untracked`.
