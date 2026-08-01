description: Add one automated test proving that a group manager can invite, promote, remove members and clean up device records from a second computer, not only from the computer that created the group.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-membership-writer.ts, schemas/strand.qsql, docs/strands.md
difficulty: medium
----

## What this adds

One new `it(...)` in the existing two-node closed-strand scenario file, plus a small
`managerKeys()` scan helper beside the existing `memberKeys()` helper, plus two lines of
header-comment maintenance in that file.

A private group ("closed strand") has **managers**: members allowed to invite people,
admit people directly, promote another member to manager, remove a member, and clear a
departed member's leftover device records. Today every automated exercise of those
actions runs on the *founder's* node — the machine that created the group and already
holds every group record locally. The new test runs them from the **second node**, whose
database must resolve the group's manager list over the network.

## Why this read shape has no coverage today

The rules deciding whether a manager action is allowed are deferred (subquery-bearing)
CHECK constraints in `schemas/strand.qsql`. They come in two flavours, and the new test
must drive both from the second node:

| Writer | Constraint branch | Reads |
| --- | --- | --- |
| `issueInvite` | `Invite.InviteValid` | **live** `Manager` |
| `addManager` | `Manager.Authorized` promotion branch | **live** `Manager` (strict `Generation` ordering excludes a same-transaction authorizer) |
| `addMemberByManager` | `Member.Authorized` direct-admit branch | `committed.Manager` (pre-transaction snapshot) |
| `revokeMember` | `Member.Authorized` manager-remove branch | `committed.Manager` |
| `removeMemberPeer` (manager arm) | `MemberPeer.Authorized` manager branch | `committed.Manager` |

The existing joiner-authored join test (`a joining node runs the join against its OWN
database and both nodes converge`) proves exactly one genuine cross-node deferred read:
`ConsumedInvite`'s `InviteExists` / `ValidUsage` / `NotExpired`, all reading the
founder-authored `Strand.Invite` row. Every other constraint on that path resolves
against a row the joiner just wrote itself or against an empty table. "A deferred check
resolves the manager list — live or pre-transaction — from the second node's database"
therefore has zero coverage. If it resolves stale, empty, or unreliably, a manager on a
second machine is told it has no authority, which surfaces as a permissions bug rather
than a networking one.

This ticket does not claim a defect exists. It makes the answer observable.

## The test, step by step

New test in `strand-membership-closed-strand-e2e.integration.ts`, its own bring-up via
`bringUpClosedStrand('manager-2nd')` so party ids, strand ids and member keys stay
disjoint from the other four tests. Test timeout `90_000` (the file's others are
`60_000`; this one carries roughly twice as many convergence gates — bring-up still
dominates, so this is headroom, not an expectation of slowness).

Cast, all `freshKeyPair()` except the founder:

- **F** — the founder (`founderKeyPair`), `Manager` generation 0, seated by bring-up.
- **M** — the second node's member, promoted to manager. Generation 1. Every step from
  step 5 on is authored by M **against `joinerDb`**.
- **Z** — admitted on the founder by consuming an invite M issued. Proves M's invite is
  not merely a visible row but a usable one.
- **X** — admitted by M and then promoted by M to manager. Generation 2.
- **Y** — admitted by M, registers a device record, then is revoked by M and has its
  orphan device record cleared by M.

Steps:

1. **Seat M as a member of the second node.** F `issueInvite`s on `founderDb`; gate the
   `Strand.Invite` row visible on `joinerDb`; `consumeInvite(joinerDb, …)` for M's key.
   (This half is already proven by the joiner-authored join test — it is setup here, not
   the claim.)
2. **Gate M's `Member` row visible on the founder** (JS scan via `memberKeys`), so step 3
   is not racing M's admission.
3. **F promotes M**: `addManager(founderDb, { byManagerKeyPair: founderKeyPair,
   newManagerKey: M })`. Assert M's `Manager` row present on the founder.
4. **THE ENABLING GATE — M's `Manager` row becomes visible on `joinerDb`.** Everything
   after this depends on the second node resolving that row. Use the new
   `managerKeys(joinerDb)` scan helper, not a `where MemberKey = ?` equality (see *Lookup
   shape* below).
5. **`issueInvite(joinerDb, { managerKeyPair: M })`** — `Invite.InviteValid` reads the
   live `Manager` table from the second node. Gate the invite row visible on the founder,
   then **consume it on the founder** to admit Z, so the joiner-authored invite is proven
   usable rather than merely present.
6. **`addMemberByManager(joinerDb, { managerKeyPair: M, memberKey: X })`** and the same
   for **Y** — `Member.Authorized`'s direct-admit branch, reading `committed.Manager`
   from the second node. Gate both member keys visible on the founder.
7. **`addManager(joinerDb, { byManagerKeyPair: M, newManagerKey: X })`** —
   `Manager.Authorized`'s promotion branch, live `Manager` read; the writer's own
   `managerRow(joinerDb, M)` scan must find M at generation 1 so X is seated at 2. Gate
   X's `Manager` row visible on the founder.
8. **Y registers a device record on `joinerDb`**: `registerMemberPeer(joinerDb, {
   memberKeyPair: Y, peerId: 'peer-manager-2nd-y' })` (self-signed; the test holds Y's
   private key). A synthetic peer id is correct here — Y is not a real node. Gate the row
   visible on the founder via `listMemberPeers(founderDb, Y)`.
9. **`revokeMember(joinerDb, { managerKeyPair: M, memberKey: Y })`** —
   `Member.Authorized`'s manager-remove branch, `committed.Manager` read. Y holds no
   `Manager` row so `NotAManager` passes; F/M/X/Z remain so `MinOneMember` passes. Assert
   Y absent locally by JS scan, then gate Y absent on the founder by JS scan.
10. **`removeMemberPeer(joinerDb, { managerKeyPair: M, memberKey: Y, peerId })`** —
    `MemberPeer.Authorized`'s manager branch, `committed.Manager` read; this is the
    orphan-cleanup loop the manager branch exists for (device records do not cascade on
    revocation). Assert `listMemberPeers(joinerDb, Y)` is `[]`, then gate the same on the
    founder.
11. **LAST, the single rejected write** — `issueInvite(joinerDb, { managerKeyPair:
    freshKeyPair() })` rejects. A non-manager must be refused *on the second node too*;
    without it the test could pass by the joiner accepting everything indiscriminately.
    Per the file's rejection floor this is `rejects.toThrow()` only, no post-state
    assertion, and nothing may follow it.

## House rules this file already enforces (do not relitigate)

- **Every accepted write first, the single rejected write last.** No count or enumeration
  assertion may follow a rejected write.
- **Rejection floor**: `rejects.toThrow()` is the assertion; rollback of a rejected write
  is not asserted.
- **Lookup shape**: an assertion or gate that a row is GONE must never be a full-primary-key
  where-equality — the optimystic module serves that as a point lookup that can miss on a
  networked strand and would report "gone" for a row that is still there. `Strand.Manager`'s
  primary key is the single `MemberKey` column, so *any* equality on it is a full-PK
  predicate. Presence assertions may use an equality (a miss fails the test rather than
  passing it) — but inside a `waitUntil` a miss becomes an indistinguishable timeout, so
  **use scans for the gates**, not just for the absence checks.
- **Every cross-node gate throws on timeout**, on the shared `GATE` budget. No skip
  branches, no best-effort paths.
- **`waitUntil` swallows a throwing condition**, so a gate whose read errors every attempt
  reports a plain timeout. Nothing new needed here; just do not be surprised by it when
  debugging.

## Edge cases & interactions

- **Absence gates can pass vacuously.** The founder does not see Y at all until Y's
  admission converges. Gating "founder no longer sees Y" without first gating "founder
  sees Y" would pass instantly against a founder that never received the row. Same trap
  for Y's device record. Presence gate first, mutate, then absence gate — steps 6/8 exist
  partly for this.
- **`committed.*` vs. a plain `select`.** Step 4 gates on a `select` from `joinerDb`
  seeing M's `Manager` row; steps 6/9/10 depend on the *pre-transaction snapshot*
  (`committed.Manager`) inside a later transaction on that same database seeing it too.
  These are different reads. The test asserts they agree — if they do not, that is the
  finding this ticket exists to surface, not something to work around.
- **Generation ordering.** M must be at generation 1 (F is 0) for `addManager`'s writer
  to seat X at 2. If `managerRow(joinerDb, M)` returns nothing, the writer silently falls
  back to generation 1 and lets the schema reject — so a failure at step 7 may mean "the
  joiner could not see M's manager row", not "the promotion rule is wrong". Worth an
  explicit assertion on M's visible `Generation` at step 4 so the two are distinguishable.
- **`revokeMember` is a quiet no-op on an absent row.** If the joiner cannot see Y's
  `Member` row, `revokeMember` logs and returns without throwing — the test would pass a
  step that never ran. The step-6 presence gate plus a local pre-assertion that Y *is*
  visible on `joinerDb` closes that. Same shape for `removeMemberPeer` (absent → no-op).
- **`addMemberByManager` is not insert-if-absent** — a repeat call collides on the
  `Member` primary key. Each key is admitted exactly once.
- **`MinOneMember` / `MinOneManager`.** Revoking Y leaves F, M, X, Z as members and F, M,
  X as managers; both floors hold with room to spare.
- **Revocation filer authority.** `revokeMember` and `removeMemberPeer` each file a
  `Strand.Revocation` tombstone whose `Authorized` check reads `committed.Member` for the
  filer — M, whose `Member` row was authored on `joinerDb` itself, so that part is a local
  read and is not part of this ticket's claim. Say so in the test comment rather than
  letting a reader over-credit the test.
- **`Revocation.RowIsGone`** fires on both removals in step 9/10, on the second node's
  database. It reads the live table by `StampId`, served by a scan — no point-lookup
  dependency.
- **Node teardown.** The whole body runs inside `try { … } finally { await
  stopBoth(founderNode, joinerNode); }`, like every other test in the file. A leaked
  libp2p node hangs the run.
- **Cross-test isolation.** `bringUpClosedStrand('manager-2nd')` gets its own provisioner
  instance and its own `Date.now()`-suffixed party ids; nothing is shared with the other
  four bring-ups.
- **Out of scope (do not add):** concurrent writes from both nodes at once; proving blocks
  physically replicate (the file's fourth test owns that claim, and its "the joiner's
  database is off limits" rule applies only inside that test); manager *resignation*
  (`removeManager`) from the second node.

## If the test fails

Treat a failure as a product finding, not a test bug to soften. Do **not** skip it, mark
it `todo`, loosen assertions, or add a best-effort branch — the file header explicitly
forbids restoring skip branches, and the workflow rules forbid burying a failure. Instead:
narrow it (which gate, which constraint, live vs. `committed`), leave the test failing,
file a `tickets/fix/bug-…` ticket naming the constraint and the read that did not resolve,
and state the failure plainly in the review handoff.

Before concluding "convergence failure", check the harness debug log for
`Wait condition threw: …` — `waitUntil` reports an always-erroring condition as a plain
timeout.

## Validation

From `packages/integration-tests`, streamed so the runner's idle timer never expires:

```
yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts --reporter=verbose 2>&1 | tee /tmp/closed-strand.log
```

Then `yarn typecheck` and `yarn lint` at the repo root (or in the package) for the touched
file. The other four tests in the file must still pass — the new test adds a bring-up but
touches no shared state.

## TODO

- Add a `managerKeys(db: Database): Promise<string[]>` helper beside the existing
  `memberKeys` helper — unfiltered scan of `Strand.Manager`, returning `MemberKey` values;
  document why it scans (single-column PK ⇒ any equality is a full-PK point lookup).
  Consider a sibling returning `(MemberKey, Generation)` if the step-4 generation
  assertion needs it, rather than two scans.
- Add the new test `it("a manager promoted on the second node runs manager actions from
  its OWN database", …)` with a `90_000` timeout, following steps 1–11 above.
- Write the test's own leading comment in the file's established voice: what is genuinely
  cross-node here (the live/`committed` `Manager` reads from `joinerDb`) and what is
  local-by-construction (M's own `Member` row, the `Revocation` filer check, the invite M
  authored and then consumed on the founder).
- Update the file's header comment: the "Three independent tests" sentence and the
  "WHERE THE WRITER LIFECYCLE RUNS" paragraph both describe a file that no longer matches —
  state that a fifth test drives manager-authorized writers from the second node's
  database, and which constraint branches that covers.
- Run the scenario file streamed, then `typecheck` + `lint`.
- Add one line to `docs/strands.md` in the manager section noting that manager actions are
  covered from a non-founder node — only if the doc already makes coverage claims there;
  do not invent a coverage section.
- Hand off to `review/` with an honest note on which manager branches are now networked
  (`Invite.InviteValid`, `Manager.Authorized` promotion, `Member.Authorized` direct-admit
  and manager-remove, `MemberPeer.Authorized` manager) and which manager writers remain
  founder-only (`removeManager`, `cancelInvite`, `admitManager`, `leaveStrand`).
