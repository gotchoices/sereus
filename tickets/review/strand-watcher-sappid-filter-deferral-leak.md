description: Review the provisional-deferral fix for StrandWatcher's sAppId filter — deferred strands are now re-evaluated each poll and stopped if their sAppId resolves to a non-match.
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/test/strand-watcher-filters.spec.ts
----
## What changed

The `sAppId` strand-filter deferral was final, not provisional: a strand admitted
while its sAppId was unknown was recorded in `knownStrands` and never re-checked,
so it kept running even after its sAppId later resolved to a non-matching value.

Fix is a single-file behavioral change in `strand-watcher.ts` plus a regression
test. No changes to `StrandFilter` or the public `StrandWatcher` constructor.

### 1. Tri-state filter (`passesFilter` → `evaluateFilter`)

`evaluateFilter(strand): 'pass' | 'reject' | 'defer'` replaces the boolean.
- `all` → `pass`; `none` → `reject`; `strandId` → `pass`/`reject` by Id match.
- `sAppId`:
  - **no `sAppIdLookup` configured** → `pass` (admit permanently — unchanged;
    note this is now keyed on `!this.sAppIdLookup`, *distinct* from the lookup
    returning `undefined`, which the old code conflated).
  - lookup returns `undefined` → `defer`.
  - lookup returns a value → `pass`/`reject` by `sAppId` equality.
  - Existing `log()` lines for the defer and match branches preserved.

### 2. Provisional set + re-evaluation in `poll()`

- New `private provisional: Set<string>`.
- **Added-strand loop**: `reject` → skip; `pass` → add to `knownStrands` + fire
  `onStrandAdded`; `defer` → same, plus add to `provisional`.
- **New re-evaluation loop** over `[...this.provisional]` (snapshotted so we can
  mutate inside): if the id is still in `currentMap`, recompute decision —
  `pass` promotes to final (drop from `provisional`); `reject` stops it (delete
  from `knownStrands` + `provisional`, fire `onStrandRemoved` in try/catch);
  `defer` leaves it provisional.
- **Removed-strand loop**: also `provisional.delete(strandId)` so the set never
  leaks ids for strands that left the control network.
- `stop()` now clears `provisional` alongside `knownStrands`.

## Validation done

- `yarn vitest run strand-watcher` — 18 tests pass (9 filter + 9 manager/watcher).
- `yarn test` (full cadre-core) — 169 pass.
- `yarn build` (tsc) — clean, no type errors.

### Tests added (under `mode: sAppId`)

- **stops a deferred strand once its sAppId resolves to a non-match**: deferred
  admit on poll 1; `mapping` mutated to `'other-app'`; poll 2 fires
  `onStrandRemoved` and the id is gone from `getKnownStrands()`. (The ticket's
  reference reproduction — was failing before the fix.)
- **keeps a deferred strand running once its sAppId resolves to a match**:
  resolves to `'target-app'`; no removal; still in `knownStrands`; a third poll
  does not re-add or re-remove (admission is final).

All four pre-existing `mode: sAppId` tests still pass unchanged (notably
"pass through strands with unknown sAppId" and "pass through all strands when no
lookup provided").

## Review focus / known gaps (treat tests as a floor)

- **Promotion is one-way.** Once a strand resolves to `pass` it leaves
  `provisional` and is never re-evaluated again. This is intentional (sAppId is
  expected to be immutable once known), but if a strand's sAppId could legitimately
  *change* from a match to a non-match after first resolving, that transition is
  not caught. Confirm the immutability assumption holds for the real
  `sAppIdLookup` source; if not, this needs a different design (re-check all
  known strands, not just provisional).
- **No dedicated test for provisional pruning on disappearance.** The
  removed-strand loop now also clears `provisional`, but there's no test that a
  *provisional* strand vanishing from `currentMap` both fires `onStrandRemoved`
  and is pruned from `provisional`. The general removed-strand path is covered
  elsewhere; a targeted assertion on the set would close the gap.
- **Same-poll ordering.** A strand deferred in the added-strand loop is included
  in the `[...this.provisional]` snapshot and re-evaluated in the same poll; the
  lookup is deterministic within a poll so it stays `defer` (no double callback).
  Worth a glance to confirm no unintended same-poll add+remove.
- **Concurrent polls (pre-existing).** `poll()` awaits callbacks; `setInterval`
  could fire a second `poll()` while the first is mid-await, interleaving
  mutations of `provisional`/`knownStrands`. This re-entrancy is not introduced
  by this change and exists for the original loops too, but the new cross-await
  set mutations are worth noting. Not addressed here.
