description: The written reasoning for why Sereus can safely retry setting up its shared settings database was out of date with the new database engine; the reasoning is corrected in the four places it was stated and a test now holds the engine to it.
architecture: docs/architecture.md#control-network
files:
  - packages/cadre-core/src/control-database.ts (`loadSchema`, the re-run safety comment above the `lockedWithRetry` call)
  - packages/cadre-core/src/control-write-retry.ts (`RETRIABLE_SCHEMA_INIT_MATCHERS`, `SCHEMA_INIT_RETRY_POLICY`)
  - packages/cadre-core/test/control-write-retry.spec.ts (the `ControlDatabase.loadSchema` suite doc and one in-test comment)
  - packages/quereus-plugin-sereus/src/compose-strand.ts (`apply schema App`)
  - NEW: packages/cadre-core/test/control-schema-apply-unwind.spec.ts
repro: verified
difficulty: medium
----

# What changed

`ControlDatabase.loadSchema` retries its whole `apply schema CadreControl` statement on a transient failure. Three places stated why re-running is safe, and all three gave the pre-4.20.0 reason: "a failed `create table` leaves the catalog clean, so attempt 2 re-emits exactly the failed table and its successors". Quereus 4.20.0 replaced that half — a failed apply is unwound whole and checked against a fingerprint of the pre-apply catalog — so the conclusion survives but the reason does not, and the new reason depends on something the old one did not: the optimystic plugin's schema batch hooks, which carry the catalog's unwind through to storage.

All four statements now say the same, corrected thing, with the full argument at the one call site and the others pointing at it.

- **`control-database.ts`, above the `lockedWithRetry` call** — the full argument. Diff-not-replay is unchanged; the second bullet now describes the undo journal, the reverse run, the fingerprint check, and that attempt 2 therefore re-emits the whole schema. A new paragraph names the dependency plainly: the unwind is Quereus's, storage following it is the plugin's, and the argument is only true on a plugin build with those batch hooks.
- **`control-write-retry.ts`, `RETRIABLE_SCHEMA_INIT_MATCHERS`** — short restatement, plus the partially-migrated decision made in the open (below).
- **`control-write-retry.ts`, `SCHEMA_INIT_RETRY_POLICY`** — one clause corrected, pointing at the call site.
- **`control-write-retry.spec.ts` suite doc** — same correction, plus a pointer to the new spec; also one in-test comment that claimed "the tables that landed on attempt 1 emit no DDL the second time", which the unwind makes false.

**The partially-migrated case is decided as documented-not-vetoed**, per the ticket's recommendation. When an undo statement itself fails, Quereus prefixes `The schema is partially migrated and could not be restored` to the original message and keeps the original as `cause`; Sereus's classifier walks `cause` chains by message text, so a transient cause underneath still classifies as retriable and neither veto looks for that sentence. `RETRIABLE_SCHEMA_INIT_MATCHERS` now says that is deliberate and why: the plugin commits whatever its write batch holds, so storage and the catalog are left in step either way, the next apply diffs against what is really there, and vetoing would turn a healable transient outage into a dead start. No code change.

**`compose-strand.ts` carries a `NOTE:`** at the sApp `apply schema App` — no code change, no test. An sApp schema is supplied by the embedder, and a `drop table` step is irreversible to Quereus's differ, so one in a migration leaves any later failing step partially migrated rather than restored. Nothing in this repo supplies such a schema today.

# The new test

`packages/cadre-core/test/control-schema-apply-unwind.spec.ts` — one test, ~180ms, pinning one behaviour: **a refused DDL step part-way through `apply schema CadreControl` leaves storage and the catalog in step, and the next apply reaches the complete schema.**

Shape, and why it is this shape:

- It builds a libp2p node with `createLibp2pNode` and a `ControlDatabase` directly, so the re-apply runs on the **same Quereus `Database`** as the failed apply — which is what the retry does. `CadreNode` cannot give that shape (it discards its `ControlDatabase` when `start()` fails). This is the stronger of the two options the ticket offered; the weaker one (a second `CadreNode` over the same blocks) would also take the plugin's hydrate path and so could pass while stale in-process plugin state survived the unwind.
- The storage seam is gated with a `Proxy` over `MemoryRawStorage` that refuses every call naming `default/cadrecontrol/CadrePeer` until healed. That fails exactly the `create table CadreControl.CadrePeer` step, four tables into the apply.
- It refuses **until healed** rather than spending a fixed budget. The ticket's reproduction used a budget of two (the layer below absorbs the first refusal and retries once), but that number is a property of the layer below, not of the apply, and a budget tuned to it would quietly stop failing the step if the count changed. Measured: shut-until-healed and budget-of-two produce byte-identical failures.
- It does **not** drive the retry loop, and says so at length in its own doc comment. The injected refusal is rewritten on the way up into `Block … is unavailable (unmaterializable)`, which `isRetriableSchemaInitFailure` correctly declines, so `lockedWithRetry` never fires. `control-write-retry.spec.ts` owns the loop over a stubbed `exec`; the two files are a matched pair and each names the other.

## What to check when validating

Four things were measured on 2026-09-25 against the linked tree (`@quereus/quereus` 4.20.0, `@optimystic/quereus-plugin-optimystic` at `../optimystic` HEAD). Each is worth re-deriving if you want to satisfy yourself the test is not vacuous:

- **The failure is the gated step.** The message is `Failed to execute DDL: create table CadreControl.CadrePeer (…)` with cause `Module 'optimystic' create failed for table 'CadrePeer': … Block default/cadrecontrol/CadrePeer is unavailable (unmaterializable)`. The spec asserts the first clause.
- **The unwind completes.** The message carries no `partially migrated` sentence. This is the assertion the file exists for — its absence is what says the journal ran in reverse, the catalog matched its fingerprint, and the plugin committed the restored state.
- **The unwind is total.** Comment out the `internals.loadSchema()` line and the catalog assertion fails with `undefined` — between the two applies `schema()` lists no `cadrecontrol` object at all, including the four tables that had already landed. That is the direct evidence for "attempt 2 re-emits the whole schema".
- **The gate is not the reason the unwind succeeds.** With an unbounded (never-healed) gate the refusal count still stops at two and the message is identical: the unwind never asks for the gated block.

Run: `yarn workspace @serfab/cadre-core exec vitest run control-schema-apply-unwind`

# Validation run

- `yarn workspace @serfab/cadre-core test` — 139 files, 2273 passed, 1 skipped.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 10 files, 113 passed, 1 todo. (Run because `compose-strand.ts` was touched and its `dist` rebuilt; the change is a comment.)
- `yarn lint` — clean.
- `yarn workspace @serfab/cadre-core typecheck` and `yarn workspace @serfab/quereus-plugin-sereus typecheck` — clean.
- `yarn workspace @serfab/quereus-plugin-sereus build` was run, because the stale-build guard blocks cadre-core's suite otherwise. No sibling repo was built or edited.

No pre-existing failures surfaced.

# Known gaps — treat as starting points, not finished work

- **The new spec only passes on a plugin build with the batch hooks**, which is `../optimystic` HEAD and is unreleased. Per the ticket, every `@optimystic/*` and `@quereus/*` range in `package.json` was left alone; raising the floors is the gardener's move once the plugin ships. Until then this spec is one of the things that would go red against published tarballs — though `yarn smoke:published` does not run it (the scratch project has no vitest), so nothing currently catches that mismatch either way.
- **The spec hand-builds its node options** rather than reusing `CadreNode.buildControlNodeOptions`, and nothing keeps the two in step. Deliberate and documented in the file: what is under test is the schema apply over optimystic storage, not node configuration. A reviewer who disagrees should say what a drift between them would break here.
- **`docs/architecture.md:98` was left as-is.** Its schema-init paragraph says the extra retry class is safe "because `apply schema` is a diff rather than a replay" — still true, and it never stated the half that changed, so it is not wrong. It is now incomplete: it does not mention the unwind or the plugin-side dependency. Left alone because the ticket scoped the correction to the four code sites; a reviewer may reasonably want a sentence added there.
- **The partially-migrated path has no test**, by the ticket's own call ("not worth its own test"). The decision is recorded at `RETRIABLE_SCHEMA_INIT_MATCHERS` and nothing enforces it; a future veto added to either `reportsPossiblyStoredWrite` or `reportsIndeterminateCommit` could silently reverse it.
- **The failure assertion couples to Quereus's wrapper wording** (`Failed to execute DDL: create table …`). An upstream reword fails the test loudly rather than silently, which is the right direction, but it is a coupling worth knowing about.
- **`tickets/backlog/feat-shared-react-native-app-kit.md` is untracked in the working tree and is not from this ticket** — left in place.
