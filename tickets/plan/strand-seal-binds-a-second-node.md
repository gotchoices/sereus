----
description: When the last manager of a private strand freezes its membership, we have never checked that the other machines in that strand actually learn about it. Every test of the freeze runs on one machine. Design the cross-machine coverage, and find out what the second machine really does while the news is still in flight.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/quereus-plugin-sereus/src/strand-schema.ts, schemas/strand.qsql, packages/cadre-core/test/strand-seal.spec.ts, docs/architecture.md, docs/strands.md
difficulty: medium
----

# Sealing a strand is proven on one machine and unproven on two

## What shipped, and the hole in it

`sealStrand` (landed 2026-09-02, `complete/1-strand-seal-schema-and-writer`) lets the sole
manager of a closed strand delete its own `Manager` row, permanently freezing who belongs to
the strand. Nineteen cases in `packages/cadre-core/test/strand-seal.spec.ts` pin the rule set,
and `strand-membership-network-transactor-parity.spec.ts` runs one case (seal, then refuse
re-admission) over the network transactor.

**All of it is one database.** No test has ever sealed a strand on machine A and then asked
machine B what it thinks. The follow-on ticket said so plainly in its own known-gaps section:

> **Single-node only.** Nothing exercises seal propagation across nodes — the documented
> caveat that a node which has not yet received the seal still shows the manager's seat, so
> that one ex-manager's own key could still admit there.

`docs/architecture.md` carries the same caveat twice, as a ⚠️ **Still open**, and states that
this convergence class — seal propagation, the `MemberExists` partition hazard, and
`Revocation` tombstone replay — has **no test for any of them**.

Sealing is sold to members as a privacy guarantee: *nobody can ever be admitted again, so
nobody new will ever read this strand's history*. That promise is currently backed by
single-machine evidence only.

## What we do not actually know

These are questions, not claims. The plan pass answers them by running the thing.

1. **Does the seal arrive at all?** The seal is a `Manager` row **delete** plus a
   `Strand.Revocation` insert. Deletes and tombstones are the least-exercised replication
   shape in this system. If B never converges, "frozen" is a property of A's disk.
2. **Does an arrived seal bind B's schema?** `isStrandSealed` requires three things — closed
   header, empty `Manager`, at least one retired `Manager` stamp. B could converge on the
   delete but not the `Revocation` row, or the reverse. The first state is indistinguishable
   from *mid-founding* and, worse, the founding branch of `Manager.Authorized` re-seats a
   generation-0 manager only when no `Manager` stamp has ever been retired — so a B that
   holds the delete without the tombstone may believe the strand is **re-foundable**.
3. **How wide is the window, and what is reachable inside it?** The documented answer is "only
   the ex-manager's own key, no stranger gains anything." Confirm that by attempting it, and
   measure how long B stays admissible after A's seal commits.
4. **What happens to a mid-flight invitation?** `ConsumedInvite.NotSealed` kills a pre-seal
   invite locally. Across two machines, a joiner redeeming against B during the window is the
   case that matters, and it is the one that admits a *stranger*, not the ex-manager.

## Shape of the work

`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
already builds a real two-node strand over TCP and runs six cases against it — including
*a manager promoted on the second node runs manager actions from its OWN database*, which is
the closest existing relative of what is needed here. It is 1349 lines; decide during the plan
pass whether the seal cases join it or start a sibling file, and say which in the implement
ticket rather than leaving it to the implementer.

Sketch of the cases (refine against what the plan pass observes):

- **Founder seals, joiner converges.** Two-member closed strand. A seals. Wait for B. B's
  `isStrandSealed` is true, B's `Manager` table is empty, B holds the retired stamp.
- **B refuses admission on its own database after convergence.** Every admission path —
  `issueInvite`, `addMemberByManager`, `addManager` — rejected at B, with the schema doing the
  rejecting, not a TypeScript guard.
- **B refuses re-founding after convergence.** A lone survivor on B cannot re-seat a
  generation-0 manager. This is the irreversibility promise, restated on the machine that did
  not perform the seal.
- **The window is characterized, not assumed.** Whatever B permits before the seal lands gets
  written down as an observed fact — in the test as an explicit expectation if it is stable,
  in the docs if it is not.
- **A pre-seal invitation redeemed against B.** The one path where a stranger, not the
  ex-manager, could land inside the window.

## Interactions worth naming up front

- **Seal versus block-level replication.** `strand-membership-closed-strand-e2e` was the file
  blocked until 0.27.0 taught the solo-cohort commit path to mint a proof. A founder who seals
  while alone commits through that same path. Confirm the seal's blocks are certifiable, or the
  scenario fails for a reason that has nothing to do with sealing.
- **Do not weaken the guarantee to make a test pass.** If B turns out not to converge, that is
  a defect to file, not an assertion to relax. Same for a window wider than documented.
- **The other two hazards in this class stay out of scope.** `MemberExists` under partition and
  `Revocation` tombstone replay are named in `docs/architecture.md` beside this one. If the
  harness this pass builds makes either cheap to cover, park a `debt-` ticket in `backlog/`;
  do not grow this one.

## TODO

- [ ] Stand up the two-node seal case and record what B actually does — before writing any
      assertion.
- [ ] Answer questions 1-4 above with observations, in the plan output.
- [ ] Decide: extend `strand-membership-closed-strand-e2e` or open a sibling scenario file.
- [ ] Emit implement ticket(s) with an `## Edge cases & interactions` section.
- [ ] Any divergence from the documented caveat updates `docs/architecture.md` and
      `docs/strands.md` in the implement ticket's scope — the caveat is currently a claim
      nobody has measured.
