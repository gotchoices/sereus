----
description: Added the three tests that prove a lone device works just as well on the normal shared storage path as on the private one we plan to delete — same answers, old data still readable, and no slowdown. All three passed, so the deletion can go ahead.
prereq:
files: packages/cadre-core/test/storage-op-counter.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, packages/cadre-core/test/strand-transactor-handover.spec.ts, packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts, packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/control-start-storage-op-budget.spec.ts
----

# Evidence gate: a solo strand on the network transactor — implemented and reviewed

First of three tickets retiring the strand `bootstrap` (local-transactor) mode. **No production
code changed** — this ticket adds the evidence tests only (confirmed at review: every file in the
diff is under `packages/cadre-core/test/`).

**`retire-strand-mode-in-cadre-core` is clear to proceed.** None of the plan's exit clauses
tripped, and the review re-measured every number below independently rather than taking the
implement handoff's word for it.

## The three facts, with numbers

Linked substrate the numbers came from: `@optimystic/db-p2p` **0.22.0**, linked workspace
`../optimystic` at commit **6cc08ac** (all `@optimystic/*` packages resolve to that workspace via
root `package.json` resolutions).

### Fact 1 — Speed: proven (`strand-solo-write-budget.spec.ts`)

Solo `CadreNode`, open strand, 5 single-row inserts + 5 full-table selects over
`MemoryRawStorage`. Op counts were **byte-identical** across the implementer's three standalone
runs, the full parallel suite run, and both of the review's independent re-runs; wall clock varies
with load.

| arm | phase | ops | distinct blocks | ms (review re-run) |
|---|---|---|---|---|
| bootstrap (baseline, dies with the mode) | launch | 1592 | 17 | 140 |
| bootstrap | insert ×5 | 364 | 3 | 12 |
| bootstrap | select ×5 | 230 | 2 | 10 |
| **networked (survives)** | launch | **1613** | **17** | 84 |
| **networked** | insert ×5 | **366** | **3** | 16 |
| **networked** | select ×5 | **230** | **2** | 10 |

Against the a-priori thresholds: the networked arm costs **1.005×** the baseline's insert
operations (366 vs 364; threshold was 3×), and a solo networked insert averages **~3 ms**
standalone (threshold was 250 ms). The entire launch delta is +21 `getMetadata` calls; selects are
byte-identical between arms. The networked arm carries committed two-sided budgets (ceiling +
anti-vacuity floor, measured 2026-08-13); the baseline arm is print-only, labelled for deletion by
`retire-strand-mode-in-cadre-core`.

The review checked the *attribution* of that +21 delta, because the networked arm also arms
`StrandBackfill` (gated on `mode === 'networked'` at `strand-instance-manager.ts:375`) and the
baseline arm does not. `StrandBackfill.start()` (`strand-backfill.ts:171-182`) only adds a
`connection:open` listener and walks already-open connections — zero raw-storage calls with no
peers connected. So the delta is the transactor path, as the handoff claimed.

### Fact 2 — Existing data stays readable: proven (`strand-transactor-handover.spec.ts`)

Phase 1 writes 3 rows through the plugin's `transactor: 'local'` into a `FileRawStorage` under a
temp dir, then shuts down. Phase 2 opens a **fresh** `FileRawStorage` over the same directory
(only bytes cross the boundary) with the transactor defaulted (network) and asserts: catalog
**hydrated** rather than re-created (`hydrated.tables > 0`), all 3 local-era rows selectable, a
new network-transactor insert commits, final select sees both generations. Phase 1 deliberately
uses `transactor` (the knob that survives ticket three), not `mode: 'bootstrap'`, so this spec
needs no edit when the mode is dropped.

### Fact 3 — Constraints still bite: proven (`strand-membership-network-transactor-parity.spec.ts`)

Three cases through `openStrand('c', 'network')`, each mirroring a named local-transactor test in
`strand-membership-manager-rotation.spec.ts` (which keeps running unchanged — the review confirmed
both mirrored test names exist there):

- unauthorized `Manager` delete → rejected, error pins `/Authorized/` (deferred, on delete);
- sole manager resigning → rejected, error pins `/MinOneManager/` (deferred post-image floor);
- authorized add-then-resign hand-off → accepted, successor alone remains.

So the deferred, subquery-bearing CHECK enforcement genuinely lives above the transactor, as the
code read suggested — now proven on the path that becomes production-only. Note this spec also
runs the *closed-strand founder bootstrap* (`bootstrapFounderMembership`) on the network
transactor, since `openStrand` bootstraps before the cases run.

## What changed

- **`test/storage-op-counter.ts`** (new): `StorageOpCounter`, `CountingRawStorage`,
  `formatBreakdown`/`formatSnapshot` hoisted out of `control-start-storage-op-budget.spec.ts`.
  One deliberate non-verbatim change: `formatSnapshot` takes the greppable prefix as a parameter
  (it was hardcoded `[storage-op-budget]`; the new spec needs `[strand-write-budget]`). The
  control spec re-ran with identical figures (cold 1541/21, warm 315/22) and untouched budgets —
  re-confirmed at review.
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

## Review findings

Reviewed the implement diff first, then the code it exercises (`compose-strand.ts` transactor
resolution, `strand-instance-manager.ts` storage/backfill wiring, `strand-backfill.ts`,
`control-db-node-helpers.ts`) and the mirrored membership rotation spec.

**Evidence re-verified, not taken on trust.** Every figure in the handoff reproduced
byte-identically on an independent run (bootstrap 1592/17, 364/3, 230/2; networked 1613/17,
366/3, 230/2; control-budget cold 1541/21, warm 315/22). The `+21 getMetadata` attribution was
the one claim that could plausibly have been wrong — the networked arm also arms `StrandBackfill`
— and it checks out: backfill issues no storage calls with no peers connected.

**Fixed in this pass (minor).** The budget spec's storage provider created a *new* `IRawStorage`
per call. `CadreNode` asks once per id today, so behaviour was correct, but the sibling
`fileStorageProvider` in `control-db-node-helpers.ts:151-158` memoises for exactly this hazard and
documents why; the new provider diverged from that idiom silently. Memoised it
(`strand-solo-write-budget.spec.ts`), and all six op counts came back identical, confirming the
change is inert today.

**Filed as an arm on an existing ticket (not a new ticket).** No spec can assert *which*
transactor it actually ran on — `composeStrand` resolves the transactor into a local variable and
only logs it; `SereusPluginResult` does not report it. Three specs exist specifically to prove
behaviour on a named arm, and `strand-transactor-handover.spec.ts` is the retirement's data-safety
evidence; if the option is ever misread, all three still pass while proving nothing. Risk is low
today (`network` is the default at both the Sereus and Optimystic layers, so only an active
regression could land the wrong arm), but the ticket that rewrites that very option is
`implement/13-drop-strand-mode-option-from-sql-plugin` — which already lists `types.ts` and
`compose-strand.ts` in its `files:`. Appended the arm there (report the resolved transactor on
`SereusPluginResult`; assert it in the three specs) rather than filing a point ticket, and left
`NOTE:` markers at `strand-spec-helpers.ts`'s transactor branch and in the handover spec's header
pointing at it.

**Tripwires: none.** The transactor-observability concern above is a present hole in evidence
specs, not a conditional "only if X later", so it went to a ticket arm rather than being demoted
to a note-only tripwire.

**Accepted tradeoffs: none encountered.** No `NOTE:` accepted-tradeoff markers exist at any site
this diff touches, so nothing was already-decided that this review had to respect.

**Docs: correctly untouched, and the deferral is owned.** The diff changes tests only, so no
document describes anything that is now false. `docs/architecture.md:498-509` (the "Strand Mode:
Bootstrap vs Networked" section) and the `docs/STATUS.md` warm-start entry still describe the mode
accurately *because it still exists*; rewriting them and cataloguing these three new specs is
explicitly assigned to `retire-strand-mode-in-cadre-core`, and its TODO already carries both
items. Verified those line references still resolve so that ticket's citations remain valid.

**Source hygiene: acceptable.** New files are 91–273 lines, each with one purpose; functions are
short (`measureArm` is the longest at ~65 lines and is a linear four-phase measurement, which
reads better whole than split). Comment density is high but matches the established idiom of
`control-start-storage-op-budget.spec.ts`, where the provenance of every committed number is the
point. `storage-op-counter.ts` is a faithful hoist — the control spec's unchanged budgets prove it.

**Test coverage: honest about its own edges.** The budget spec measures an *open* strand
(`Type: 'o'`, Header row only), so the committed launch budget is the open-strand figure. That is
stated in the spec and is not a correctness gap: the closed-strand founder bootstrap runs on the
network transactor in the parity spec and in `control-database-solo-warm-start.spec.ts`'s
closed-strand case. The baseline arm asserts only `ops > 0` — deliberate, since budgets on a mode
being deleted would be deleted with it. Wall-clock assertions are loose hang detectors (2000 ms/op);
the a-priori 250 ms threshold was applied to the measurement, not encoded, matching the control
budget spec's rationale that op counts are the durable regression guard.

**Known non-findings.** The insert-phase op counts (73 ops per single-row insert on *either*
transactor) reflect the optimystic read amplification tracked by
`tickets/blocked/optimystic-block-read-amplification-on-control-start.md` — transactor-independent,
which is exactly what this gate needed to show; nothing new filed. The plugin's strand node factory
still passes no cluster policy — pre-existing, tracked as
`backlog/debt-plugin-strand-node-omits-cluster-policy`, untouched.

## Validation (review run, after the inline fix)

- `packages/cadre-core: yarn typecheck` — clean (config includes `test/`).
- `packages/cadre-core: yarn vitest run` — **97 files, 1511 passed, 1 skipped**. The skip is
  pre-existing and platform-conditional: `key-store.spec.ts`'s 0o600 permissions case on Windows.
- `packages/cadre-core:` the four affected specs re-run standalone after the fix — 7 passed, op
  counts unchanged.
- repo root: `yarn lint` — clean.
- No `.pre-existing-error.md` written: nothing failed. The two `control-revocation-*` specs listed
  in `tickets/.pre-existing-known.md` passed in this run; not re-triaged here, as ticket
  `10-control-revocation-reissue-test-fixes` owns them.
