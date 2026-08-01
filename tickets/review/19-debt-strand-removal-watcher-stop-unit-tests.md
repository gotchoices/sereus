description: Added fast local tests proving a node shuts down its copy of a shared network when someone else removes it — and that a node deliberately not watching that network keeps running, which is now written down as intended behaviour rather than a surprise.
prereq:
files: packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/src/cadre-node.ts, docs/architecture.md
difficulty: medium
----

# What landed

Two new tests at the end of `packages/cadre-core/test/strand-unpublish.spec.ts`, plus the
supporting harness changes, plus two documentation clauses. No production code changed —
only a doc comment.

## The gap that was closed

`unpublishStrand` was covered only from the point of view of the node that *issues* the
removal. That node force-stops its own instance directly, so it never exercises the branch a
*second* node takes: `StrandWatcher.poll` sees the `Strand` row missing → `onStrandRemoved` →
`CadreNode.handleStrandRemoved` (`packages/cadre-core/src/cadre-node.ts:2611`). That branch
had no coverage at all.

The tests stand in for a second machine without needing one: they delete the row out from
under a single running node by calling `ControlDatabase.deleteStrand` directly. That leaves
the node in exactly a sibling's state a moment after someone else's removal commits — row
gone from its view, instance still running, only the next poll can notice. `unpublishStrand`
could not be used, because it stops the local instance itself and would mask the path.

Whether the deletion actually becomes *visible* to a real second node over the network is a
different question, deliberately not covered here (see
`19.5-debt-strand-unpublish-sibling-convergence-e2e`). The split is the point: if the sibling
scenario ever goes red, these tests say whether the local wiring or the replication is at
fault.

## Harness changes (spec file only)

- `startSelfOwnerNode` gained an optional `overrides` parameter carrying two
  `CadreNodeConfig` fields — `strandWatchInterval` and `strandFilter`. Both default to the
  production values, so the six existing call sites are byte-for-byte unaffected. There is a
  `NOTE:` on the parameter asking the helper-consolidation pass
  (`plan/20-debt-self-owner-node-test-harness-duplicated`) to carry it into the shared helper
  rather than drop it.
- `ownerKeys`, a `WeakMap<CadreNode, Ed25519KeyPair>`, records the owner keypair each node
  self-signs with. This is how the helper keeps its `Promise<CadreNode>` return type while
  still letting a test drive a control writer directly.
- `deleteStrandRow(node, strandId)` — the direct `deleteStrand` call, signing ed25519 over the
  raw canonical bytes with no pre-hash, the shape every control writer expects.
- `collectStrandEvents(node)` — records ids for `strand:discovered` / `strand:stopped` /
  `strand:error` in order.
- Timing constants: `WATCH_INTERVAL_MS = 200`, `QUIET_WINDOW_MS = WATCH_INTERVAL_MS * 5`,
  `WAIT_BUDGET_MS = 10_000`. The quiet window is *derived* from the interval on purpose, so a
  future interval bump cannot silently turn a real assertion into a vacuous one.
- Bounded waits use `vi.waitFor` (already the package's idiom — see `seed-bootstrap.spec.ts`);
  no new `waitFor` helper was added.

## Test 1 — "stops a watched instance when the row vanishes from under it"

Filter `{ mode: 'all' }`, 200 ms poll interval. Setup order is load-bearing:

1. `publishStrand(strandId)` **first**, with no sApp config registered.
2. Wait for `strand:discovered`. That event is the *proof* the watcher holds the id in its
   `knownStrands`, which is the precondition for the removal path ever firing. A delete that
   landed before the first successful poll could never fire it, and the test would then fail
   for a reason having nothing to do with the code under test. This is a gate on an event, not
   a sleep — do not "simplify" it into one.
3. Only then `addStrand(config)`. Adding first would have the watcher relaunch the strand on
   discovery and emit a second `strand:started`, muddying the event stream for no benefit.

Then `deleteStrandRow` and assert: `strand:stopped` fires for that id exactly once and stays
at once across a further five-poll quiet window; `getStrand` is `undefined` and
`getStrands().size` is 0; no `strand:error` at any point.

The last assertion is the interesting one: a re-`publishStrand` of the same id produces a
**second** `strand:discovered` rather than a relaunch. That is what proves
`handleStrandRemoved` cleared *both* `sAppConfigs` and the watcher's `knownStrands`, and that
the `Revocation` tombstone the delete left behind is not mistaken for a live row.

## Test 2 — "keeps running a strand its strandFilter excluded"

Filter `{ mode: 'strandId', strandId: <a different id> }` — the `strandId` form rather than
`{ mode: 'none' }`, because it is the shape a real app uses and it keeps the test honest about
*which* strand was excluded. `publishStrand(target)` → assert no `strand:discovered` ever
arrives → `addStrand(target)` directly (an app may run a strand the watcher was told to
ignore) → `deleteStrandRow(target)` → after a five-poll window the instance is **still**
present, with no `strand:stopped`, no `strand:discovered`, no `strand:error`.

This is documented behaviour, not a defect: a node that opted out of watching a strand also
opted out of observing its party-wide removal, so its only stop is a local
`stopStrand`/`unpublishStrand` call. Now said in both places a reader would otherwise form the
wrong expectation:

- the `unpublishStrand` doc comment's convergence-caveats paragraph
  (`packages/cadre-core/src/cadre-node.ts`, ~line 3027) — previously it mentioned only the
  *unsynced* sibling, which converges eventually; the filter-excluded sibling never does;
- the party-wide removal sentence in `docs/architecture.md:566`, one clause.

# Validation

| what | result |
| --- | --- |
| `yarn --cwd packages/cadre-core test test/strand-unpublish.spec.ts` | 10/10 passed, **6 separate runs**, no flake |
| `yarn --cwd packages/cadre-core test` (full suite) | 83 files, 1326 passed, 1 skipped — the skip is pre-existing, not introduced here |
| `yarn typecheck` | clean |
| `yarn lint` | clean (exit 0) |

**Poll-driven wait times vs. budget** (measured with temporary instrumentation, since removed —
one representative run): `strand:discovered` gate **65 ms**, `strand:stopped` gate **84 ms**,
re-publish `strand:discovered` gate **56 ms**. All against a `WAIT_BUDGET_MS` of 10 000 ms —
under 1% of budget, and under one 200 ms poll interval. Whole-test wall times were stable
across runs: test 1 ranged 2.9–3.1 s, test 2 ranged 3.5–3.7 s (test 2 has no waits at all —
it is two five-poll quiet windows plus node start plus a real strand launch). There is a very
large margin here; if these ever start timing out, the cause is not a tight budget.

# For the reviewer

## Things worth a second look

- **The filter-excluded behaviour reads as a design smell, not merely a documented
  consequence.** Test 2 pins it, and the ticket framed it as intended, so it was documented
  rather than filed. But state it plainly: a node can keep running — and keep serving — a
  strand whose party-wide row was deliberately destroyed, indefinitely, with no event and no
  log line, purely because of a local filter setting. `unpublishStrand`'s own comment already
  acknowledges the shape (the explicit `getInstance` + `stopStrand` step exists precisely
  because the watcher will never fire for such a node), but that only saves the *issuing*
  node. A sibling with an excluding filter is simply never told. Whether that is acceptable is
  a design call above this ticket's pay grade — flagging rather than filing, since filing it
  would mean asserting a defect the ticket explicitly says is not one.
- **The two "nothing happened" assertions are necessarily time-bounded.** Test 2 proves a
  negative (no stop, no discovery), so it can only ever wait a fixed window and conclude. Five
  poll intervals is the ticket's number and it is generous relative to the ~200 ms the
  positive path takes, but it is still a heuristic — a pathologically slow poll could make it
  vacuous. The derived-from-interval constant limits the damage but does not eliminate it.
- **Test 2's `addStrand` after a rejected `publishStrand`** is a slightly unusual app shape
  (run a strand your own watcher ignores). It is legitimate — `unpublishStrand`'s comment
  names it explicitly — but if you think it is *so* unusual that no real app does it, then
  test 2 is pinning a path nobody walks, and that is worth saying out loud.

## Known gaps (deliberate, not oversights)

- **No real second node.** Everything here is one process. Cross-machine visibility is
  `19.5-debt-strand-unpublish-sibling-convergence-e2e`.
- **`sAppId` filter mode untested here.** Its provisional/`defer` admission has its own
  re-evaluation branch (`strand-watcher.ts:145-164`) already covered by
  `strand-watcher-filters.spec.ts`. Ticket said out of scope; it stayed out.
- **Hibernation not enabled.** `handleStrandRemoved` untracks from the hibernation manager
  before stopping, but these specs run with hibernation off, so that line is executed and not
  meaningfully asserted. A hibernating-then-removed strand has no ticket and no coverage.
- **A poll whose read throws is swallowed and retried** (`strand-watcher.ts:179`). A test
  failing because every read errored looks identical to one failing because the row never
  disappeared. If either new test ever times out, check the `sereus:cadre:strand-watcher`
  debug output before concluding anything about convergence.

## Environment note (not a code problem)

The linked reference workspaces `C:\projects\optimystic` and `C:\projects\quereus` were being
edited concurrently during this run, which repeatedly tripped the stale-build guard in
`test-harness/build-freshness.ts` and, at times, left those workspaces' own sources
un-buildable (`db-core` mid-refactor of `Diary.create` / `CollectionTypeDescriptor.open`).
Getting a green full-suite run required rebuilding `@quereus/quereus`,
`@optimystic/db-core`, `@optimystic/db-p2p`, and
`@optimystic/quereus-plugin-optimystic` and starting the suite immediately after. Nothing in
those repos was modified or reverted. If the reviewer hits the same guard, that is why.

# TODO (review pass)

- Confirm the setup ordering rationale in test 1 holds — specifically that gating on
  `strand:discovered` really is the only way to know `knownStrands` holds the id, and that
  nothing cheaper and less subtle was missed.
- Decide whether the filter-excluded strand (first bullet above) deserves a ticket after all,
  or stays documented behaviour.
- Sanity-check that the `WeakMap` owner-key stash is the right call versus changing
  `startSelfOwnerNode`'s return type — the ticket asked for unchanged call sites, and this
  honours that, but it is indirection worth a second opinion before the consolidation pass
  in `plan/20-debt-self-owner-node-test-harness-duplicated` inherits it.
