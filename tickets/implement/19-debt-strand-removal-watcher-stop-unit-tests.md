description: When a shared network is removed by somebody else, a node is supposed to notice the row is gone and shut its own copy down — add fast local tests for that, including the case where a node deliberately isn't watching that network.
prereq:
files: packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-watcher.ts, docs/architecture.md
difficulty: medium
----

# Local half of the party-wide strand-removal contract

## What is untested today

`CadreNode.unpublishStrand` is well covered from the point of view of the node that
**issues** the removal (`packages/cadre-core/test/strand-unpublish.spec.ts`): the row is
deleted, a `Revocation` tombstone lands, the local instance is force-stopped, `strand:stopped`
fires exactly once.

Nothing covers the *other* node's experience: a node that did **not** issue the removal, which
learns of it only by seeing the `Strand` row missing on its own next `StrandWatcher` poll. That
path is `StrandWatcher.poll` → `onStrandRemoved` → `CadreNode.handleStrandRemoved`
(`packages/cadre-core/src/cadre-node.ts:2611`), and it is reached today only through the
5-second polling timer — never through `unpublishStrand`'s immediate `forcePoll` + explicit
stop, which is a different branch.

This ticket pins that path **without a second machine**, by deleting the row out from under a
single running node with a direct `ControlDatabase.deleteStrand` call. The genuinely
cross-machine question — does the deletion actually become *visible* to a second node over the
network? — is a separate ticket
(`implement/19.5-debt-strand-unpublish-sibling-convergence-e2e`). Splitting them is deliberate:
if the sibling scenario ever goes red, these tests say whether the local wiring or the
replication is at fault.

## Why a direct `deleteStrand` is the right stand-in

`unpublishStrand` cannot be used here — it force-stops the local instance itself, so the
watcher path would be masked. Calling the writer directly:

```ts
await db.deleteStrand(strandId, ownerPublicKeyB64, signMessage);
```

leaves the node in exactly the state a sibling is in a moment after somebody else's removal
commits: the row is gone from its view, its instance is still running, and only the next poll
can notice. `packages/cadre-core/test/control-authorization-binding.spec.ts:43` already shows
the `signMessage` shape these writers expect (ed25519 over the raw canonical bytes, no
pre-hash, via `@optimystic/quereus-plugin-crypto`); build it from the same keypair
`ed25519KeyPairFromLibp2p(nodeKey)` yields, which `startSelfOwnerNode` in the spec already
enrolls in `OwnerKey`.

## Recipe (shared by both new tests)

`startSelfOwnerNode` in the spec currently hardcodes its `CadreNodeConfig`. Give it an
overrides parameter for the two fields these tests need — `strandWatchInterval` (drop to
~200 ms so a poll-driven assertion resolves in well under a second) and `strandFilter` — and
keep its existing call sites unchanged by defaulting both.

Register the strand the same way a real sibling does, so the watcher is guaranteed to be
tracking the row before anything is deleted:

- `publishStrand(strandId)` **first**, with no sApp config registered.
- The watcher's next poll finds a row it has no config for and emits `strand:discovered`
  (`cadre-node.ts:2589`). Wait for that event — it is the proof the watcher has the id in its
  `knownStrands`, which is the precondition for its removal path ever firing.
- Only then `addStrand(config)` for that id, which registers the config and launches the
  instance. Because `knownStrands` already holds the id, the watcher does not fire
  `onStrandAdded` a second time, so the event stream stays unambiguous.

Do **not** `addStrand` before publishing: the watcher would then discover the row after the
instance exists, relaunch through `handleStrandAdded` (deduped by
`StrandInstanceManager.startStrand`, `strand-instance-manager.ts:185`) and emit a second
`strand:started`, muddying the event assertions for no benefit.

## The two tests

**1. A watching node stops its instance when the row vanishes.**
Filter `{ mode: 'all' }`. Bring the strand up per the recipe above, then direct-`deleteStrand`.
Assert, within a bounded wait (a few seconds, polling — not a fixed sleep):

- `strand:stopped` fires for that id, **exactly once**, and stays at once after a further quiet
  window of ~5 poll intervals.
- `node.getStrand(strandId)` is `undefined` and `node.getStrands().size` is 0.
- No `strand:error` is emitted at any point.
- The sApp config was dropped: re-`publishStrand(strandId)` afterwards produces a **second**
  `strand:discovered` rather than a relaunch. This is the assertion that proves
  `handleStrandRemoved` cleared both `sAppConfigs` and the watcher's `knownStrands`, and that
  the `Revocation` tombstone left by the delete is not mistaken for a live row.

**2. A node whose filter never admitted the strand keeps running it.**
Filter `{ mode: 'strandId', strandId: <some other id> }`. `publishStrand(target)` — assert no
`strand:discovered` ever arrives for it — then `addStrand(target)` directly (an app may run a
strand the watcher was told to ignore), then direct-`deleteStrand(target)`. After ~5 poll
intervals assert the instance is **still** present (`getStrand(target)` defined), no
`strand:stopped`, no `strand:error`.

This is documented behaviour, not a defect: a node that opted out of watching a strand also
opted out of observing its party-wide removal, and its only stop is the local
`stopStrand`/`unpublishStrand` call. Say so where a reader would otherwise form the wrong
expectation:

- the `unpublishStrand` doc comment (`cadre-node.ts:3003-3049`), whose convergence-caveats
  paragraph currently says only that an unsynced sibling keeps running until its own watcher
  polls;
- the party-wide removal sentence in `docs/architecture.md:566`, one clause.

## Edge cases & interactions

- **Watcher must have seen the row before the delete.** If `deleteStrand` lands before the
  first successful poll, `knownStrands` never held the id and the removal path can never fire —
  the test would fail for a reason that has nothing to do with the code under test. The
  `strand:discovered` gate above is what forecloses this; do not replace it with a sleep.
- **Poll interval vs. assertion window.** The quiet windows must be a multiple of the
  configured `strandWatchInterval`, derived from it in the test rather than hardcoded, so a
  future interval change cannot silently turn a real assertion into a vacuous one.
- **Exactly-once.** `handleStrandRemoved` deletes from `knownStrands` before invoking the
  callback, so a repeat is not expected — assert it anyway, since a regression here would
  present to an app as a duplicate shutdown.
- **A poll whose read throws** is swallowed and retried (`strand-watcher.ts:179`). A test that
  fails because every read errored looks identical to one that fails because the row never
  disappeared. If a new test times out, check the `sereus:cadre:strand-watcher` debug output
  before concluding anything about convergence.
- **`strandFilter: { mode: 'none' }` vs. `{ mode: 'strandId', <other> }`.** Both reject; use the
  `strandId` form, since it is the shape a real app uses and it keeps the test honest about
  *which* strand was excluded.
- **`sAppId` filter mode is out of scope.** Its provisional/`defer` admission has its own
  re-evaluation branch (`strand-watcher.ts:145-164`) with unit coverage in
  `strand-watcher-filters.spec.ts`; do not widen this ticket into it.
- **Hibernation.** `handleStrandRemoved` untracks the strand from the hibernation manager
  before stopping it. Hibernation is disabled in these specs; do not enable it here — a
  hibernating-then-removed strand is a separate case with no ticket, and adding it would
  widen this one.
- **Interaction with `plan/20-debt-self-owner-node-test-harness-duplicated`.** That ticket
  consolidates the five copies of `startSelfOwnerNode` across cadre-core specs, and this ticket
  adds an overrides parameter to one of them. It is sequenced after this one; leave a short
  comment on the parameter so the consolidation pass carries it into the shared helper rather
  than dropping it.

## TODO

- Extend `startSelfOwnerNode` in `packages/cadre-core/test/strand-unpublish.spec.ts` with
  optional `strandWatchInterval` / `strandFilter` overrides; existing call sites unchanged.
- Add a `signMessage` helper to the spec, built from the node's own owner private key, and a
  small `waitFor(condition, budget)` (or reuse whatever the file/package already has — check
  before adding) so the poll-driven assertions are bounded waits, not sleeps.
- Write test 1: watching node stops its instance, `strand:stopped` exactly once, config dropped
  (re-publish → second `strand:discovered`), no `strand:error`.
- Write test 2: filter-excluded node keeps running, no `strand:stopped`, no `strand:error`, no
  `strand:discovered`.
- Document the filter-excluded consequence in the `unpublishStrand` doc comment and in the
  party-wide removal sentence of `docs/architecture.md`.
- Run `yarn --cwd packages/cadre-core test test/strand-unpublish.spec.ts 2>&1 | tee` the whole
  spec file several times to shake out timing flake at the short poll interval; then
  `yarn --cwd packages/cadre-core test` for the full suite, and `yarn lint` + `yarn typecheck`.
- Hand off to `review/` naming: how long the poll-driven waits actually took vs. their budget,
  and anything about the filter-excluded behaviour that reads as a design smell rather than a
  documented consequence.
