description: Added and reviewed an end-to-end test proving a second computer can genuinely join a private group using its own local database, and turned previously-optional cross-computer checks into required ones.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/architecture.md, docs/STATUS.md
difficulty: medium
----

## What landed

Test-only + docs. No production code touched — `cadre-core`'s writers, `schemas/strand.qsql`,
and the test harness are all unchanged.

**Phase 1 — cross-node replication observations became gates.** Two places used to *observe*
replication inside a `try {} catch {}`, set a boolean, log it, and never assert:

- `bringUpClosedStrand` — the founder's `Header`/`Member`/`Manager` bootstrap rows becoming
  visible on the joiner. `syncObserved` is gone from `ClosedStrandFixture`.
- the removal test — M's two `MemberPeer` rows becoming visible on the joiner.
  `peersVisibleOnJoiner` and the skip branch inside `requireJoinerAgrees` are gone.

Both are now plain `await waitUntil(...)` that throw on timeout.

**Phase 2 — a third test**, `a joining node runs the join against its OWN database and both
nodes converge`, with its own bring-up label `joiner-db`: founder issues an invite → gate it
visible on the joiner → **`consumeInvite(joinerDb, …)`** → assert `Member` + `ConsumedInvite`
locally → **gate both visible from the founder** (the headline) → `registerMemberPeer(joinerDb, …)`
gated back → a signed `App.Items` insert on `joinerDb` gated back → LAST, a wrong-invite-key
`consumeInvite` on `joinerDb` that must reject.

**Review pass** additionally: hoisted the eight duplicated gate budgets into one `GATE`
constant, corrected two over-claiming comment/doc passages about which deferred constraints
actually read across the network, restored two rewritten historical figures in `docs/STATUS.md`,
and recorded one diagnostic tripwire. Details below.

## Review findings

### Checked

- **The implement diff first, before the handoff summary** (`git show e5451e6`), then the whole
  current file, `schemas/strand.qsql`'s `Member` / `ConsumedInvite` / `MemberPeer` / `Invite`
  constraint blocks, the `waitUntil` harness implementation, the vitest config, and every doc
  passage referencing this scenario (`docs/architecture.md:630-634`, `docs/STATUS.md` ×3 —
  those are the only references repo-wide).
- **Lint** — `yarn lint` at repo root, **exit 0, 0 errors**.
- **Typecheck** — `yarn typecheck` in `packages/integration-tests`, **exit 0**, before and
  after the review edits.
- **Tests** — `yarn test src/scenarios/strand-membership-closed-strand-e2e.integration.ts`,
  **3/3 green on every run**: 4 unloaded runs, plus a run under 12 CPU-burner processes on
  24 cores, plus a run under **48 burners (2× oversubscription)**, plus a final run after the
  review edits. Per-test wall clock 0.8–1.5 s unloaded, 1.5–2.5 s under load. No gate ever came
  near its 15 s budget — the widest observed use was ~2.5 s of a 15 s allowance.
- **Is the headline gate falsifiable?** Yes. The two nodes are separate `CadreNode`s with their
  own `MemoryRawStorage`, and bring-up asserts the joiner holds 0 rows *before* the strand dial,
  so the founder-side reads in step 3 genuinely cross the network rather than hitting a shared
  store.
- **Resource cleanup** — every test body is `try { … } finally { await stopBoth(...) }`, and
  `bringUpClosedStrand` stops both nodes on any internal failure before rethrowing. No leak path
  found.

### Found and fixed in this pass (minor)

- **Two comment blocks over-claimed what the third test proves across the network.** The test's
  own header said "Every write below is issued against `joinerDb`" — false, the two `issueInvite`
  calls run on `founderDb` — and listed `Member.Authorized`'s invite branch,
  `ConsumedInvite.NotCancelled`, and `MemberPeer.MemberExists` as resolving "against rows the
  FOUNDER authored". Reading `schemas/strand.qsql` shows otherwise: `Member.Authorized`'s invite
  branch wants a same-transaction `ConsumedInvite` plus that InviteKey's *absence* from
  `committed.ConsumedInvite`; `NotCancelled` scans an empty `CancelledInvite`; and
  `MemberPeer.MemberExists` reads the `Member` row the joiner itself authored one step earlier.
  The one genuine cross-node read is `ConsumedInvite`'s `InviteExists`/`ValidUsage`/`NotExpired`
  against the founder-authored `Strand.Invite`. Corrected in the test comment, in the file header,
  and in the matching sentence in `docs/architecture.md`. The test's *behaviour* is unchanged and
  still valuable — the claim about it was simply wider than the schema supports.
- **`docs/STATUS.md` rewrote two dated historical figures.** Both `1/1 pass` → `3/3 pass` edits
  sit inside blocks explicitly dated **2026-06-29** and describing a verification run performed
  then, when the file had exactly one test. Restored `1/1` as the historical figure in both, each
  now carrying the current `3/3` alongside it so neither reads stale.
- **DRY: `{ timeoutMs: 15_000, intervalMs: 250 }` was repeated at eight call sites.** Hoisted to
  a single documented `GATE` constant spread into each `waitUntil`, so a future CI-driven budget
  bump is one edit rather than eight.

### Found and filed as a new ticket (major)

- **Manager-authorized writers have never run from the second node.** `backlog/debt-manager-actions-from-second-node-coverage`.
  The implementer flagged this as out of scope and correctly declined to fix it inline; on review it
  is more than a nice-to-have. Every manager action in the suite runs on the founder's DB, where the
  manager list is local. All four manager branches (`Invite.InviteValid`, `Manager.Authorized`,
  `Member.Authorized`'s manager-remove, `MemberPeer.Authorized`'s manager branch) resolve their
  authorizer from the **pre-transaction snapshot** `committed.Manager` — a read shape with **zero**
  coverage from the second node, and one the new joiner-authored test does not touch (its only true
  cross-node read is of `Strand.Invite`). If that snapshot resolves stale or empty from a second
  machine, a legitimate manager is refused, which presents as an authorization bug.

### Recorded as a tripwire, not a ticket

- **A gate whose read *errors* is indistinguishable from rows that never arrived.** `waitUntil`
  catches a throwing condition and retries, so a persistently-erroring read reports the same plain
  15 s timeout as genuine non-convergence. Fine today (no gate has ever timed out), but it would
  send the first person to hit a timeout down the wrong path. Parked as a `NOTE:` in the test file
  header next to the "gated everywhere" paragraph, pointing at the harness's
  `Wait condition threw: …` debug line. Related failure-shape note from the implementer — a
  point-lookup miss inside a gate surfaces as a timeout rather than a wrong answer — is covered by
  the same `NOTE`.

### Checked and deliberately left alone

- **Flake risk from hardening the gates** (the implementer's top-listed worry). Probed directly
  rather than taken on faith: six additional runs including one at 2× CPU oversubscription, where
  the test bodies still finished in ~4 s total. The 15 s budget holds a ~6× margin under the
  worst load I could apply. One collection-phase failure did occur under 48 burners
  (`Tests no tests` — vitest's own transform/import starved, 188 s of transform time), which is
  the runner starving, not this file; an immediate rerun under identical load passed 3/3.
- **Visibility vs physical replication.** Correctly and prominently documented in the file header
  and `docs/architecture.md`; already parked as `backlog/debt-strand-replication-vs-visibility-proof`.
  No new ticket — the existing one covers it.
- **The sApp write proves convergence, not a second authorization check.** Accurate as the
  implementer stated it, and the test comment says so at the call site. Nothing to change.
- **Concurrent two-node writes, and the JavaScript "still present after delete" re-check behind
  `RowIsGone`.** Both explicitly scoped out by the plan and both already documented in the file
  header, `docs/architecture.md`, and a `NOTE:` in `strand-membership-writer.ts`. No new ticket.
- **Full-PK where-equality presence assertions** in the new test (`Strand.Invite where Key = ?`,
  etc.). Permitted by this file's own lookup-shape rule — a point-lookup miss on a *presence*
  assertion fails the test rather than passing it. Correct as written.
- **Six pre-existing lint warnings** (0 errors) in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts` — unused
  `eslint-disable` directives belonging to the in-flight `control-delete-while-alone-tombstone`
  work. Not this ticket's file; left untouched. Lint exits 0, so no `.pre-existing-error.md` was
  written.
- **Only this file was re-run, not the full integration suite.** Same call as the implementer's,
  for the same reason: the diff is one test file plus two docs files, no production code, and
  `fileParallelism: false` makes the full suite long. Nothing outside this file can be affected.
  Noted rather than silently skipped.

### Environment note (not a finding)

The stale-build guard blocked the first test attempt: `@quereus/quereus`'s `dist` predated its
`src`. Resolved by running `yarn workspace @quereus/quereus build` in `../quereus` (exit 0).
That workspace has unrelated uncommitted edits from other in-flight work; they were left exactly
as found, and nothing in this repo was reverted.

## Categories with nothing to report

- **Correctness defects in the new test** — none. Step ordering respects the file's rejection
  floor (accepted writes first, the single rejected write last, no count or enumeration assertion
  after it), the three bring-up labels keep party ids / strand ids / member keys disjoint, and
  every assertion is reachable and meaningful.
- **Error handling / resource cleanup** — none. Covered under "Checked" above.
- **Type safety** — none. No `any`, no unsound casts; `yarn typecheck` clean. The `!` assertions
  on `libp2pNode` and `database` match the established pattern in the sibling scenarios.
- **Source hygiene beyond the DRY fix** — the file is 730 lines with a 90-line header, which is
  large but earns it: the header encodes non-obvious house rules (rejection floor, lookup shape,
  visibility caveat) that a reader must have before extending. Function decomposition is sound —
  `bringUpClosedStrand`, `stopBoth`, `memberPeerStamp`, `revocationExists`, `memberKeys` are each
  short and single-purpose. Not filing anything; a fourth test would be the point to split.
