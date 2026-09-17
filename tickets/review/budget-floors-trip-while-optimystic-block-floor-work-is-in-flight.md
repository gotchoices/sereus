----
description: The three cost-budget specs whose anti-vacuity floors tripped have been re-measured against a quiet, committed optimystic and re-baselined to the new figures. The cost fell because that repo now fetches each block at most once per refresh; nothing in this repo was broken. Needs a review pass over the re-baseline, not a bug hunt.
prereq:
files:
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts
  - packages/cadre-core/test/control-start-storage-op-budget.spec.ts
difficulty: small
repro: n/a — the specs pass at the new baseline
----

# Unblocked 2026-09-17 — re-baselined against optimystic 03ffadc4

Was `blocked/budget-floors-trip-while-optimystic-block-floor-work-is-in-flight` (category (b):
the dependency under measurement was being edited while we measured). The block is lifted and
the re-baseline is **already applied in the working tree, uncommitted**. This ticket is in
`review/` rather than `fix/` because the code exists and wants an adversarial read, not a
reproduction.

## What unblocked it

`../optimystic` held a quiet window on 2026-09-17 with a clean tree. Its HEAD was `987c45cf`,
which is `03ffadc4` plus one commit touching `tickets/.garden-report.md` only — so the built
`dist` this repo measured is exactly `03ffadc4`. The relevant upstream commits:

- `0fc40ac5` / `94553aba` — `refreshed-collection-caches-a-block-older-than-its-log-entry`
- `61747f60` / `12eb8412` — `a-too-old-block-answer-is-retried-against-another-machine`
- `ebc5483c` / `03ffadc4` — `a-contended-pend-refusal-is-permanent-on-a-small-cohort`

Upstream's own account of the cost change, which matches every figure below: a refresh of an
**unchanged** collection now costs one request, and each block is fetched **at most once per
refresh**. A new per-block floor map and one extra retry round (only on a below-floor answer)
are also new, and neither shows up as a consult or a raw-storage operation here.

The suite's stale-build guard passed on every run; nothing in `../optimystic`, `../quereus` or
`../Fret` was built, edited or run.

## The measurements

Three consecutive runs of all three spec files produced **byte-identical counts** — same totals,
same per-block breakdowns, only freshly created tree-block ids differing. Outcome 2 of the old
ticket ("still floor-tripping, and the new numbers are stable"), as expected.

`control-founding-consult-budget.spec.ts` (consults; blocks and commits did not move):

| phase | 2026-09-15 | 03ffadc4 | new ceiling |
| --- | --- | --- | --- |
| cold start | 30 | **25** | 36 → 30 |
| genesis | 14 | **7** | 17 → 9 |
| foundStrand (control) | 25 | **13** | 30 → 16 |
| foundStrand (strand) | 25 | **21** | 30 → 26 |
| idle reconcile (control) | 8 | **4** | 10 → 5 |
| `queryRevokedStamps` per call | [2]×6 | **[1]×6** | pinned exactly |
| `queryCadrePeers` per call | [4]×6 | **[2]×6** | pinned exactly |
| marker test, before: per call | [2]×6 | **[1]×6** | pinned exactly |
| marker test, before: `authorizePeer` | 5 | **3** | pinned exactly |

Every repeated read of one block halved; blocks read once during a schema apply did not move.
The marker test's **"after" column is unchanged at zero**, so what that test proves — the
Revocation ledger marker removes the repeats entirely — survives with the same contrast.

`control-start-storage-op-budget.spec.ts`: cold **45 ops / 20 blocks, unchanged**; warm restart
**44/22 → 13/3**. The warm hydrate now reads only the catalog's own blocks four ways each plus
one `listBlockIds`; each table's block is left for the first read of that table, which this phase
does not perform.

`strand-solo-write-budget.spec.ts`: launch **78/17, unchanged**; insert **75 → 80** (still under
its 90 ceiling; the 5 extra are `saveMaterializedBlock`, unattributed, and the comment that
claimed 4 ops of headroom was already stale); select **2 → 0**.

## The one judgement call: a phase measured at zero

`SELECT`'s halved floor cannot work at 0 (`> 0` never passes). Rather than delete the guard or
widen the ceiling, `expectWithinBudget` now routes a zero-measured phase to `expectPinnedAtZero`,
which pins it **exactly** — the same instrument the consult spec already uses for its per-call
sequences, where the shape is the signal. Any backend operation reappearing on that path now
fails.

Outcome 3 of the old ticket warns that a zero can mean the counter went blind. It did not:
`launch` (78) and `insert` (80) are counted through the same `CountingRawStorage` instance, on
the same node, in the same run, immediately before those selects. Those two phases keep real
floors and carry the spec's anti-vacuity duty, which the `SELECT` doc comment had already
nominated them for before this happened.

No scenario was changed — the ticket's constraint that a scenario change is a different ticket
was respected, so the selects still select and the floors were not widened to fit.

## What is left

- **Review the diff**, in particular: are the new ceilings (≈20 % over measured, as before) the
  right headroom now that the counts are smaller in absolute terms? A 4→5 ceiling on the idle
  reconcile pass is one added read away from firing.
- `BASELINE_UPSTREAM` is a new constant in each of the three specs, carried into the failure
  messages so a future failure names the commit and not only the date. Check it reads well in a
  real failure message.
- `control-start-storage-op-budget.spec.ts` is also named by
  `fix/warm-restart-into-declared-schema-diverges-from-declaration`. That ticket owns the warm
  path's *behaviour*; this change only re-pins its numbers. Whoever takes it should re-measure
  rather than trust these figures if it changes what the warm start does.
- Lint passes on all three files; the three specs pass three runs in a row after the re-baseline.
- Nothing is committed. `git diff` is the whole change.
