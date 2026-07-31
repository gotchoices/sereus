description: A test that proves one machine physically holds a copy of another's data was run for the first time and its claim narrowed to what actually holds; this review re-ran it, confirmed the narrowing is load-bearing, corrected three comments that overstated what had been measured, and added the missing unit tests for the probe the whole proof rests on.
prereq:
files: packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/test/block-store-probe.spec.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, docs/cadre-consistency.md, tickets/backlog/debt-strand-no-backfill-of-pre-membership-blocks.md
difficulty: medium
----

Phases 4–5 of `debt-strand-replication-vs-visibility-proof`, reviewed and closed.

The implementation ran the previously-unexecuted physical-replication test, found that
pre-membership blocks are never copied to a joining node, narrowed the test's claim to
post-join blocks, and filed the gap as
`backlog/debt-strand-no-backfill-of-pre-membership-blocks`. That disposition is correct and
stands. This review reproduced every number it reported, verified the narrowing is real
rather than decorative, and closed the largest hole it declared.

## What ships

**`test/block-store-probe.spec.ts` (new, 22 tests)** — the review's main addition. The probe
module is the only thing standing between "the joiner physically holds these blocks" and a
vacuous pass, and it had no unit tests at all; its one scenario caller exercised a single
shape (full coverage, narrowed, two live in-memory stores). Now covered:
`readBlockIndex`'s enumeration guard and its pending-only exclusion; all four
`captureRawStorage` guards (per-scope memoization, control-scope refusal, unknown-strand
naming, shared-singleton scope collapse); every `compareBlockCoverage` gap kind — including
`behind` and `metadataOnly`, which had never been observed non-empty anywhere; both content
shapes (`getMaterializedBlock` and a promoted transaction); one-directionality; the
enumeration guard propagating rather than reporting coverage; `newOrAdvancedSince` at, above
and below baseline; and the **unnarrowed two-argument form**, which had no live caller.

**Three comment corrections**, each because the text claimed more than had been measured:
- The fourth test's `joinerDb` prohibition read "no read of any kind may be issued against
  it" — but `bringUpClosedStrand` reads `joinerDb` in its bootstrap-row gate. The rule that
  actually holds is *ordering*: no `joinerDb` read at or after the founder-only writes. The
  comment now says that, and records that those bring-up reads demonstrably backfill
  nothing (the pre-dial blocks stay absent all run).
- The "two node-local root blocks carry a different id on each node" claim was inference
  from diagnostic output. Traced: `BlockId` is a fresh 256-bit random value
  (`db-core/src/blocks/structs.ts`), minted by `generateId()` in
  `transactor/transactor-source.ts` whenever no id is supplied — so each node's locally
  created collection root differs by construction. Cited at the site.
- The probe module's confound warning ("a read through a node can pull a block into its
  store") is a reading of the code that this suite has never demonstrated. Labelled as such.

**Backlog-ticket correction** — it said "two further blocks that also never match are
node-local roots", implying 11 non-arriving blocks against a measured 9. The two roots are
*among* the nine; the real gap is seven. Fixed.

**One tripwire recorded as a `NOTE:`** in the fourth test (see below).

## Review findings

**Checked:** the full implement diff read before the handoff summary; `block-store-probe.ts`
line by line; the fourth test and the file header it rewrote; the `rbac-signed-write.ts`
comment and both factual claims in it; `docs/cadre-consistency.md`'s new paragraph; the new
backlog ticket; `docs/architecture.md` and `docs/STATUS.md` grepped for replication claims
the measurement would contradict (none found — both already describe the control path's
re-replication queue as control-only, consistent with the new finding).

**Fixed in this pass (minor):**
- No unit coverage for `block-store-probe.ts`. Added 22 tests (above). This was the
  handoff's own first-listed gap and was bounded work, so it was closed rather than filed.
- Three overstated comments and one wrong count in the backlog ticket (above).

**Verified rather than assumed:**
- All four closed-strand tests pass. The measurement reproduced *exactly* on a second run:
  `founder holds 27 committed blocks, 13 of them authored or advanced since the dial;
  joiner's own store covered those in 1ms (joiner store holds 23)`.
- **The narrowing is load-bearing.** Dropping the `include` option makes the test fail in
  15 s naming exactly 9 absent block ids, two of them the deterministically-named
  `default/Member/index/_uniq_1` and `default/Manager/index/_uniq_2`. The remaining seven
  are opaque random ids. This is the property the ticket deliberately does not claim, and
  it fails loudly, naming names, as designed.
- The `rbac-signed-write.ts` claim that the test runs in bootstrap mode: `selectStrandMode`
  is `explicitMode ?? (hasOtherPeers ? 'networked' : 'bootstrap')` (`strand-cohort.ts:76`),
  called at `cadre-node.ts:3262`. Log line prints `alice=bootstrap bob=bootstrap`. Correct,
  and correctly logged rather than asserted.

**Filed as new tickets: none.** Nothing found rose to major. The one genuine defect the
implementation surfaced — no backfill to a late-joining peer — was already filed by it as
`backlog/debt-strand-no-backfill-of-pre-membership-blocks`, which is correctly scoped and
was corrected rather than duplicated.

**Recorded as a tripwire, not a ticket:** coverage has completed on the first poll every
run, so the 15 s gate has never been exercised as a wait — a regression making replication
*slow* rather than absent would pass indistinguishably. Fine today, because replication is
part of the commit; it becomes work only if strand replication grows an asynchronous path,
at which point the test needs a latency bound rather than eventual coverage. Parked as a
`NOTE:` in the fourth test's header comment, next to the measurement it qualifies.

**Left alone, deliberately:** the `>= 6` anti-vacuity floor is still calibrated from
single-machine, in-memory runs (observed 13). Two runs now agree exactly, so there is no
evidence of variance to act on; if it ever flakes, the fix is to lower the floor, which the
existing comment already says. The rest of the integration suite was not run — the harness
change is additive (one optional parameter, one new export) and the two consuming files
plus the new unit spec all pass.

## Validation

| command | result |
| --- | --- |
| `yarn vitest run test/block-store-probe.spec.ts src/scenarios/strand-membership-closed-strand-e2e.integration.ts` | **26 passed** (22 new unit + 4 integration) |
| `yarn vitest run src/scenarios/rbac-signed-write.integration.ts` | **1 passed** |
| `yarn typecheck` (in `packages/integration-tests`) | exit 0 |
| `yarn lint` (repo root) | exit 0 |
| adversarial: `include` dropped from the coverage call | fails as intended, naming 9 blocks |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
