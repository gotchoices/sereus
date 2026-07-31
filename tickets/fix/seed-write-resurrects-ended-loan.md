---
description: If a borrowed node finishes joining at the same moment the host is shutting that loan down, the shutdown gets undone and the ended loan comes back to life still counting against the lender's limit.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts
difficulty: medium
---

# A seed (or provision) that finishes after a loan ends resurrects it

Found during review of `respawn-succeeds-after-loan-terminated`. That ticket fixed exactly this
shape of bug in `DonationService.respawn`; the same shape is still live in two sibling methods of
the same class, and at least one of them is reachable in normal operation.

## The shape

`DonationStore.put` replaces a whole row. So any method that

1. reads a donation record,
2. `await`s something slow (a network call, a child-process spawn),
3. writes back a row built from the **entry-time** copy

silently discards whatever landed on that record during step 2. When what landed was the loan
ending, the write brings the ended loan back.

## Where it is still live

### `applySeed` — reachable today

`packages/cadre-host/src/donation/donation-service.ts` (`applySeed`, ~line 262):

```ts
const donation = this.requireDonation(id);      // entry read — status checked HERE
// ... status/endpoint/token guards ...
res = await fetch(donation.seedEndpoint, ...);   // seconds; a network round-trip to the node
const result = await res.json();
if (result.success) {
  this.store.put({ ...donation, status: 'seeded', updatedAt: ... });   // whole row, entry-time copy
}
```

The status guard runs on the entry read, never again. Two concurrent endings can land inside that
`fetch` window:

- **The 30-minute stale-seed reap.** `reapStaleAwaitingSeed` runs on a 5-minute timer wired in
  `bin/host.ts`, and it targets precisely `awaiting_seed` records — the exact status `applySeed`
  operates on. A borrower who presents their seed right at the TTL boundary collides with it. This
  is the natural, non-adversarial collision.
- **The borrower's own `DELETE /grants/:id`.** `PUT /grants/:id/seed` and `DELETE /grants/:id` are
  separate HTTP requests with no cross-request serialization
  (`packages/cadre-host/src/server/routes/grants.ts`).

Resulting damage, worse than a stale field:

- The record goes back to `seeded`, which is a **live** status — the grant's node quota is consumed
  again by a loan that no longer exists.
- `terminate` already stopped and removed the child and deleted its workdir, so the record now
  names a `dockerId` for a process that is gone.
- `DonationSupervisor` supervises `seeded` records, sees the node not running, and **respawns it** —
  fully reviving a loan the borrower ended (or the host reaped), with a fresh identity key because
  the workdir went with the terminate.

### `provisionLocked` — same shape, much narrower

Same file, `provisionLocked`: writes `{ ...record, status: 'awaiting_seed' }` after `await
this.orchestrator.createContainer(...)`. A `terminate` landing in that window is overwritten the
same way. Narrower because the caller only learns the donation id when `POST /grants` returns, i.e.
after the write — but the id is also visible via `list()` and the host's own UI, so it is not
impossible. Worth closing while the fix is in hand rather than leaving one instance of the pattern
behind.

## Expected behaviour

Match what `respawn` now does (see `tickets/complete/respawn-succeeds-after-loan-terminated.md`):

- **The ending wins.** Re-read the record after the slow `await` and decide against what is actually
  on disk, with no further `await` between that read and the write — `DonationStore` is synchronous,
  so a read-decide-write pair with no `await` in it cannot be interleaved.
- Merge forward only the fields the operation actually produced (for `applySeed`, the status
  transition; for `provisionLocked`, the new handles and status) rather than writing back a whole
  entry-time row.
- If the record is no longer in a status the operation may write to, leave it exactly as the ending
  wrote it and report the outcome to the caller instead of throwing — the same "this is a skip, not
  a failure" distinction `RespawnResult` draws. `applySeed`'s return type
  (`DonationSeedResult`) needs a way to say "the seed reached the node, but the loan had already
  ended", so the route can answer with something other than a bare success.
- For `provisionLocked`, an ending that wins must also clean up the child that was just spawned —
  the ending's own cleanup ran before the record named a `dockerId`, so it cleaned up nothing.
  `DonationService.abandonRespawn` is the existing precedent for this.

## Coverage to add

The existing race tests in `donation-service.test.ts` (`'lets a borrower terminate that lands
mid-spawn win…'`, `'lets a stale-seed reap that lands mid-spawn win…'`) show the pattern: drive the
concurrent ending from a `FakeOrchestrator.onCreate` hook while the slow call is in flight. For
`applySeed` the slow call is a real `fetch`, so the test needs a stub server or an injectable fetch
— note that `applySeed`'s happy path currently has no unit coverage at all for that reason (only
the `cadre-host-node-donation` integration scenario exercises it).

Cases worth pinning:

- Seed succeeds at the node; a `terminate` landed mid-`fetch` → record stays `terminated`, quota
  stays freed, supervisor does not respawn it.
- Seed succeeds at the node; the stale-seed reap landed mid-`fetch` → same, and `updatedAt` stays at
  the reap's timestamp.
- Ordinary seed with no concurrent ending → still transitions `awaiting_seed` → `seeded`.
- Provision whose `terminate` lands mid-spawn → record stays `terminated` and the new child is
  stopped and reclaimed.
