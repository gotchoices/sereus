---
description: If someone ends their borrowed node at the exact moment the host is restarting that node after a crash, the host can record the loan as alive again and leave a node process running that nothing will ever clean up.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts
difficulty: medium
---

# Ending a loan mid-restart can resurrect it

## Background

cadre-host lends spare capacity: a friend's phone (the *borrower*) asks the host to run a node
for their own cadre. That node is a child process on the host's PC, so it can crash — and
`DonationSupervisor` restarts it (`DonationService.respawn`, `donation-service.ts:294`).

Two things can end a loan while a restart is under way:

- the borrower's own `DELETE /grants/:id`, which calls `DonationService.terminate`;
- the host's stale-`awaiting_seed` reap sweep, which also calls `terminate` (every 5 minutes,
  against a loan that was provisioned but never seeded).

`terminate` deliberately writes the record to `terminated` **first**, then stops and removes the
child, precisely so a restart never sees "node gone, record still live" and brings it back.

## The defect

`respawn` reads the donation record once, at entry, and validates its status there. It then awaits
`orchestrator.createContainer(...)` — a real child spawn, seconds of wall clock — and on success
writes back a row built from that **entry-time copy**:

```ts
const respawned: Donation = { ...attempted, dockerId, seedEndpoint, seedToken, updatedAt };
this.store.put(respawned);
```

`DonationStore.put` replaces the whole row. So if a `terminate` lands during the spawn, its
`terminated` write is silently overwritten by the stale copy, and the record comes back reading
`seeded` (or `awaiting_seed`).

Consequences, all of them real rather than theoretical:

- **The ended loan is alive again.** It counts against the grant's quota once more, and the
  supervisor will keep it running — a borrower who deleted their node cannot get rid of it.
- **An orphaned child process.** `terminate` stopped and removed the child it knew about (the old
  handle). The freshly spawned one is unknown to it, so nothing stops it; it holds host ports and
  keeps talking to the borrower's cadre.
- **A permanently-stuck record when the reap wins the race the other way.** The reap terminated it
  for being stale; the resurrected row is `awaiting_seed` with a fresh `updatedAt`, so the next reap
  waits out the full 30-minute TTL again.

The same shape of bug on the *failure* path (`storeAttempt` writing the stale copy back) was fixed
during the review of `donated-node-respawn-supervisor-finish` — that one now merges only the attempt
counters onto whatever is on disk. The success path is untouched and is the harder half, because a
correct fix has to decide what to do with the child it just spawned.

## Expected behaviour

A `terminate` that lands at any point during a respawn must win. Concretely, after any interleaving
of `terminate(id)` and `respawn(id)`:

- the record ends up `terminated`, never `awaiting_seed` / `seeded`;
- no donated child process for that id is left running;
- the grant's live-node tally (`DonationStore.liveNodeCount`) does not count the loan;
- `respawn`'s caller is told the respawn did not take effect, and does not treat it as a failure
  worth counting against the backoff/give-up budget (it is not a host fault).

Note the deliberate asymmetry with the crash-recovery design: `respawn` must **not** reclaim
(`removeContainer`) a workdir on this path if the record could still legitimately come back, because
the workdir holds the node identity key the borrower's cadre approved. On a `terminated` record the
loan is over, so reclaiming is correct — but confirm that against `terminate`'s own cleanup so the
two do not both try, or neither does.

## Use cases to cover

- **Borrower deletes mid-restart.** A `seeded` loan whose child crashed; `respawn` is in flight when
  `DELETE /grants/:id` arrives. Record stays `terminated`; no child survives; quota freed.
- **Reap wins mid-restart.** An `awaiting_seed` loan past its 30-minute TTL, reaped while the
  supervisor's respawn is spawning. Same outcome — and the record must not get a fresh `updatedAt`
  that restarts the TTL clock.
- **Restart wins.** The ordinary case: no terminate arrives, the respawn lands, status is unchanged
  and the new handle is recorded. Must not regress.
- **Supervisor accounting.** A respawn abandoned because the loan ended is not a failed attempt: the
  attempt counter must not climb toward the give-up cap on account of it, and the supervisor must not
  mark the record `error`.

## Notes for whoever picks this up

- `DonationStore` is a single-process, whole-file, read-modify-write JSON store with an in-memory
  cache (`donation-store.ts`). Every last-write-wins hazard in this area comes from holding a copy of
  a row across an `await`; a fix that re-reads before writing is in keeping with the two call sites
  already doing that (`DonationSupervisor.refillBudgetIfHealthy`, `DonationService.storeAttempt`).
- `DonationSupervisor` serializes its own passes, so respawn-vs-respawn is not the concern here —
  only respawn-vs-terminate, which crosses the HTTP surface and the reap timer.
