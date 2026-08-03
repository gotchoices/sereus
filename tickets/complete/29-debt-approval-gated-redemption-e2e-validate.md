----
description: The automated tests for invitations that need outside sign-off were re-run and confirmed passing, and a long-standing unrelated test failure in the same file was traced to an already-tracked defect and filed against it.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, test-harness/build-freshness.ts, docs/api.md, tickets/blocked/control-db-cross-node-convergence-halted.md, tickets/.pre-existing-known.md
----

# Complete: approval-gated redemption end-to-end coverage, validated

## What shipped

The code half landed in `920e6cf` (`debt-approval-gated-redemption-remaining-e2e`); this line of
tickets validated it. Net effect on the repo:

- `packages/integration-tests/src/harness/fixtures/approval-hook-server.ts` — the fixture's
  `decide` callback gained a fourth verdict, `'unavailable'`, answering HTTP 503 ("the hook is up
  but broken"). Purely additive; existing callers unchanged.
- `strand-formation-e2e.integration.ts` Phase 5 — three new cases:
  - **(vi)** the approver cannot be asked. Arm A points the invitation at a dead port (connect
    refused); arm B points it at a live hook answering 503, then flips the verdict to approve and
    re-redeems the *same* single-use token to prove the seat was never consumed. Both arms assert
    the joiner-visible reason `Formation approval unavailable, retry`, zero usage rows, and
    `ControlFormationUsageRecorder.isTokenUsed === false`.
  - **(vii)** a `ValidationUrl` with an unusable scheme (`ftp://`), with a live standby hook
    asserted at `requestCount === 0` — proof the scheme check runs before any HTTP goes out.
  - **(viii)** the bound-invitation shape: a closed strand inserted owner-signed up front, an
    invitation naming it, and assertions that the joiner is seated on that pre-existing strand,
    receives its membership key, and that the approver was still posted only the five signed
    fields (the membership secret reaches the joiner, never the approver).
- `docs/api.md` — the approval-hook coverage paragraph now states that all five rejection reasons
  and both invitation shapes run end to end, keeping the pointer to the HTTP-client spec for pure
  transport behaviour.

## Validation

- `yarn workspace @serfab/integration-tests test strand-formation-e2e` — **5 whole-file runs across
  the validation and review passes; cases (vi), (vii), (viii) green in all 5.** Costs 2.2-3.5 s
  each, well inside both the 10 s approval-client budget and the 30 s test budget. Case (vi) arm A
  never hit the slow path its own comment warns about (an environment that drops instead of
  refusing on the dead port would take ~10 s and still pass) — it was fast every run.
- `yarn workspace @serfab/integration-tests typecheck` — exit 0.
- `yarn lint` (repo root) — exit 0, before and after the review's edits.
- Full integration suite deliberately **not** run: it carries its own set of unrelated failures,
  all already catalogued in `tickets/.pre-existing-known.md`, at a multi-minute wall-clock cost.

## Review findings

Read the implement diff (`920e6cf`) before the handoff summary, as required.

**Correctness — nothing wrong found.** Traced each new case against what it claims to prove. The
strongest claims hold: (vi) arm B's re-redemption of the same token after the hook recovers is a
real seat-survival proof, not a proxy; (vii)'s standby-hook `requestCount === 0` genuinely
distinguishes "rejected on the scheme" from "rejected after asking"; (viii) asserts the posted
field set, so the membership-secret non-disclosure claim is checked rather than asserted. Verified
independently that the docs' "all five rejection reasons" claim is true and not off by one —
`refused` (ii), `unenrolled` (iii and iv), `malformed` (v), `unavailable` (vi), `misconfigured`
(vii) — six cases covering five reasons.

**Fixed inline (minor):**

- `docs/api.md` — the new paragraph ended "…which is what makes the sentence before this one
  checkable", but the rewrite moved the sentence it referred to two paragraphs up. Now names the
  claim ("the no-`FormationUsage`-row claim above") instead of pointing at a position.
- `strand-formation-e2e.integration.ts` Phase 5 header comment said "all five ways a redemption
  must be refused" while the block now holds six such cases. Reworded to say five *reasons*, six
  cases, and why (`unenrolled` is reached two ways).
- The file's top-of-file line-count NOTE was correct at the time (1742, verified with `wc -l`) and
  is updated to 1744 for the review's own comment additions.

**Major — none filed, and that is a finding, not an omission.** Went looking specifically for
scope creep in the fixture (none — the 503 branch is four lines and mirrors the existing 403
branch), for assertions that would pass for the wrong reason (the implementer had already guarded
the two that could: enrollment is set up in (vi) even though neither arm reaches the enrollment
check, precisely so a future reordering of the recorder's pre-checks fails loudly), and for
resource leaks (every new case closes its hook in a `finally`; the responder-unregister sits at the
end of the body, which matches the documented convention for this file and is explained by its own
NOTE at line 164).

**Tripwires recorded (not filed as tickets):**

- `test-harness/build-freshness.ts` — a `NOTE:` on `checkBuildFreshness` explaining that the guard
  compares mtimes while `tsc` compares content, so a sibling checkout under concurrent automation
  can have a source file's mtime bumped with its bytes unchanged; the incremental rebuild then
  no-ops, `.tsbuildinfo` does not move, and the guard still reports stale — a rebuild that appears
  not to work. Hit twice on `../quereus` during the validation pass; the escape is
  `yarn workspace <name> clean && yarn workspace <name> build`. The note says to teach the `'stale'`
  remedy message to suggest the clean *if* this stops being rare. Not a defect today: the guard is
  behaving exactly as designed for the input it is given.
- Case (vi) arm A's dependence on a dead-port connect being *refused* rather than silently dropped
  is already documented at the call site by the implementer, with the fallback behaviour (falls to
  the client's 10 s budget, same category, still passes) spelled out. Nothing added.

**Test-coverage gaps considered and consciously left:** no case drives `malformed` via a malformed
*body* (non-JSON, over-64-KiB, missing field) at the scenario level — that is the HTTP client's own
decision table and is covered in `test/formation-approval-real-fetch.spec.ts`, which both the docs
and the Phase 5 header explicitly delegate to. Duplicating it here would cost ~3 s of real libp2p
per case to re-prove a pure client-side branch.

**Docs checked, not assumed.** Grepped every `docs/` file mentioning `ValidationUrl` /
`ValidationKey` / "approval hook" rather than trusting the handoff's list:

- `docs/api.md` — hook-answer and rejection-reason tables re-read against the fixture and the new
  cases; already accurate, no change needed beyond the dangling-reference fix above.
- `docs/STATUS.md` — **was stale and is now fixed.** Its approval-hook entry enumerated exactly the
  five original Phase 5 cases as the end-to-end coverage; the implement pass added three more and
  never updated it. Now states all five rejection reasons and both invitation shapes, and delegates
  transport to the client-level spec.
- `docs/architecture.md` — mentions the approval hook only for the timeout ladder and the
  `ValidationKey` table semantics, and cites Phase 6 (not Phase 5) for its end-to-end claim. Nothing
  there is invalidated by this change, so it is left alone deliberately.

**Pre-existing failure — re-measured and re-homed.** `Phase 2: Strand instance lifecycle > should
form strand, start instances, and replicate data` fails with `Timeout waiting for data replicates
from Alice to Bob after 15000ms`. It is not one of the new cases and touches nothing this work
changed. `tickets/.pre-existing-known.md` carried it as a caution note blaming build drift from
`../optimystic`'s then-uncommitted work, with an explicit instruction to **re-measure against a
clean sibling before concluding drift again, and to fold a confirmed re-failure into the owning
ticket rather than file anew**. That re-measurement is now done — `../optimystic` clean at
`092f33f`, stale-build guard passing on every run, **4 failures in 5 runs** — so the drift
attribution is dead. Acted on the instruction rather than leaving it as a note: folded it into
`tickets/blocked/control-db-cross-node-convergence-halted.md` (new "Folded in 2026-08-02" section,
including why it is the *cheapest* reproduction in that class — one failing test in an otherwise
green file, ~16 s to the failure, no closed-strand membership machinery needed) and updated both
affected entries in `tickets/.pre-existing-known.md`. Also recorded the knock-on for
`tickets/blocked/strand-unique-index-sync-stale-revision`: its unblock condition says to wait for
the sibling to settle and confirm this test goes green, and the sibling has settled while the test
has not gone green — so waiting will not clear that gate, only fixing the convergence class will.
No new ticket filed; no existing ticket's analysis was altered.
