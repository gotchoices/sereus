----
description: Added the three tests that prove a lone device works just as well on the normal shared storage path as on the private one we plan to delete — same answers, old data still readable, and no slowdown. All three passed, so the deletion can go ahead.
prereq:
files: packages/cadre-core/test/storage-op-counter.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, packages/cadre-core/test/strand-transactor-handover.spec.ts, packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts, packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/control-start-storage-op-budget.spec.ts
----

# Evidence gate: a solo strand on the network transactor — implemented, all three facts proven

First of three tickets retiring the strand `bootstrap` (local-transactor) mode. **No production
code changed** — this ticket adds the evidence tests. Verdict up front:

**`retire-strand-mode-in-cadre-core` is clear to proceed.** None of the plan's exit clauses
tripped.

## The three facts, with numbers

Linked substrate the numbers came from: `@optimystic/db-p2p` **0.22.0**, linked workspace
`../optimystic` at commit **6cc08ac** (all `@optimystic/*` packages resolve to that workspace via
root `package.json` resolutions).

### Fact 1 — Speed: proven (`strand-solo-write-budget.spec.ts`)

Solo `CadreNode`, open strand, 5 single-row inserts + 5 full-table selects over
`MemoryRawStorage`. Op counts were **byte-identical across three standalone runs and the full
parallel suite run**; wall clock varies with load, shown as standalone / full-suite:

| arm | phase | ops | distinct blocks | ms (standalone / suite) |
|---|---|---|---|---|
| bootstrap (baseline, dies with the mode) | launch | 1592 | 17 | 135 / 427 |
| bootstrap | insert ×5 | 364 | 3 | 12 / 43 |
| bootstrap | select ×5 | 230 | 2 | 8 / 35 |
| **networked (survives)** | launch | **1613** | **17** | 78 / 315 |
| **networked** | insert ×5 | **366** | **3** | 15 / 76 |
| **networked** | select ×5 | **230** | **2** | 9 / 41 |

Against the a-priori thresholds: the networked arm costs **1.005×** the baseline's insert
operations (366 vs 364; threshold was 3×), and a solo networked insert averages **~3 ms**
standalone, ~15 ms under full parallel suite load (threshold was 250 ms). The entire launch delta
is +21 `getMetadata` calls; selects are byte-identical between arms. The networked arm carries
committed two-sided budgets (ceiling + anti-vacuity floor, measured 2026-08-13); the baseline arm
is print-only, labelled for deletion by `retire-strand-mode-in-cadre-core`.

### Fact 2 — Existing data stays readable: proven (`strand-transactor-handover.spec.ts`)

Phase 1 writes 3 rows through the plugin's `transactor: 'local'` into a `FileRawStorage` under a
temp dir, then shuts down. Phase 2 opens a **fresh** `FileRawStorage` over the same directory
(only bytes cross the boundary) with the transactor defaulted (network) and asserts: catalog
**hydrated** rather than re-created (`hydrated.tables > 0`), all 3 local-era rows selectable, a
new network-transactor insert commits, final select sees both generations. Passes (~5 s
standalone, ~13 s in suite). Phase 1 deliberately uses `transactor` (the knob that survives ticket
three), not `mode: 'bootstrap'`, so this spec needs no edit when the mode is dropped.

### Fact 3 — Constraints still bite: proven (`strand-membership-network-transactor-parity.spec.ts`)

Three cases through `openStrand('c', 'network')`, each mirroring a named local-transactor test in
`strand-membership-manager-rotation.spec.ts` (which keeps running unchanged):

- unauthorized `Manager` delete → rejected, error pins `/Authorized/` (deferred, on delete);
- sole manager resigning → rejected, error pins `/MinOneManager/` (deferred post-image floor);
- authorized add-then-resign hand-off → accepted, successor alone remains.

So the deferred, subquery-bearing CHECK enforcement genuinely lives above the transactor, as the
code read suggested — now proven on the path that becomes production-only.

## What changed

- **`test/storage-op-counter.ts`** (new): `StorageOpCounter`, `CountingRawStorage`,
  `formatBreakdown`/`formatSnapshot` hoisted out of `control-start-storage-op-budget.spec.ts`.
  One deliberate non-verbatim change: `formatSnapshot` takes the greppable prefix as a parameter
  (it was hardcoded `[storage-op-budget]`; the new spec needs `[strand-write-budget]`). The
  control spec re-ran with identical figures (cold 1541/21, warm 315/22) and untouched budgets —
  the hoist-faithfulness proof the ticket demanded.
- **`test/strand-solo-write-budget.spec.ts`** (new): the two-arm budget spec. Counts **only** the
  strand's storage (provider branches on the strandId; a zero-ops assertion before `addStrand`
  fails loudly if the control storage ever gets wrapped). `latencyHint: 'realtime'` turns
  hibernation off.
- **`test/strand-transactor-handover.spec.ts`** (new): the migration case, phase idiom borrowed
  from `control-database-solo-warm-start.spec.ts`, temp dir via `tempStorageDir` +
  Windows-tolerant `rmSync` retries.
- **`test/strand-membership-network-transactor-parity.spec.ts`** (new): the three parity cases.
- **`test/strand-spec-helpers.ts`**: `openRawStrand`/`openStrand` gained an optional
  `transactor: 'local' | 'network'` argument, default `'local'` producing the exact historical
  option shape (`mode: 'bootstrap'`) — no pre-existing suite changes behaviour.

## Validation run

- `packages/cadre-core: yarn typecheck` — clean (config includes `test/`).
- `packages/cadre-core: yarn vitest run` — **97 files, 1511 passed, 1 skipped** (the skip is
  pre-existing and platform-conditional: `key-store.spec.ts` 0o600 permissions case on Windows).
  `control-start-storage-op-budget.spec.ts` passed with budgets untouched.
- repo root: `yarn lint` — clean.
- Spec 1 ran standalone three times and inside the full suite: op counts identical everywhere, so
  no dual reporting needed; wall clock differences are in the table above.

## Known gaps / notes for the reviewer

- **Spec 1 measures an OPEN strand** (`Type: 'o'`, founder — Header row only). The closed-strand
  founder bootstrap (Member #1 + founding Manager) is not in the budget; the parity spec exercises
  closed-strand membership writes on the network transactor, so the retirement's correctness
  doesn't hang on this, but the committed launch budget is the open-strand figure.
- **The baseline (bootstrap) arm asserts only ops > 0** — deliberate: budgets on a mode being
  deleted would just have to be deleted with it. Its printed numbers are the "before" column above.
- **Wall-clock assertions are hang detectors only** (loose 2000 ms/op ceiling on the networked
  arm). The 250 ms a-priori threshold was applied to the measurement here, not encoded as an
  assertion — op counts are the committed regression guard, per the control budget spec's
  rationale.
- The insert-phase op counts (73 ops per single-row insert on either transactor) reflect the
  known optimystic read amplification tracked by
  `tickets/blocked/optimystic-block-read-amplification-on-control-start.md`; nothing new filed —
  the number is transactor-independent, which is exactly what this gate needed to show.
- The plugin's own strand node factory still passes no cluster policy — pre-existing, tracked as
  `backlog/debt-plugin-strand-node-omits-cluster-policy`, untouched here per the ticket.
