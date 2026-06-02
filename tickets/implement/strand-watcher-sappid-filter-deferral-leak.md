----
description: Make the sAppId strand-filter deferral provisional — re-evaluate deferred strands each poll and stop any whose sAppId resolves to a non-matching value.
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/test/strand-watcher-filters.spec.ts
----
## Problem (confirmed reproduced)

`StrandWatcher.passesFilter` in `sAppId` mode returns `true` when the strand's
sAppId is not yet known (the "deferring filter decision" branch,
`strand-watcher.ts:82-94`). `poll()` only evaluates `passesFilter` for strands
not already in `knownStrands` (the added-strand loop is gated on
`!this.knownStrands.has(strand.Id)`, `strand-watcher.ts:112-122`). So once a
strand is admitted under the deferral and recorded in `knownStrands`, it is
never re-checked. If its sAppId later resolves to a value that does not match
`filter.sAppId`, the strand keeps running — exactly what the filter was meant to
exclude.

A reproducing test (added temporarily during the fix stage and removed again)
confirms the leak: a strand admitted while its sAppId was unknown is still
running, and `onStrandRemoved` is never invoked, after its sAppId resolves to a
non-matching value on a later poll.

## Design

The deferral must be **provisional**, not final. Two coordinated changes:

### 1. Make filter evaluation tri-state

Replace the boolean `passesFilter` with a function that distinguishes the three
real outcomes instead of collapsing "unknown" into "pass":

```ts
type FilterDecision = 'pass' | 'reject' | 'defer';
```

- `all` → `pass`
- `none` → `reject`
- `strandId` → `pass` if `strand.Id === filter.strandId`, else `reject`
- `sAppId`:
  - no `sAppIdLookup` configured → `pass` (unchanged: no way to ever decide, so
    admit permanently — matches the existing "no lookup provided" test)
  - lookup returns `undefined` → `defer` (sAppId not yet known)
  - lookup returns a value → `pass` if it equals `filter.sAppId`, else `reject`

Keep the existing `log()` lines for the defer and match branches.

### 2. Track provisional admissions and re-evaluate them each poll

Add a set of strand Ids that were admitted under a `defer` decision:

```ts
private provisional: Set<string> = new Set();
```

In `poll()`:

- **Added-strand loop** (strands not in `knownStrands`): compute the decision.
  - `pass` → add to `knownStrands`, call `onStrandAdded` (as today).
  - `defer` → add to `knownStrands` **and** to `provisional`, call
    `onStrandAdded` (admit provisionally so an unknown-sAppId strand still runs
    as a temporary bridge — preserves the "should pass through strands with
    unknown sAppId" behavior).
  - `reject` → skip (do not add).
- **New provisional re-evaluation loop**: for each strandId in `provisional`
  that is still present in `currentMap`, recompute its decision:
  - `pass` → remove from `provisional` (admission is now final); leave running.
  - `defer` → leave in `provisional` (still unknown; re-evaluate next poll).
  - `reject` → stop it: remove from `knownStrands`, remove from `provisional`,
    and invoke `onStrandRemoved(strandId)` (wrapped in the same try/catch as the
    existing removal path).
- **Removed-strand loop** (in `knownStrands` but not in `currentMap`): also
  delete the id from `provisional` so the set never leaks entries for strands
  that have disappeared from the control network.

`stop()` must clear `provisional` alongside `knownStrands`.

Be careful with iteration: don't mutate `knownStrands` / `provisional` while
iterating the same structure — snapshot the provisional ids (e.g. iterate
`[...this.provisional]`) before stopping/removing within the loop.

### Notes

- The existing tests in `strand-watcher-filters.spec.ts` must continue to pass
  unchanged: unknown-sAppId strands still get admitted on first poll, and the
  no-lookup case still admits everything permanently.
- This is a single-file behavioral fix plus a regression test; no type changes
  to `StrandFilter` or the public `StrandWatcher` constructor signature.

## TODO

- [ ] In `packages/cadre-core/src/strand-watcher.ts`, introduce a tri-state
      filter decision (`'pass' | 'reject' | 'defer'`) and refactor
      `passesFilter` accordingly (rename to e.g. `evaluateFilter` returning the
      decision). Keep existing log lines.
- [ ] Add `private provisional: Set<string>` and update `poll()` per the design:
      classify added strands, add a provisional re-evaluation loop that stops
      `reject`ed strands via `onStrandRemoved` and removes them from
      `knownStrands`/`provisional`, promote `pass`ed strands to final, and prune
      `provisional` entries in the removed-strand loop.
- [ ] Clear `provisional` in `stop()`.
- [ ] Add a regression test to `packages/cadre-core/test/strand-watcher-filters.spec.ts`
      under the `mode: sAppId` describe, using a mutable mapping so the sAppId
      resolves between polls. Assert that:
        - a strand admitted under deferral is stopped (`onStrandRemoved` called,
          gone from `getKnownStrands()`) once its sAppId resolves to a
          non-matching value; and
        - a deferred strand whose sAppId resolves to a **matching** value keeps
          running (no `onStrandRemoved`). Reference reproduction:

      ```ts
      it('stops a deferred strand once its sAppId resolves to a non-match', async () => {
        const strands = [createStrand('late-strand')];
        const queryable: StrandQueryable = { queryStrands: async () => strands };
        const mapping: Record<string, string> = {};
        const sAppIdLookup: SAppIdLookup = { getSAppId: (id) => mapping[id] };
        const added: string[] = [];
        const removed: string[] = [];
        const callbacks: StrandWatcherCallbacks = {
          onStrandAdded: async (s) => { added.push(s.Id); },
          onStrandRemoved: async (id) => { removed.push(id); }
        };
        const watcher = new StrandWatcher(
          queryable, callbacks, { mode: 'sAppId', sAppId: 'target-app' }, 60000, sAppIdLookup
        );
        await watcher.start();
        await watcher.forcePoll();
        expect(added).toEqual(['late-strand']);     // deferred admission
        mapping['late-strand'] = 'other-app';        // resolves to non-match
        await watcher.forcePoll();
        expect(removed).toEqual(['late-strand']);
        expect(watcher.getKnownStrands().has('late-strand')).toBe(false);
        await watcher.stop();
      });
      ```
- [ ] Run `yarn test` in `packages/cadre-core` and confirm the new test plus all
      existing `strand-watcher*.spec.ts` tests pass.
