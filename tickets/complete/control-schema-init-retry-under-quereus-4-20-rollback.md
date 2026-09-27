description: The written reasoning for why Sereus can safely retry setting up its shared settings database was out of date with the new database engine; the reasoning is corrected everywhere it was stated, including the architecture document, and a test now holds the engine to it.
architecture: docs/architecture.md#control-network
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-schema-apply-unwind.spec.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, docs/architecture.md
----

# What shipped

`ControlDatabase.loadSchema` retries its whole `apply schema CadreControl` statement on a transient failure. Three places stated why re-running is safe, and all three gave the pre-4.20.0 reason: "a failed `create table` leaves the catalog clean, so attempt 2 re-emits exactly the failed table and its successors". Quereus 4.20.0 replaced that half — a failed apply is unwound whole and checked against a fingerprint of the pre-apply catalog — so the conclusion survives but the reason does not, and the new reason depends on something the old one did not: the optimystic plugin's schema batch hooks, which carry the catalog's unwind through to storage.

Five statements now say the same, corrected thing, with the full argument at the one call site and the others pointing at it.

- **`control-database.ts`, above the `lockedWithRetry` call** — the full argument. Diff-not-replay is unchanged; the second bullet describes the undo journal, the reverse run, the fingerprint check, and that attempt 2 therefore re-emits the whole schema. A paragraph names the dependency plainly: the unwind is Quereus's, storage following it is the plugin's, and the argument is only true on a plugin build with those batch hooks.
- **`control-write-retry.ts`, `RETRIABLE_SCHEMA_INIT_MATCHERS`** — short restatement, plus the partially-migrated decision made in the open (below).
- **`control-write-retry.ts`, `SCHEMA_INIT_RETRY_POLICY`** — one clause corrected, pointing at the call site.
- **`control-write-retry.spec.ts` suite doc** — same correction, plus a pointer to the new spec; also one in-test comment that claimed "the tables that landed on attempt 1 emit no DDL the second time", which the unwind makes false.
- **`docs/architecture.md`, the schema-init paragraph of the control-network bullet** — added in review. It had argued the extra retry class safe from the diff property alone, which is true but half the argument, and this document is the ticket's anchor.

**The partially-migrated case is decided as documented-not-vetoed.** When the unwind cannot complete, Quereus keeps the failing step's own message and appends the reason the schema could not be restored, with the original as `cause`; Sereus's classifier walks `cause` chains by message text, so a transient cause underneath still classifies as retriable and neither veto looks for that reason text. `RETRIABLE_SCHEMA_INIT_MATCHERS` says that is deliberate and why: the plugin commits whatever its write batch holds, so storage and the catalog are left in step either way, the next apply diffs against what is really there, and vetoing would turn a healable transient outage into a dead start. No code change.

**`compose-strand.ts` carries a `NOTE:`** at the sApp `apply schema App` — no code change, no test. An sApp schema is supplied by the embedder, and a step that discards data (dropping a table or a column, narrowing a column's type) is irreversible to Quereus's differ, so one in a migration leaves any later failing step partially migrated rather than restored. Nothing in this repo supplies such a schema today.

# The new test

`packages/cadre-core/test/control-schema-apply-unwind.spec.ts` — one test, ~300ms, pinning one behaviour: **a refused DDL step part-way through `apply schema CadreControl` unwinds the apply whole, and the next apply reaches the complete schema.**

- It builds a libp2p node with `createLibp2pNode` and a `ControlDatabase` directly, so the re-apply runs on the **same Quereus `Database`** as the failed apply — which is what the retry does. `CadreNode` cannot give that shape (it discards its `ControlDatabase` when `start()` fails), and a fresh database would take the plugin's hydrate path and so could pass while stale in-process plugin state survived the unwind.
- The storage seam is gated with a `Proxy` over `MemoryRawStorage` that refuses every call naming `default/cadrecontrol/CadrePeer` until healed. That fails exactly the `create table CadreControl.CadrePeer` step, four tables into the apply.
- It refuses **until healed** rather than spending a fixed budget: the budget that reaches the DDL is a property of the layer below (which absorbs the first refusal), not of the apply, so a tuned number would quietly stop failing the step if that count changed. Measured: shut-until-healed and budget-of-two produce byte-identical failures.
- Three assertions carry it, and each fails for its own reason: the failure names the gated step (so four tables did land — this is the anti-vacuity anchor); the message carries no `partially migrated` sentence (the engine's own verdict that the journal ran in reverse and the catalog matched its fingerprint); and **between the two applies the catalog lists no `cadrecontrol` object at all** (the unwind was total, which is what the call-site argument actually rests on). Then the whole catalog after the re-apply: nine tables and `FormationUsageByToken`, nothing beside them.
- It does **not** drive the retry loop, and says so in its own doc comment. The injected refusal is rewritten on the way up into `Block … is unavailable (unmaterializable)`, which `isRetriableSchemaInitFailure` correctly declines, so `lockedWithRetry` never fires. `control-write-retry.spec.ts` owns the loop over a stubbed `exec`; the two files are a matched pair and each names the other.

Run: `yarn workspace @serfab/cadre-core exec vitest run control-schema-apply-unwind`

# Review findings

## Checked

Read the implement diff before the handoff summary, then re-derived every factual claim in the corrected comments against the linked sibling sources rather than taking the summary's word: quereus `packages/quereus/src/runtime/emit/schema-declarative.ts` (`runBatchedMigrationLoop`, `runStepsWithUndoJournal`, `unwindJournal`, `NOT_RESTORED`, `describeIrreversible`), quereus `packages/quereus/src/schema/schema-differ.ts` (which steps are marked irreversible, and why), and optimystic `packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts` plus `OptimysticModule.beginSchemaBatch` / `endSchemaBatch`. The load-bearing claims hold: the unwind is real, it runs inside the module batch, and the optimystic plugin commits its overlay on error too — documented there explicitly as a deliberate deviation from the upstream hook doc, which is exactly the half the new comments depend on. The safety conclusion all five statements now give is correct.

Also re-derived the new spec's two measured facts myself instead of trusting the handoff (probed the catalog between the applies, and after the second), and checked that the stale `packages/cadre-core/dist/control-write-retry.d.ts` still carrying the old wording is git-ignored and untracked — a local unbuilt dist, nothing to correct.

## Found and fixed inline — accuracy of the corrected reasoning

These are all in the text this ticket exists to correct, which is why they were worth fixing rather than noting.

- **The wrapping direction was backwards.** `control-write-retry.ts` said Quereus "prefixes `The schema is partially migrated and could not be restored` to the original message". `runBatchedMigrationLoop` throws `${failure.error.message}\n${failure.notRestored}` — the original comes first and the reason is appended. The new spec's comment carried the same inversion. Both corrected.
- **One unwind-failure case was named where there are four.** Both source comments said the only case the unwind cannot cover is "an undo statement that itself failed". `unwindJournal` and `runStepsWithUndoJournal` set `notRestored` on four distinct conditions: a failed undo statement, a post-unwind catalog that does not match the fingerprint, a catalog that could not be re-collected to check it, and a step marked irreversible poisoning the journal before it ran. Broadened at both sites. This matters because the documented decision (retry rather than veto) covers all four, and a reader who checked only the named case would reasonably conclude the other three had gone unconsidered.
- **`compose-strand.ts` named `drop table` as the irreversible step.** `schema-differ.ts` marks three data-discarding kinds — dropping a table, dropping a column, narrowing a column's type. Broadened, since an embedder schema evolving by any of them lands in the same place.
- **Stale residue in the first bullet of the call-site argument.** It still ended "Tables that already landed generate no statements on the second pass", which the new second bullet contradicts — under the unwind nothing stays landed. Rewritten to say what the diff property is actually buying (a warm start's apply is a no-op), so the two bullets no longer disagree.

## Found and fixed inline — the new test

- **It did not assert the property it exists for.** The absence of `partially migrated` and the complete schema after the re-apply both also pass on an engine that left the four landed tables in place, because the re-apply's diff reaches the complete schema either way. The totality of the unwind was recorded only as a prose "measured 2026-09-25" and as a comment-out experiment described in the handoff. Now asserted: the catalog between the two applies must equal an empty map. Probed the value first to confirm the assertion is both true and load-bearing.
- **The last assertion was weaker than the measurement, and hedged with coined vocabulary** — `toContain('FormationUsageByToken')`, justified by "optimystic may expose covering structures of its own". Measured the real catalog: exactly nine tables and exactly that one index. Replaced both assertions with one equality over the whole map, and the hedge with the measured fact, which also drops an undefined term.
- **An overstated claim about `IRawStorage`.** The gate's doc comment said "every `IRawStorage` method takes the block id first". Three do not (`getStoreIdentity`, `listBlockIds`, `getApproximateBytesUsed`) and `readCached` is a property. The `Proxy`'s behaviour is correct regardless — a no-arg call cannot match the gated id — but the stated justification was false. Corrected to name the store-wide methods and say why falling through is right.
- **Cleanup could leak a node.** `finally { await controlDb.close(); await node.stop(); }` skipped `node.stop()` if `close()` threw, stranding a libp2p node in the vitest worker for the rest of the run. Nested.

No test was added or removed. The one new test earns its place (it pins a cross-package contract nothing else covers) and now asserts three things rather than two.

## Found and fixed — the doc gap the handoff flagged

`docs/architecture.md` is this ticket's anchor, and its schema-init paragraph still argued the extra retry class safe from the diff property alone. Not wrong, but it is the one place a reader goes for the argument and it gave half of it. Added the unwind, the fingerprint check and the plugin's commit-on-error, said plainly that the second half is a property of the *pair* rather than of Quereus, and pointed at both the new spec and the call site. The handoff called this out as something "a reviewer may reasonably want"; it wanted it.

## Parked as a tripwire, not a ticket

The new spec only passes against a plugin build carrying the batch hooks, which today is `../optimystic` HEAD. HEAD calls itself `1.5.0` and the registry serves `1.5.0` without the hooks, so `^1.5.0` admits both and the range gate cannot tell them apart. The handoff said nothing currently catches that mismatch — true of `yarn smoke:published`, but not of `yarn check:published`, which runs these suites against registry copies of the siblings and will red on this spec. Recorded as a `NOTE:` in the spec's doc comment, naming it as a triage arm beyond the three `docs/testing.md` lists for that script. No ticket: there is nothing to do until the plugin ships, and raising the floors then is a one-line gardening move.

## Cosmetic

A mid-sentence line break left in `SCHEMA_INIT_RETRY_POLICY`'s doc comment ("… for its own write body first; if this / policy ever grows …"). Rewrapped.

## Considered and deliberately left alone

- **Comment volume at `loadSchema`** — about 45 lines of argument for one call. It states why, not what, and it matches the density of its own neighbours in that method and of `docs/architecture.md`. Left.
- **The spec hand-builds its node options** rather than reusing `CadreNode.buildControlNodeOptions`, and nothing keeps the two in step. The handoff asked a reviewer who disagreed to say what a drift would break here. Nothing would: the spec asserts the catalog contents of a schema apply, and a change to node configuration cannot silently make that pass. The three duplicated fields are already named in the file as the subset under test. Left.
- **The coupling to Quereus's `Failed to execute DDL: create table …` wording.** It is what makes the test non-vacuous — the anchor proving four tables landed before the failure — and an upstream reword reddens it loudly rather than weakening it silently. Left.
- **The partially-migrated path still has no test.** Correct by the ticket's own call, and now for a stated reason: a `CadreControl` diff generates no data-discarding step, so that branch is unreachable from this schema and a test would have to forge engine state. The decision is documented at `RETRIABLE_SCHEMA_INIT_MATCHERS`, now with the full set of conditions it covers rather than one of them.
- **`CONTROL_TABLE_NAMES` duplicating `schemas/control.qsql`.** That duplication is the assertion; deriving it from the schema would assert nothing.

## Not found

No correctness defect in the shipped behaviour — the diff is comments plus one new test, and the behaviour it describes was verified against both siblings' sources rather than assumed. No resource leak outside the spec's `finally` noted above. No error path swallowing an exception, no `any`, no lint or type violation. Nothing else in the repo still states the pre-4.20.0 reason: grepped `catalog clean`, `diff rather than a replay`, `diff, not a replay` across `packages/`, `docs/` and `schemas/`, and the only remaining hits are the corrected sites plus untracked `dist/` output.

# Validation

- `yarn lint` — clean.
- `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/quereus-plugin-sereus typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` — 139 files, 2273 passed, 1 skipped.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 10 files, 113 passed, 1 todo.
- `yarn workspace @serfab/quereus-plugin-sereus build` was run, because `compose-strand.ts` was touched and the stale-build guard blocks cadre-core's suite otherwise. No sibling repo was built or edited.
- After the last comment-only edit (broadening the irreversible-step list in `RETRIABLE_SCHEMA_INIT_MATCHERS`) the re-run was scoped to `yarn lint`, cadre-core's typecheck, and `vitest run control-write-retry control-schema-apply-unwind` — 56 passed. The full suites above predate that one comment edit.

No pre-existing failures surfaced; nothing was skipped, disabled or loosened.
