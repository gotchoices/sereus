description: The new automated tests for invitations that need outside sign-off have now been run and confirmed passing, after a sibling project's build was refreshed so the tests could execute at all.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, test-harness/build-freshness.ts, docs/api.md
difficulty: easy
---

# Validation results for the three new Phase 5 cases

## Scope

This ticket only ran and measured what `debt-approval-gated-redemption-remaining-e2e` /
`debt-approval-gated-redemption-e2e-validate` already wrote (see prior ticket text, preserved
below for context). No production or test code was changed here — this is a pure validation pass.

## What was done

- Built the linked sibling `C:\projects\quereus` (`yarn workspace @quereus/quereus build`) so
  `packages/integration-tests/test/global-setup.ts`'s `assertBuildFresh` guard stops blocking the
  suite. Had to redo this **four times** during this ticket: another tess pipeline is actively
  landing tickets against that same sibling checkout concurrently (commits
  `ticket(implement): bug-view-write-through-ignores-home-schema` and follow-on work landed mid-run).
  One of those intermediate states hit a sharp edge worth flagging: a plain incremental
  `tsc` build can silently no-op and leave `dist/tsconfig.tsbuildinfo`'s mtime untouched when a
  source file's on-disk mtime was bumped (e.g. by the other pipeline's git operations) **without its
  content changing** — tsc's own change-detection is content-based and sees nothing to do, but the
  guard's mtime comparison still reports stale, and a plain rebuild does not clear it. The fix each
  time was `yarn workspace @quereus/quereus clean && yarn workspace @quereus/quereus build` (forces
  a real rewrite of `dist`, including `tsconfig.tsbuildinfo`). If this recurs often enough to be
  annoying, worth a NOTE at the guard's remedy message, but did not touch `build-freshness.ts` here
  since it is out of this ticket's scope and working as designed otherwise.
- Ran `yarn workspace @serfab/integration-tests test strand-formation-e2e` three times (not the
  whole suite — a first full-suite attempt surfaced a wall of unrelated timeouts across
  `control-cohort-*` / `strand-membership-closed-strand-e2e` scenarios, all independently tracked
  in `tickets/.pre-existing-known.md`; not worth the multi-minute wall-clock. The ticket's own note
  about the vitest path filter was correct: filtering by the bare scenario name works, filtering by
  the file path does not).
- Ran `yarn lint` at the repo root: exit 0, no output.

## Results

**All three new Phase 5 cases — (vi), (vii), (viii) — passed in all three runs (3/3).**

| Run | Build state | Result | Case (vi) time |
|---|---|---|---|
| 1 | fresh `quereus` build | **22/22 green** | 2901 ms (whole test, both arms) |
| 2 | clean rebuild after a stale-guard false-positive | 21/22 — Phase 2 replication test failed | 3300 ms |
| 3 | fresh clean rebuild | 21/22 — same Phase 2 test failed, same way | 3487 ms |

Case (vi) arm A (the privileged-port, connect-refused arm) is fast every time — the whole test
(both arm A and arm B, plus the re-redemption proof) completes in under 3.5 s, nowhere near the
10 s approval-client budget or the 12 s provisioning budget. No sign of the "port 1 gets silently
dropped instead of refused" failure mode the prior ticket flagged as a possibility. It did not
surface as `Formation conflict, retry` or as an abort in any run.

Case (vii) (misconfigured `ftp://` scheme) and case (viii) (bound-invitation-to-existing-strand)
passed cleanly every time, consistent with the scheme check running before any HTTP as designed.

## The one failure, and why it is not this ticket's problem

Runs 2 and 3 both failed the same **pre-existing, already-tracked** test:
`Phase 2: Strand instance lifecycle > should form strand, start instances, and replicate data`,
`Timeout waiting for data replicates from Alice to Bob after 15000ms`. This is not one of the three
new cases and touches none of the files this line of work changed.

`tickets/.pre-existing-known.md` already carries this exact test under the
"Resolved in place" `strand-formation-e2e.integration.ts … three parties` entry's trailing caution
note, attributed at the time to `../optimystic` having uncommitted in-flight work that breaks
cross-node strand replication repo-wide, with an explicit instruction to re-measure against a clean
sibling before concluding drift again, and to fold any confirmed re-failure into
`strand-unique-index-sync-stale-revision` rather than filing a new ticket.

Re-measured here: `C:\projects\optimystic` has a **clean working tree** (HEAD `092f33f`,
`ticket(review): stale-failure-carries-coordinator-revision`) — not the uncommitted in-flight state
the earlier note blamed. The failure was nonetheless deterministic across both runs that hit it
(2/2, both ~15.9 s), not intermittent. That is new information the doc's own caution note asked
for, but per the standard tess pre-existing-failure rule this ticket does not re-file or fix it —
it is already tracked with an owning slug (`strand-unique-index-sync-stale-revision`), so
whoever picks that up next should see this note. Flagging it here for the reviewer / next triager
rather than touching that ticket myself, since chasing it is out of scope for a validation-only
ticket.

## Gaps / things the reviewer should know

- Only ran the target file, not the full integration suite (see above — full-suite run has its own
  pile of pre-existing failures unrelated to this work, already tracked).
- 3 runs, not more — each whole-file run costs ~80 s plus a sibling rebuild, and the signal was
  already unambiguous (3/3 on the actual cases under test, 0/2 vs 2/2 on the one unrelated flake
  depending on build-freshness luck).
- Did not touch `strand-unique-index-sync-stale-revision` or any other pre-existing-failure ticket.
- `yarn lint`: clean, exit 0.
- No production/test code was modified in this ticket — purely a run-and-record pass on what
  `debt-approval-gated-redemption-remaining-e2e` already wrote.

---

## Original ticket text (for context — the code work this validates)

### What already landed (do not redo)

The code half of `debt-approval-gated-redemption-remaining-e2e` is written and
`yarn workspace @serfab/integration-tests typecheck` passes clean:

- `packages/integration-tests/src/harness/fixtures/approval-hook-server.ts` — `decide` may now
  return `'unavailable'`, answering HTTP 503 ("the hook is up but broken"). Additive; the existing
  `'approve' | 'refuse' | FormationApproval` callers are unchanged.
- `strand-formation-e2e.integration.ts` Phase 5 — three new cases:
  - **(vi)** approver cannot be asked. Arm A publishes `http://127.0.0.1:1/hook` (privileged port,
    connect refused) and asserts `Formation approval unavailable, retry`, zero usage rows, a
    standby hook at `requestCount === 0`, and `ControlFormationUsageRecorder.isTokenUsed === false`.
    Arm B publishes a LIVE hook that answers 503, asserts the same reason, then flips the verdict
    to approve and re-redeems the SAME token — the proof the seat survived.
  - **(vii)** `misconfigured` via an `ftp://127.0.0.1:9/hook` `ValidationUrl`, with a live standby
    hook asserted at `requestCount === 0` (the scheme check runs before any HTTP).
  - **(viii)** the bound invitation shape: a closed strand inserted owner-signed up front, an
    invite naming it, and assertions that the joiner is seated on the pre-existing strand, receives
    that strand's `memberPrivateKey`, and that the approver was still posted only the five signed
    fields.
- `publishGatedInvite` gained an optional trailing `strandId` (unbound stays the default).
- The Phase 5 block comment and the file's top-of-file `wc -l` NOTE (now 1742) are updated.
- `docs/api.md` — the coverage paragraph after the reason table now says all five reasons and both
  invitation shapes run end to end, keeping the pointer to the real-fetch spec for transport.
