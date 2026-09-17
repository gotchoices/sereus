description: Three test files that track how much work starting a party costs were re-checked against the current version of the storage library and updated to the new, much lower numbers. A review pass confirmed the numbers and corrected several explanatory comments that no longer matched them.
files:
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts
  - packages/cadre-core/test/control-start-storage-op-budget.spec.ts
  - packages/cadre-core/src/control-database.ts
  - docs/testing.md
----

# Completed 2026-09-17 — budget re-baseline against optimystic 03ffadc4, reviewed

Three cost-budget specs in `cadre-core` measure how many times starting and founding a party reaches the storage backend, and how many times Optimystic's coordinator asks a block's cohort for its latest revision. Their anti-vacuity floors (each set at half the recorded measurement) tripped because `../optimystic` had made those paths cheaper. The work was blocked while that repo was being edited mid-measurement, unblocked when it held a quiet window at commit `03ffadc4`, and re-baselined there. This ticket covers the re-baseline (landed in `b6c9210`) and the review pass over it.

## What the re-baseline established

Upstream's change: a refresh of an unchanged collection now costs one request, and each block is fetched at most once per refresh. The effect here is that every *repeated* read of one block roughly halved, while blocks read exactly once did not move at all.

- Cohort consults: cold start 30 → 25, genesis 14 → 7, `foundStrand` 25 → 13 (control) and 25 → 21 (strand), idle reconcile 8 → 4. Per-call membership reads halved and are pinned exactly.
- Raw-storage operations, control start: cold 45 ops over 20 blocks, unchanged; warm restart 44/22 → 13/3.
- Raw-storage operations, solo strand: launch 78/17 unchanged, insert 80/3, select 2 → 0.

The select phase measuring zero could not carry a halved floor (`> 0` never passes), so it is now pinned exactly at zero via a new `expectPinnedAtZero`. No scenario was changed and no ceiling was widened to fit a measurement.

## Review findings

**Verified first, independently of the handoff.** Read the `b6c9210` diff, then re-derived every figure from a `--reporter=verbose` run's per-block breakdown rather than from the ticket's tables. Every budget constant matches what the counters actually report. `yarn lint` passes, `yarn workspace @serfab/cadre-core typecheck` passes, and the full `cadre-core` suite passes (134 files, 2184 tests; the single skip is `key-store.spec.ts`'s POSIX-permissions case, skipped on Windows by design and unrelated).

**Minor — fixed in this pass.** All six are accuracy defects in prose that documents the numbers; none changed an assertion's behaviour.

- The cold-start consult comment still said the three never-written tables are consulted "twice more each". At 25 consults they are consulted once more each — the old phrasing was correct at 30 and was not updated with the figure, so the comment no longer added up to the number it documents. Corrected, and the arithmetic (14 + 5 + 3×2 = 25) written out so the next reader can check it without a run. Its history clause also credited the whole 30 → 25 drop to the schema catalog, which accounts for only 2 of the 5; it now states both contributions.
- The insert-phase comment recorded the history as 75 → 80 and attributed the rise to `saveMaterializedBlock`. The real sequence is 75 (2026-08-17) → 86 (2026-09-14) → 80, so the figure actually *fell* at this upstream, and the per-method breakdown shows two steps above the baseline of 11 (`saveMaterializedBlock` at 17, `saveMetadata` at 14), not one accounting for exactly 5. Rewritten to the measured sequence with both excesses named and neither attributed to a cause it has not been traced to.
- That same comment previously disagreed with its own `ops` field — the prose said 86 while `ops` stayed at 75, so the anti-vacuity floor was computed off the older, lower number. The re-baseline silently resolved it; the comment now records that it happened, since the floor is derived from that field and a stale-low value weakens it invisibly.
- `control-start-storage-op-budget.spec.ts`'s anti-vacuity comment says "the warm start really did read the prior session's rows". Since this change that is the one thing the warm start provably does *not* do — the hydrate no longer touches a table's block, which is most of why 44 became 13. The assertions it labels still do useful work (they prove the node did not come up on an empty database), so the comment was corrected to say what they now prove and why they sit after the snapshot.
- `control-database.ts`'s `loadSchema` NOTE — which `docs/testing.md` nominates as the place these numbers live for someone debugging a slow launch — still said "a cold start now reaches the backend 169 times ... a warm restart 46". Cold has been 45 since schema batching landed (`d3f71a2`), and warm is now 13. Both corrected. The cold half was stale before this ticket; it is fixed here because this is the change that made the warm half stale too, and a reader lands on both at once.
- `control-database.ts`'s `queryRevokedStamps` NOTE said "2 consults per call (measured)". It is 1 per call at this upstream, which the consult spec now pins exactly. Corrected.
- `docs/testing.md` said all three budget specs are two-sided with a floor at half the measurement. That is no longer true of the solo strand's select phase, which has no floor a halved measurement could express. Reworded to name both exactly-pinned phases and why pinning is the stronger assertion where it applies.

**The handoff's open question — are the ceilings at roughly 20% over measured still right when the counts are small? — resolved as no change needed.** The specific worry raised was the idle reconcile pass at 4 measured against a ceiling of 5. Its two blocks (`CadrePeer`, `Revocation`) are both never-written, and the spec's own timing analysis establishes that missing-block consults do not vary with wall clock — only held-block consults do, via the 10 s read-repair window. So that ceiling cannot fire from a slow run; it can only fire when a read is genuinely added to the idle pass, which is precisely the regression the phase exists to catch. Firing then is the spec working, not flakiness. The phases that *do* contain held blocks (cold start, `foundStrand`) have no headroom that would survive crossing the read-repair window anyway, so widening them would buy nothing.

**`BASELINE_UPSTREAM` in a real failure message — checked, reads correctly.** It renders as `(measured 25 consults over 18 blocks and 2 commits on 2026-09-17 at optimystic 03ffadc4; ...)`. Hoisting the constant into the shared `storage-op-counter.ts` was considered and rejected: the three specs are deliberately re-baselineable one at a time, and a shared constant would force whoever re-measures one to move the others.

**Conditional concern — recorded as a tripwire, not a ticket.** The consult spec's floor is skipped entirely when a phase's recorded measurement is 0 (`if (budget.consults > 0)`), which is the same hole the strand spec just closed by pinning its zero phase. It is not a defect today: the one zero phase there (`RECONCILE_STRAND`) also carries a ceiling of 0, and a 0 ceiling pins it exactly. It only becomes one if a future re-baseline takes a phase to 0 while leaving a non-zero ceiling, at which point that phase would assert nothing in either direction. Parked as a `NOTE:` at the floor guard in `control-founding-consult-budget.spec.ts`, naming both remedies.

**Major findings: none.** Nothing warranted a new `fix/`, `plan/` or `backlog/` ticket. The change is confined to three test files' constants and comments; it adds one small function (`expectPinnedAtZero`, ten lines) and removes no assertion. The site-claim grep over the open board found `fix/warm-restart-into-declared-schema-diverges-from-declaration` already naming `control-start-storage-op-budget.spec.ts`; that ticket owns the warm path's *behaviour* and this change only re-pins its numbers, so no arm was appended and the two do not collide. Whoever takes it should re-measure rather than trust the 13/3 figure if it changes what the warm start does.

**Accepted tradeoffs: none encountered.** No finding's site carried a declining `NOTE:`.

**Source hygiene: checked, nothing to report.** The three specs are 706, 264 and 315 lines, all comment-dense by design — each budget constant carries its full measurement history, which is the point of the spec. `expectPinnedAtZero` is a single-purpose function with a name that states what it does. No file grew enough to raise a size concern.
