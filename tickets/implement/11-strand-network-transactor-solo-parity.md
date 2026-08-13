----
description: Before we delete the private storage path a lone device currently uses for a new workspace, prove with tests that the normal shared path does everything the private one did when a device is alone — same answers, same data still readable, and fast enough.
prereq:
files: packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/quereus-plugin-sereus/src/compose-strand.ts
difficulty: hard
----

# Evidence gate: a solo strand on the network transactor

This is the **first of three** tickets retiring the strand `bootstrap` mode (the follow-ups are
`retire-strand-mode-in-cadre-core`, then `drop-strand-mode-option-from-sql-plugin`). It changes **no
production code**. It adds the three tests that decide whether the retirement is safe, and it
records the before/after numbers that the plan ticket set as the acceptance bar.

Do the work in this order and stop at the first failure — see *If a case fails* at the bottom.

## Background, in plain terms

A strand (one workspace's database) runs on one of two storage engines today, chosen at launch:

- the **local transactor** — writes go straight to this device's own block storage, no peers
  consulted. Chosen when the device is the only member of the party (`selectStrandMode` in
  `packages/cadre-core/src/strand-cohort.ts:75`).
- the **network transactor** — writes go through the peer-to-peer cohort. Chosen once another
  device exists.

The plan is to delete the first choice, because the storage engine already handles the
lone-device case internally: a node alone resolves itself as coordinator and commits without
waiting on anybody. The control database (the party's own membership database) has always used the
network transactor and works solo, which is the standing evidence that this is true.

Before deleting anything we need three specific facts, none of which any test in this repo asserts
today:

1. **Speed.** A solo strand's launch, insert and select must not get materially slower on the
   network transactor.
2. **Existing data stays readable.** Every strand on every device that has ever run solo has its
   blocks on disk *written by the local transactor*. After the change those same bytes are read —
   and appended to — through the network transactor. Both paths write through the same
   `StorageRepo`, so this is expected to work; it is also the one place a silent data-visibility
   regression could hide, and nothing checks it.
3. **Constraints still bite.** All of the strand membership/RBAC enforcement tests
   (`strand-membership-*.spec.ts`) run through the **local** transactor, because that is what
   `openRawStrand` in `test/strand-spec-helpers.ts:100` selects. Deferred, subquery-bearing `CHECK`
   constraints — `Manager.Authorized`, `Manager.MinOneManager` — are what stop an unauthorized
   party from removing a strand's administrators. Reading the code says enforcement lives in
   Quereus and the Optimystic vtab session, not in the transactor, so it should be identical on
   both. Reading is not proof, and after the retirement the production path is the one with no
   coverage.

Both transactors are selectable **right now**, so all three facts are measurable in one pass with
no production change. That is the whole point of doing this ticket first.

## What lands

### A shared storage-operation counter

`packages/cadre-core/test/control-start-storage-op-budget.spec.ts` already contains the measurement
apparatus this ticket needs: `StorageOpCounter`, the `CountingRawStorage` passthrough (written out
method-by-method deliberately, so a new `IRawStorage` method fails the build rather than going
uncounted), and the `formatSnapshot` / `formatBreakdown` printers — roughly lines 90–340 of that
file.

Hoist them verbatim into `packages/cadre-core/test/storage-op-counter.ts` and import from both
specs. Do not copy them; two counters would drift, and the existing spec's budgets must keep
passing unchanged (cold ≤ 1700 ops / ≤ 24 blocks, warm ≤ 360 / ≤ 25) as the proof the hoist was
faithful.

### Spec 1 — `packages/cadre-core/test/strand-solo-write-budget.spec.ts`

A solo `CadreNode` (no siblings, no bootstrap peers, hibernation off), `addStrand`, then a small
fixed number of single-row inserts and selects against the sApp schema. Two arms over the same
shape, driven by the still-existing `mode` argument to `addStrand`:

- `mode: 'bootstrap'` — the **baseline arm**. Label it in a comment as deleted by
  `retire-strand-mode-in-cadre-core`; it exists to produce the "before" column and nothing else.
- `mode: 'networked'` — the arm that survives.

Storage is `MemoryRawStorage` wrapped in `CountingRawStorage`, handed in through
`CadreNodeConfig.storage.provider`. **Count the strand's storage only**: the provider is called
with `'control'` for the control node (`cadre-node.ts:1013`) and with the strandId for a strand
(`strand-instance-manager.ts:142`), so branch on the id and wrap only the strand's instance.
Otherwise the control database's ~1500-operation start swamps the measurement.

Report per phase (launch / insert / select), per arm:

- storage operations and distinct block ids — deterministic, so **assert two-sided budgets** on the
  surviving arm (a floor as well as a ceiling, so a spec that silently measures nothing fails);
- wall-clock milliseconds — noisy, so **print, and bound only loosely**.

Print every number under a greppable prefix (`[strand-write-budget] …`), following the existing
budget spec's convention, so re-measuring is reading a test run rather than writing a script.

**A-priori decision thresholds** (chosen before measuring, not derived from a measurement): if the
networked arm needs more than ~3× the baseline's storage operations for the same insert, or a solo
insert exceeds ~250 ms wall-clock on a developer machine over `MemoryRawStorage`, treat the pass as
failed and hand off — see below.

Write the numbers into the handoff as a table with the arm, the phase, the ops, the distinct blocks
and the milliseconds. The surviving arm's numbers become the committed budgets.

### Spec 2 — `packages/cadre-core/test/strand-transactor-handover.spec.ts`

The migration case: bytes written by the local transactor, read and appended through the network
transactor.

- **Phase 1** — a `FileRawStorage` (from `@optimystic/db-p2p-storage-fs`) under a fresh temp
  directory. `connectToStrand(db1, { strandId, schema, transactor: 'local', storage })`, apply the
  schema, insert rows, then `result.shutdown()` and close the `Database`. Use the plugin's existing
  `transactor` option, **not** `mode: 'bootstrap'` — `transactor` is the knob that survives ticket
  three, so this spec needs no edit later.
- **Phase 2** — a fresh `Database` over the **same directory** (a new `FileRawStorage` instance, so
  only bytes cross the boundary — the idiom `control-database-solo-warm-start.spec.ts` established),
  `connectToStrand(db2, { strandId, schema, storage })` with the transactor defaulted (network).
  Assert: the phase-1 rows are all still selectable; the hydrate counts show the catalog was
  hydrated rather than re-created (`result.hydrated.tables > 0`); a **new** insert commits; and a
  final select sees both generations of rows.

Reuse `test/control-db-node-helpers.ts`'s temp-directory helper rather than inventing one.

### Spec 3 — `packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts`

The narrow question: do the deferred, subquery-bearing membership constraints reject the same writes
when the transactor is the network one?

Give `openRawStrand` in `test/strand-spec-helpers.ts` an optional transactor argument (default
unchanged, so no existing spec changes behaviour), then re-run a **small** selected set of the
strongest existing membership assertions through the network transactor. Enough, not exhaustive:

- an unauthorized `Manager` delete is rejected (`Manager.Authorized`, deferred, on delete — the
  claim `packages/cadre-core/src/strand-membership-writer.ts:1378` makes today, attributing it to
  the "bootstrap-mode transactor");
- removing the last manager is rejected (`Manager.MinOneManager`, `check on delete`, deferred);
- an authorized add-then-resign handoff is accepted.

Note in the file header that each of these mirrors a named test in the existing
`strand-membership-*.spec.ts` suites, which keep running on the local transactor, and that this
spec's job is transactor parity, not re-litigating the RBAC rules.

Each case creates a real libp2p node (the plugin creates one for the network transactor even with
an empty bootstrap list), so keep the case count low and the per-test timeout generous.

## Edge cases & interactions

- **Node-per-connect cost.** `composeStrand` acquires a libp2p node for every transactor except the
  unit-test fake (`compose-strand.ts:211`), so the network arms of specs 2 and 3 each boot a real
  node. Budget wall-clock accordingly and make sure every spec tears its node down
  (`result.shutdown()` stops the node it created) — a leaked node keeps vitest alive.
- **Cluster policy differs between the two node factories.** `cadre-core` creates strand nodes with
  `STRAND_CLUSTER_POLICY` (`strand-instance-manager.ts:317`); the plugin's own factory
  (`quereus-plugin-sereus/src/connect.ts:28`) passes none and takes Optimystic's defaults. Those
  defaults match on the two fields that matter for a solo commit (`allowDownsize: true`,
  `sizeTolerance: 0.5` — `db-p2p/src/libp2p-node-base.ts:630`), so specs 2 and 3 can commit alone.
  They differ on `assumedClusterSize`, which only moves the read-repair corroboration floor. Filed
  separately as `backlog/debt-plugin-strand-node-omits-cluster-policy`; do not fix it here, and do
  not write a spec that depends on either behaviour.
- **Counting the wrong storage.** A provider that wraps `'control'` too will produce a strand
  measurement dominated by control-database start traffic. Assert in the spec that the counter saw
  zero operations before `addStrand`, so this mistake fails loudly instead of inflating a budget.
- **Op counts are a property of the storage layer's call pattern, not the backend** — established by
  `tickets/complete/control-start-storage-op-budget.md`, where `MemoryRawStorage` and
  `FileRawStorage` agreed. So `MemoryRawStorage` is the right backend for spec 1; say so in a
  comment rather than adding a file-backed arm.
- **Empty bootstrap list, no listen address.** Every arm here is a genuinely isolated node. The
  coordinator-lookup retry window that used to cost ~1 s per block on such a node is
  evidence-gated upstream now (`optimystic/tickets/complete/isolated-coordinator-lookup-pays-futile-retry-window`,
  landed in the linked workspace: `retryCouldImprove` in `db-p2p/src/libp2p-key-network.ts:333`).
  State in the handoff which linked `@optimystic/*` version the numbers came from — the ticket that
  consumes them cannot re-derive it.
- **Parallel vitest.** These specs boot real nodes on random ports; nothing may bind a fixed port.
  Re-run spec 1 inside the full package suite as well as standalone, and report both numbers if they
  differ — the existing budget spec's counts were stable under parallel load, and a strand
  measurement that is not should be reported rather than averaged away.

## If a case fails

Any of the three failing means the plan ticket's own exit clause has tripped: **do not proceed to
the retirement, and do not weaken the spec to get a green run.** Finish and commit the specs that
do pass, then write the failing one's evidence into a new `tickets/fix/` ticket naming the one site
that must change, and say in this ticket's handoff that
`retire-strand-mode-in-cadre-core` is now blocked on it. A slow network transactor, a block written
locally that cannot be read back, or a constraint that stops biting are each a bigger finding than
the retirement itself.

## Validation

```
packages/cadre-core:  yarn typecheck
packages/cadre-core:  yarn vitest run 2>&1 | tee /tmp/cadre-core.log
repo root:            yarn lint
```

Run the three new specs standalone first (fast feedback), then the whole `cadre-core` suite —
`control-start-storage-op-budget.spec.ts` must still pass with its budgets untouched, which is the
hoist's proof.

## TODO

- Hoist `StorageOpCounter` / `CountingRawStorage` / the formatters out of
  `control-start-storage-op-budget.spec.ts` into `test/storage-op-counter.ts`; import from the
  existing spec; re-run it and confirm the budgets still pass unchanged.
- Add `strand-solo-write-budget.spec.ts` with both arms; wrap only the strand's storage; print every
  phase under `[strand-write-budget]`.
- Record the before/after table (arm × phase × ops / distinct blocks / ms) in the handoff, plus the
  linked `@optimystic/*` version.
- Assert two-sided op budgets on the networked arm; leave wall-clock printed and loosely bounded.
- Add `strand-transactor-handover.spec.ts` (local write → restart → network read + append), using
  the plugin's `transactor: 'local'` for phase 1.
- Give `openRawStrand` an optional transactor argument, default unchanged.
- Add `strand-membership-network-transactor-parity.spec.ts` with the three membership cases.
- Run spec 1 standalone and inside the full package suite; report both if they differ.
- Handoff: state plainly whether each of the three facts is now proven, with numbers, and whether
  `retire-strand-mode-in-cadre-core` is clear to proceed.
