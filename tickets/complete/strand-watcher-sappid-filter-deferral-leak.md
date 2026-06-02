description: Provisional-deferral fix for StrandWatcher's sAppId filter — deferred strands are re-evaluated each poll and stopped if their sAppId resolves to a non-match. Reviewed and completed.
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/test/strand-watcher-filters.spec.ts
----
## Summary

`StrandWatcher`'s `sAppId` filter used to treat an unknown-sAppId admission as
final: a strand admitted while its sAppId was unknown was recorded in
`knownStrands` and never re-checked, so it kept running even after its sAppId
later resolved to a non-matching value.

The fix makes the deferral **provisional**:
- `passesFilter` (boolean) became `evaluateFilter` returning a tri-state
  `'pass' | 'reject' | 'defer'`.
- A new `private provisional: Set<string>` tracks `defer`-admitted ids. `poll()`
  re-evaluates them each cycle: `pass` → promote to final (drop from
  `provisional`); `reject` → stop (delete from `knownStrands`/`provisional`, fire
  `onStrandRemoved`); `defer` → leave provisional.
- The removed-strand loop and `stop()` both clear `provisional`.

Single-file behavioral change plus regression tests; no change to `StrandFilter`
or the public `StrandWatcher` constructor.

## Review findings

### Checked — implementation correctness
- **Tri-state logic is sound.** `all`/`none`/`strandId` map cleanly; the
  `sAppId` branch now correctly distinguishes *no lookup configured*
  (`!this.sAppIdLookup` → `pass`, permanent) from *lookup returns `undefined`*
  (`defer`). The old code conflated these — the split is the crux of the fix and
  matches the "no lookup → admit all" pre-existing test.
- **No double callbacks / no double-removal.** A `reject` in the re-eval loop
  deletes from `knownStrands` before the removed-strand loop runs, and the
  removed-strand loop only fires for ids absent from `currentMap` (a rejected
  strand is still present), so the two paths never both fire for one id.
  Re-eval `continue`s when the id is gone from `currentMap`, leaving the
  removed-strand loop as sole owner of the disappearance case — single
  `onStrandRemoved`.
- **Iteration safety.** Re-eval snapshots `[...this.provisional]` before
  mutating; the removed-strand loop deletes the current key during Map iteration
  (safe in JS). Verified.
- **Real consumer interaction (`CadreNode`).** `getSAppId` is backed by
  `sAppConfigs`, populated by `addStrand`. The deferral path is exactly the
  real-world race: a strand seen on the control network before its sApp config
  arrives is now provisionally admitted, then promoted (match) or stopped
  (non-match) once `addStrand` registers the config. `handleStrandRemoved` is
  idempotent (deletes config, untracks hibernation, stops instance) so a
  provisional admit→remove is safe downstream.

### Checked — error handling / resource cleanup / type safety
- `onStrandRemoved` in the re-eval loop is wrapped in the same try/catch + `log`
  as the existing removal path (no swallowed errors without logging — matches
  AGENTS.md). Type-safe throughout; no `any`. `FilterDecision` is a local
  union, switch is exhaustive with a `default`.
- `stop()` clears both `knownStrands` and `provisional` — no set leak across
  restarts.

### Checked — tests
- Ran `yarn vitest run` (full cadre-core): **170 pass** (was 169). `yarn build`
  (tsc) clean. cadre-core defines no `lint`/`typecheck` script — `build` is the
  type gate.
- The two implementer tests cover defer→reject (stops) and defer→pass (keeps,
  and a third poll is a no-op).

### Found & fixed inline (minor)
- **Missing coverage for provisional pruning on disappearance.** Added
  `removes and prunes a still-deferred strand when it disappears from the
  network`: a never-resolving deferred strand that leaves `currentMap` fires
  `onStrandRemoved` exactly once, is gone from `getKnownStrands()`, a further
  poll is silent, and re-introducing the same id is treated as a *fresh*
  deferred admission (proving the `provisional.delete` in the removed-strand
  loop actually pruned the entry — not just `knownStrands`).

### Found — acceptable known limitations (no action)
- **One-way promotion (pass→reject not re-checked).** Once a strand resolves to
  `pass` it leaves `provisional` and is never re-evaluated; a `pass`-admitted
  strand whose sAppId later changed to a non-match would not be caught. Confirmed
  acceptable: a strand belongs to exactly one sApp, so its sAppId is immutable at
  the domain level. In `CadreNode`, the only way the config "changes" is
  `removeStrand`, which stops the instance directly anyway. Not a real leak;
  scoped out as the implementer intended.
- **Same-poll re-evaluation of a just-deferred strand.** A strand deferred in the
  added loop is included in the same poll's `[...this.provisional]` snapshot and
  re-evaluated once more. `evaluateFilter` is pure/synchronous, so it returns
  `defer` again with no extra callback — only a duplicate debug `log` line.
  Cosmetic; left as-is to keep the loops simple.
- **Concurrent `poll()` re-entrancy.** `setInterval` can fire a second `poll()`
  while the first is awaiting a callback, interleaving mutations of
  `provisional`/`knownStrands`. Pre-existing (the original add/remove loops have
  the same exposure); not introduced or worsened by this change in any
  qualitative way. Left for a future serialization pass if it ever bites.

### Docs
- `docs/architecture.md:803` is the only doc reference to StrandWatcher filters,
  and it lists the modes (`all`, `sAppId`, `strandId`, `none`) — unchanged by
  this fix, which only alters internal deferral handling. No doc update needed;
  verified rather than assumed.

## Validation
- `yarn vitest run` (cadre-core): 170 pass.
- `yarn build` (cadre-core tsc): clean, no type errors.
