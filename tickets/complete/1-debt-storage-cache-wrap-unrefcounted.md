description: The shared read cache in front of a data store now counts how many parts of the app are using it, so one part shutting down no longer throws away a cache the others are still reading through. Reviewed, one leak on a failed-startup path fixed, shipped.
files: packages/quereus-plugin-sereus/src/cached-storage.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/test/cached-storage.spec.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/strand-instance-manager-backfill.spec.ts, docs/architecture.md
----

# Holder count on the storage cache wrapper

## What shipped

`wrapStorageWithCache(storage, label)` and `disposeStorageCache(storage)` in
`packages/quereus-plugin-sereus/src/cached-storage.ts` are now a matched pair with a
holder count between them. Every wrap that hands back a cache this module created takes
one claim; every dispose releases one. The cache is emptied, unregistered from the
process-wide cache pool, and dropped from the wrap memo only when the last claim goes.

That makes three things true:

- Wrapping the same store twice still returns the same cache object; the second wrap is
  recorded as a second holder.
- A holder releasing while others remain retires nothing. Still-running scopes keep
  reading through a live cache, and a scope starting afterwards joins that same cache
  instead of building a rival over the same backend.
- Releasing something with no live claim — a cache the embedder built itself, or a late
  second release of an already-retired wrapper — is a no-op.

Bookkeeping is two weak maps: `wraps` (memo, keyed by inner store) and `claims` (count
plus reverse pointer, keyed by wrapper). Presence in `claims` is also how the module
answers "is this cache mine to retire?". Decrement and retire both happen in
`disposeStorageCache`'s synchronous prefix, ahead of `await storage.dispose()`.

`composeStrand` no longer guesses at ownership. The old `ownedStorageCache` heuristic
("the wrap returned a different object, so I must have created it") is gone; `shutdown()`
and the failed-setup rollback release this composition's own claim unconditionally,
latched so a double `shutdown()` releases once.

`docs/architecture.md` and the `RawStorageProvider` doc comment in
`packages/cadre-core/src/types.ts` no longer steer embedders away from the shared-instance
provider form; the factory form is recommended on its real merit (per-strand data
partitioning). Architecture states the obligation the count creates: call the pair in
balance, one dispose per wrap.

## Review findings

Reviewed the implement diff (`cce13b4`) against the current tree, then re-derived the
counting invariant from the source rather than from the handoff.

### Fixed in this pass (minor)

- **`composeStrand` leaked its claim when plugin registration failed.** The storage wrap
  happens before any registration, but the only rollback (`releaseStorageCache`) sat in a
  `try` that starts three steps later — the crypto-plugin registration and the optimystic
  plugin registration were outside it. A throw there left the claim, and the backing
  store's registration in the shared pool, held for the process lifetime with no holder
  able to release it. Under the pre-ticket code this was the same shape of leak; the count
  makes it worse, because a leaked claim now also blocks every other scope from ever
  retiring that cache. Fixed by extracting steps 1-2 into `registerStrandPlugins` and
  guarding the call with a release-then-rethrow. Pinned by a new test, *"releases the claim
  it took when plugin registration fails before setup starts"*, in
  `packages/quereus-plugin-sereus/test/plugin.spec.ts`. Negative-verified: with the release
  removed, the test reads pool occupancy `1` where it expects `0`.
- **Two cadre-core specs held claims they never released.** Three assertion sites across
  `cadre-node-control-node-options.spec.ts` and `strand-instance-manager-backfill.spec.ts`
  assert identity *through* `wrapStorageWithCache`, which now takes a claim. The implement
  pass documented the imbalance with `NOTE:` comments. A documented imbalance is still an
  imbalance, and the obligation this ticket introduces is exactly "call the pair in
  balance" — so the assertions now capture the wrap and release it
  (`await disposeStorageCache(cached)`), and the two `it` blocks that needed it became
  `async`. The `NOTE:` comments are gone with the problem.
- **Stale sentence in `docs/architecture.md`.** The provider paragraph still described a
  scope's stop as "releasing the shared pool registration"; with the count, a stop releases
  that scope's *claim*, and the registration goes with the last one. Reworded.

### Recorded as a tripwire, not a ticket

- **A retired wrapper handed back to `wrapStorageWithCache` is returned as-is, uncounted,
  with no error** — the caller gets a dead cache silently. Unreachable today: both retire
  sites drop their reference in the same block that releases. Conditional, so it is a
  `NOTE:` at the `instanceof CachedRawStorage` branch in `cached-storage.ts`, naming the
  condition (a caller holding a wrapper across its own release) and the fix (throw on an
  absent claim rather than hand back the corpse).

### Checked and found sound — no change

- **The memo/claim invariant.** The implement pass deleted the old guard "only evict the
  memo if it still points at THIS wrapper". Verified that guard is now redundant: a memo
  entry is written only at construction (which runs only on a memo miss) and deleted only
  at retire, in the same block that deletes the claim — so a memo entry exists exactly
  while a claim exists for that wrapper, and a stale wrapper can never evict a live
  successor. Covered by the *over-release, both orders* test.
- **The synchronous decrement.** Decrement, `claims.delete`, and `wraps.delete` all run
  before the first `await`, so no wrap can interleave and find the memo pointing at a
  dying cache. Argument by inspection, as in the handoff — still no test interleaves a
  wrap into a dispose, and none is cheap to write against a `WeakMap`; noted rather than
  attempted.
- **Every production call site balances.** `CadreNode.resolveControlStorage` memoizes into
  a field disposed exactly once in `cleanup()`; `StrandInstanceManager` wraps once per
  `startStrand` into `strandStorages` and disposes on `stopStrand` and on the failed-launch
  rollback; `composeStrand` wraps once and releases under a latch. Walked the
  shared-instance scenario end to end (control plus two strands over one `IRawStorage`) and
  the counts come out right at every step, including a `stop()`/`start()` cycle on the
  control node while a strand still holds the cache.
- **`composeStrand`'s release is unguarded** where cadre-core's two dispose sites catch and
  log. Considered and left as is: a `shutdown()` that fails on cache bookkeeping is
  information the caller should see, and cadre-core's reason for swallowing (an embedder
  must always be able to tear a strand down) does not apply to a SQL-surface shutdown.
  Unchanged from before the ticket.
- **Docs.** Read all four storage paragraphs of `docs/architecture.md`, the
  `RawStorageProvider` comment, and both cadre-core dispose-site comments against the new
  behaviour. Grepped the tree for references to the old ticket path and for the
  now-obsolete "no scope solely owns it" / "first scope to stop" phrasing — nothing stale
  outside the fix above. No other doc mentions the pair.
- **Source hygiene.** `cached-storage.ts` is 178 lines, most of it doc comment, with three
  short single-purpose functions. `compose-strand.ts` grew a named helper rather than a
  second inline block. No size finding.

### Nothing filed

No major findings, so no new `fix/`, `plan/`, or `backlog/` tickets. The handoff's own open
items were weighed: the deliberate "dispose of an embedder-built cache is now a no-op"
behaviour change is right — closing a host's own cache is the mirror of the defect being
fixed — and is pinned by a test; the un-adopted upstream `withReadCache` is a documented,
reasonable deferral with its reason recorded at the site; the retired-wrapper gap became
the tripwire above.

## Validation

Run at review time, all green:

```
yarn workspace @serfab/quereus-plugin-sereus build
yarn workspace @serfab/quereus-plugin-sereus test    # 9 files, 99 passed | 1 todo
yarn workspace @serfab/cadre-core test               # 104 files, 1665 passed | 1 skipped
yarn lint                                            # exit 0
yarn workspace @serfab/quereus-plugin-sereus typecheck   # exit 0
yarn workspace @serfab/cadre-core typecheck              # exit 0
```

`cadre-core` resolves `@serfab/quereus-plugin-sereus` through its `dist`, so the plugin
package must be built before the cadre-core suite picks up a change to `cached-storage.ts`.

`packages/integration-tests` was not run, as in the implement pass — it carries two
deterministic failures in `src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
already recorded in `tickets/.pre-existing-known.md` against the in-flight
`strand-catch-up-refused-until-solo-writes-carry-proof` ticket. Nothing here touches the
catch-up path.

## Not proven end to end

Nothing in-tree walks the shared-instance provider path — every shipped provider hands out
a distinct store per scope — so the fix is proven at the helper, at `composeStrand`, and by
reasoning over the cadre-core call sites, not by a live `CadreNode` with one `IRawStorage`
shared by the control database and two workspaces. Building that node, starting control
plus two strands, stopping one, and confirming the control database still reads its own
writes remains the end-to-end proof nobody has run.
