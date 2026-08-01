----
description: A new automated test that checks a group manager can run administrative actions from a second computer was written earlier and has now been run for the first time; it works, but the shared storage layer it runs on is currently unreliable, so the test only passes about half the time.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, tickets/.pre-existing-error.md, tickets/blocked/forked-control-collection-sync-livelocks.md
difficulty: medium
----

## What this ticket is

The implement stage for `debt-manager-actions-from-second-node-coverage` wrote a fifth test
into the closed-strand end-to-end scenario file and ran out of budget before executing it.
The follow-up ticket (`18-debt-manager-actions-from-second-node-validate`, now consumed) had
one job: run it. That has been done. **No code was changed at this stage** — the diff under
review is still exactly commit `f487e37`, which touches one test file and nothing else.

## Result, stated plainly

**The new test is not reliably green, and neither are three of its four older siblings.**

Every failure — in the new test and in the pre-existing ones — is the same platform fault
in the sibling `../optimystic` checkout, not a fault in the test. It reproduces at the
parent commit, in tests this diff never touched. Full evidence, including the verification
that it predates this work, is in `tickets/.pre-existing-error.md`; the short version:

```
PartialCommitError: Legacy multi-tree commit was not atomic …
Underlying failure: sync for collection default/Member/index/_uniq_1 exhausted 10 retries:
stale revision: block <id> at rev 2, requested rev 1
  at Collection.syncInternal (../optimystic/packages/db-core/src/collection/collection.ts:341)
```

Measured pass rates, whole-file runs (three runs at the current sibling build):

| test | passes |
| --- | --- |
| 1 — founds a closed strand, admits a second member, gates writes by membership | 0/3 |
| 2 — a member clears its own device record, a manager clears the leftovers | 1/3 |
| 3 — a joining node runs the join against its OWN database | 3/3 |
| 4 — replicates the founder's blocks PHYSICALLY into the joiner's block store | 0/3 |
| 5 — **new**: a manager promoted on the second node runs manager actions from its OWN database | 1/3 |

The new test on its own (`-t` filtered) was 2/3, so **3 of 6 total executions green**. Its
green runs complete in 4.2–7.4 s against a 90 s timeout, so this is not a timing problem and
the timeout does not need raising.

Two clean gates: `yarn typecheck` in `packages/integration-tests` exits 0, and `eslint` on
the file exits 0. All three new helpers are used, indentation is tabs.

## Why the failure is not the test's

- The failing statement is always a **founder-side** write (`consumeInvite` writing `Member`,
  or `addManager` writing `Manager`) — the same shape the four older tests have always run.
  When the new test fails, it fails at step 3, the founder's promotion of M, before any of
  its own cross-node claims are reached.
- The collection that cannot sync is always a **unique-index sub-collection**
  (`.../index/_uniq_N`), never the data tree, and the revision pair is always "at rev 2,
  requested rev 1".
- The parent commit's version of the file was extracted, run, and observed failing the same
  way. The scratch copy was deleted; the working tree is clean.

Nothing was skipped, marked `todo`, or loosened to get a green run.

## No new fix ticket was filed — deliberately

The root-cause site is already claimed by `tickets/blocked/forked-control-collection-sync-livelocks`
(same throwing line, `Collection.syncInternal`). Filing a second ticket on the same site
would duplicate it. Instead the evidence went into `tickets/.pre-existing-error.md`, which
the runner hands to a triage pass.

One thing in there needs a human's eye and is easy to lose, so it is repeated here: **the
blocked ticket's trigger is narrower than reality.** It describes the failure as arising
from a deliberately manufactured split-history (a write committed by a node that was alone,
reconnecting later), and offers `plan/10-control-delete-while-alone-tombstone` as an
in-repo mitigation on the reasoning that removing local-only commits removes the split. What
is failing here has **no split of any kind** — an ordinary two-node strand doing ordinary
membership writes, nothing partitioned or restarted. That mitigation would therefore not fix
this. Whether it is literally the same defect is not certain (the revision pair differs:
"rev 2, requested rev 1" here versus "rev 9, requested rev 9" there), which is exactly why
it was reported rather than deduped.

Also worth knowing when interpreting any re-run: `../optimystic` was being edited and
rebuilt by its own runner during this measurement — its coordinator-selection source
(`db-p2p/src/libp2p-key-network.ts`) changed and was rebuilt mid-window, and the failure
rate got worse across that rebuild. Suggestive, not proven.

## What to review

The diff is `f487e37`, one file:
`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`.

- **Three new scan helpers** beside the existing `memberKeys`: `managerRows(db)` →
  `Array<{ memberKey, generation }>`, `managerKeys(db)` (derived from it), and
  `inviteKeys(db)`. All are unfiltered scans filtered in JavaScript, because `Strand.Manager`
  and `Strand.Invite` each have a single-column primary key — so any `where` equality on it
  is a full-primary-key predicate, which the storage module serves as a point lookup that can
  miss on a networked strand. Inside a `waitUntil` such a miss looks exactly like a timeout.
- **The new fifth test** (`strand-membership-closed-strand-e2e.integration.ts:1025`), eleven
  steps with its own bring-up via `bringUpClosedStrand('manager-2nd')`.
- **Header-comment maintenance** — the "three tests" prose is now five, plus a paragraph on
  which constraint branches the fifth covers.

## What the new test claims (and does not)

This is the coverage breakdown the review should sanity-check against the file, since it is
the whole reason the test exists.

**Now exercised over the network** — a manager action authored on the second node, resolving
the founder-authored `Manager` row:

- `Invite.InviteValid` (live `Manager` read) — step 5, M issues an invite from `joinerDb`.
- `Manager.Authorized`'s promotion branch (live `Manager` read) — step 7, M promotes X.
- `Member.Authorized`'s direct-admit branch (pre-transaction `committed.Manager` snapshot) —
  step 6, M admits X and Y.
- `Member.Authorized`'s manager-remove branch (`committed.Manager`) — step 9, M revokes Y.
- `MemberPeer.Authorized`'s manager branch (`committed.Manager`) — step 10, M clears Y's
  orphan device record.

The point of covering both flavours is that a live `select` and a pre-transaction snapshot
are *different reads* of the same row; the test asserts they agree.

**Still founder-only, not covered by anything**: `removeManager`, `cancelInvite`,
`admitManager`, `leaveStrand`.

**Local by construction inside the new test, so explicitly not part of its claim**: M's own
`Member` row is authored on the joiner, so `Revocation.Authorized`'s tombstone-filer check in
steps 9 and 10 is a local read; `Manager.MemberExists` (step 7) and `MemberPeer.MemberExists`
(step 8) read rows written moments earlier on that same database; and the invite M issues in
step 5 is *consumed on the founder*, so the cross-node claim there is that a joiner-authored
invite is **usable**, not merely visible.

## Tripwires already parked in the code

- `strand-membership-closed-strand-e2e.integration.ts:1069` — a `NOTE:` saying step 4's
  `expect(generation).toBe(1)` pins the *writer's* successor policy (authorizer generation
  + 1), not the schema's, which enforces only strict ordering. Relax to `toBeGreaterThan(0)`
  if `addManager` ever seats successors differently. Step 7's `toBe(2)` is the same shape.
  Neither has misfired in any run so far.

## Deliberately not done

The parent ticket asked for a line in `docs/strands.md` under
`## Who May Administer a Closed Strand` **only if** that section already made claims about
test coverage. It was read (around line 164): it states behavioural rules and known gaps and
makes no coverage claims anywhere in the doc. The edit was correctly skipped — do not add
one.

## Honest gaps for the reviewer

- **The new test has never been observed green under whole-file load more than once.** Its
  three cross-node manager claims above are only as proven as that. If the platform fault is
  fixed and the test then fails for a reason of its own, that is new information nobody has.
- Steps 5–10 have never all completed in a single whole-file run at the current sibling
  build; the one green whole-file run predates the mid-session rebuild. The two green
  `-t`-filtered runs did complete all eleven steps.
- No attempt was made to reproduce the platform fault in a smaller harness, or to confirm it
  is literally the blocked ticket's defect rather than a relative. Both were judged to belong
  to the triage pass, not here.
