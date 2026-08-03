description: Two end-to-end tests now prove that when a host runs out of time part-way through someone redeeming a one-time invitation, the invitation is either left unused (so the joiner can retry) or, if the join actually completed, reported as the success it was.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, docs/architecture.md
----

Completes `debt-formation-abort-end-to-end-coverage`. The approval-hook fixture and the
`responderService` options bag landed in earlier runs; the implement run wrote the two test cases;
this review run verified them, closed the handoff's stated gap, and fixed the duplication and
doc drift it introduced.

## What shipped

`Phase 6: Provisioning abort and settle grace` at the end of
`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`, with its own
`TestCadreNetwork`, mirroring Phases 4 and 5. No production code changed.

Both cases use the bound invite shape (owner-signed open `Strand` row inserted up front, plus an
invite naming it) — the shape production publishes, and the one routing through
`recordUsage` → `recordFormationUsage`, which carries the real abort checks. Both set
`formationConfig: { provisionTimeoutMs: 3000 }`, which `splitProvisionBudget` halves into a
1500 ms work budget and a 1500 ms settle grace. The joiner is unconfigured and waits out its 15 s
default, so it never times out first.

- **(i) cancellation leaves the invitation unspent.** Lever is a real stalled approval hook
  (`beforeAnswer` holds the first ask); no shims on the path. Asserts the listener's own retryable
  reason (`/Formation provisioning timed out/`), usage count 0, one hook request, and — via
  `waitUntil` — that the hook observed the client hang-up, i.e. the cancel reached the wire. Then
  the hold is released and the **same** token redeems successfully.
- **(ii) a redemption landing inside the grace is adopted.** Lever is a timing decorator over a
  real `ControlFormationUsageRecorder` on the real control database: the row is written through
  the real path, then the call parks until the work budget aborts. Asserts `formStrand` resolves,
  `observedAbort === true`, count 1, consent re-verifies, member key matches the stored row, and a
  second redemption of the single-use token is refused.

## Review findings

**Checked:** the implement diff read cold before the handoff; the composed abort chain in
`strand-formation-protocol.ts` / `strand-formation-manager.ts` / `control-formation-recorder.ts`;
every numeric claim in the new comments; DRY and helper placement across all six phases; resource
cleanup (holds, hooks, services, timers); type safety of the decorator against
`FormationUsageRecorder`; file size; and whether any doc should have moved.

**Major — none.** No new ticket filed. The two cases drive the path they claim to, and every
assertion in them was demonstrated to carry weight (below).

**Closed the handoff's stated gap — the vacuous-pass check, run this pass.** The implementer flagged
this untested and named it the cheapest first review action. Both hops above the recorder were
measured non-vacuous by temporarily deleting `signal` from production code, rebuilding
`@serfab/cadre-core`, and re-running Phase 6:

| Hop broken | Case (i) | Case (ii) |
|---|---|---|
| `provisionStrand: (contact, signal) => provisionAsResponder(contact, signal)` (listener→manager) | fails — `hook.abortedCount` never reaches 1 | fails — `observedAbort` false |
| `recorder.recordUsage({ ..., signal })` (manager→recorder) | fails — same | fails — same |

So the listener→manager hop the handoff called undemonstrated is in fact covered, and by **both**
cases rather than only case (ii). Both edits were reverted and `git diff` on
`strand-formation-manager.ts` confirmed byte-identical to HEAD before finishing.

**Minor — fixed in this pass:**

- *DRY.* `joinerService` was duplicated verbatim — same body, same doc comment — in the Phase 5 and
  Phase 6 describes, and Phase 4 open-coded the identical `new StrandSolicitationService({...})`
  three more times. Hoisted one copy to module scope beside `responderService` / `invitationFor`
  and pointed all five sites at it.
- *Comment read as stale on arrival.* The Phase 6 block comment said the abort behaviours "are
  covered per-layer only" and "nothing ran the COMPOSED path" in the present tense — inside the
  describe that composes them. A later reader would conclude the coverage is still missing. Reworded
  to past tense, and the vacuous-pass result above recorded there so it is not re-derived.
- *Docs.* `docs/architecture.md` line 539 describes the abort/adopt behaviour accurately but cited
  no end-to-end coverage, while the same doc cites scenario coverage elsewhere (e.g.
  `control-stream-authz` at line 353). Added the Phase 6 pointer. Nothing else was stale:
  `docs/STATUS.md` never claimed this path was uncovered, so there was no false statement to
  retract.

**Verified accurate rather than changed:** the comment's arithmetic — `provisionCeilingMs(30000,
5000, 3000)` = 22 s so 3000 ms is unclamped, and `splitProvisionBudget(3000)` = 1500/1500 — both
check out against the constants in `strand-formation-protocol.ts`. `waitForAbort`'s timer/listener
ordering is sound (each closure runs after both bindings exist; whichever settles first tears down
the loser).

**Tripwire — parked, not ticketed:** the scenario file is 1557 lines (`wc -l`, 2026-08-02), the
largest in `src/scenarios/` against a next-largest of 1170, and sibling ticket
`debt-approval-gated-redemption-remaining-e2e` will extend it further. It is not a problem yet —
one cohesive subject, and each phase already owns its own network with no shared state — so it is a
`NOTE:` in the file header giving the condition (another phase lands) and the mechanical split
(per-phase files plus a shared `strand-formation-helpers.ts`), rather than a ticket. Filing one
would also have collided with the open plan ticket already claiming this file.

**Deliberately left uncovered, and said so in the code:** `ControlDatabase`'s in-lock abort check.
Dropping `signal` on `controlDatabase.recordFormationUsage({ ..., signal })` *alone* fails neither
case, because the recorder's earlier checks fire first. Driving it end to end needs the write lock
held from outside, which has no public handle; it stays covered off-network by
`packages/cadre-core/test/control-formation-invite.spec.ts` (~line 361). The Phase 6 block comment
states this at the top of the describe.

**Known limitation, unchanged and already documented in production code:** work that settles
*after* the grace still reports "timed out" over a spent invite, with no recovery path (every retry
mints a fresh keypair). `settleWithinGrace` carries that NOTE and logs the late settle as its
observability. No test was added — the behaviour is a deliberate accepted window, not a defect.

**Not re-litigated:** the `responderService` doc comment's note that Phases 4/5 unregister at the
end of the case rather than in a `finally`. Still accurate, still harmless (every case creates its
own parties and the leak dies with `network.shutdown()`), and outside this ticket's diff.

## Validation

- `yarn lint` — clean, exit 0.
- Full file, `yarn vitest run --reporter=verbose src/scenarios/strand-formation-e2e.integration.ts`
  → **18 passed, 1 failed.** Phases 1, 3, 4, 5, 6 all green after the DRY refactor; Phase 6 (i)
  2999 ms, (ii) 2689 ms.
- The single failure is Phase 2's `should form strand, start instances, and replicate data`
  (`Timeout waiting for data replicates from Alice to Bob after 15000ms`) — pre-existing and
  already tracked in `tickets/.pre-existing-known.md` (~line 85) as masked by the repo-wide
  cross-node strand-replication breakage under the live `@optimystic/db-p2p` / `../optimystic`
  working trees. Not re-reported, not skipped.
- Flake evidence is now four Phase 6 runs across two sessions, all green, plus two runs green under
  the whole-file suite. Case (i)'s slowest observed run was 4816 ms against a 30 s per-test budget.
  It still carries the timing assumption the implementer flagged — three in-memory control-DB reads
  must complete inside the 1500 ms work budget before the HTTP call goes out — and the observed
  spread (2999–4816 ms end to end) leaves that headroom intact but unproven under CI load.
- One incidental: mid-run the stale-build guard tripped on the linked `../quereus` workspace
  (a human editing it concurrently). Rebuilt it per the guard's own instruction; unrelated to this
  ticket and not a sereus defect.
