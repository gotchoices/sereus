description: A new automated test covering group-manager actions run from a second computer has been written but not yet run; validate it, fix whatever it turns up, and hand the work on for review.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

## Why this ticket exists

The parent ticket (`debt-manager-actions-from-second-node-coverage`) asked for one new
integration test plus supporting helpers. **The code is written and in the working tree.**
The prior agent hit its token budget immediately after the last edit and exited before
running anything, so the new test has **never been executed** — not once, not even to see
it compile. That is the whole of the remaining work.

Nothing about the design is open. Do not redesign the test; run it, and treat what it says
as the finding.

## What is already in the tree (do not re-do)

All changes are in
`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`:

- **Three new scan helpers** beside the existing `memberKeys`: `managerRows(db)` →
  `Array<{ memberKey, generation }>`, `managerKeys(db)` → `string[]` (derived from
  `managerRows`), and `inviteKeys(db)` → `string[]`. All are unfiltered scans with the
  key compared in JavaScript, because `Strand.Manager` and `Strand.Invite` each have a
  single-column primary key — so any `where` equality on it is a full-primary-key
  predicate, which the storage module serves as a point lookup that can miss on a
  networked strand. Inside a `waitUntil` such a miss is indistinguishable from a plain
  timeout, which is why the gates scan.
- **`addMemberByManager` added to the `@serfab/cadre-core` import list.**
- **A fifth test**, `'a manager promoted on the second node runs manager actions from its
  OWN database'`, timeout `90_000`, own bring-up via `bringUpClosedStrand('manager-2nd')`.
  Eleven steps: seat M on the joiner via a join, gate M's member row to the founder,
  founder promotes M, **gate M's manager row onto the joiner** (the enabling gate, plus a
  generation assertion), then from `joinerDb` — `issueInvite` (consumed on the founder to
  admit Z), `addMemberByManager` ×2 (X and Y), `addManager` (X), Y registers a device
  record, `revokeMember` (Y), manager-arm `removeMemberPeer` (Y's orphan record), and
  finally the single rejected write (a non-manager `issueInvite`).
- **Header-comment maintenance**: the "Three independent tests" sentence now says five and
  names them; a new paragraph in "WHERE THE WRITER LIFECYCLE RUNS" describes the fifth
  test and which constraint branches it covers; the gating paragraph and the
  visibility-vs-physical-replication paragraph were re-counted.

## What is left

- Run the scenario file, streamed so the runner's idle timer never expires. From
  `packages/integration-tests`:

  ```
  yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts --reporter=verbose 2>&1 | tee /tmp/closed-strand.log
  ```

  All five tests must pass — the four pre-existing ones as well, though the new test adds
  a bring-up and touches no shared state, so a failure in the others would be surprising.

- Run `yarn typecheck` and `yarn lint` (repo root or the package) for the touched file.
  Nothing has type-checked or linted since the edits landed. Two things to watch for
  specifically, because they were never verified: the new helpers must all actually be
  used (an unused one is a lint error under this repo's fully-enforced config), and the
  new test's indentation must be tabs, matching the rest of the file.

- Hand off to `review/` with an honest note (see below).

## If the test fails

Treat a failure as a product finding, not a test bug to soften. **Do not** skip it, mark it
`todo`, loosen assertions, or add a best-effort branch — the file header forbids restoring
skip branches and the workflow rules forbid burying a failure. Instead: narrow it (which
gate, which constraint, live `Manager` vs. the pre-transaction `committed.Manager`
snapshot), leave the test failing, file a `tickets/fix/bug-…` ticket naming the constraint
and the read that did not resolve, and state the failure plainly in the review handoff.

Before concluding "convergence failure", check the harness debug log for
`Wait condition threw: …` — `waitUntil` swallows a throwing condition and retries, so a
gate whose read errors on every attempt reports a plain timeout.

Two failure modes are known in advance and are *test* bugs rather than product findings,
so fix them in place if they appear:

- **Step 4's generation assertion** pins `Generation` to exactly 1, which depends on
  `addManager`'s successor policy (authorizer generation + 1). The schema enforces only
  strict ordering. A `NOTE:` at that line says to relax it to `toBeGreaterThan(0)` if the
  writer's policy ever changes. Same for step 7's `toBe(2)`.
- **Timing.** The `GATE` budget is 15 s per gate and the test carries roughly twice as many
  gates as its siblings; the `90_000` test timeout is headroom, not an expectation of
  slowness. If the whole test times out while individual gates pass, raise the test
  timeout — do not raise `GATE`, which is shared with every other test in the file.

## Deferred deliberately (record in the handoff, do not chase)

The parent ticket's last-but-one TODO said to add a line to `docs/strands.md` in the manager
section "**only if** the doc already makes coverage claims there; do not invent a coverage
section". That section (`## Who May Administer a Closed Strand`, around line 164) was read:
it states behavioural rules and known gaps, and makes no claims about test coverage
anywhere. So the doc edit was correctly skipped. Do not add one.

## Handoff content for `review/`

The review ticket must say plainly which manager rules are now exercised over the network
and which are not:

- **Now networked** (a manager action authored on the second node, resolving the founder's
  manager row): `Invite.InviteValid`, `Manager.Authorized`'s promotion branch,
  `Member.Authorized`'s direct-admit and manager-remove branches, and
  `MemberPeer.Authorized`'s manager branch.
- **Still founder-only**: `removeManager`, `cancelInvite`, `admitManager`, `leaveStrand`.
- **Local by construction inside the new test, so not part of its claim**: M's own member
  row (authored on the joiner), the `Revocation` tombstone-filer check in the revoke and
  device-record-removal steps, and the consumption side of the invite M issues (that invite
  is consumed on the founder — the cross-node claim is that a joiner-authored invite is
  *usable*, not merely visible).
- **Never run** if you are writing the handoff before a green run — say so explicitly
  rather than implying the test passed.

## TODO

- Run the scenario file streamed; capture the result.
- Run `yarn typecheck` and `yarn lint`; fix anything the new code introduced.
- If a test fails: narrow it, leave it failing, file the `fix/bug-…` ticket, say so in the
  handoff.
- Write the `review/` handoff with the coverage breakdown above, then delete this ticket.
