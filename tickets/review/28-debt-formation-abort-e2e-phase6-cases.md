description: Two new end-to-end tests now prove that when a host runs out of time part-way through someone redeeming a one-time invitation, the invitation is either left unused (so the joiner can retry) or, if the join actually completed, reported as the success it was.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts
difficulty: medium
----

Completes `debt-formation-abort-end-to-end-coverage`. Phase 1 (the approval-hook fixture) and the
`responderService` options bag landed in a prior run; this run wrote the two test cases and
validated the whole file for the first time since that fixture change.

## What changed

One addition: a `Phase 6: Provisioning abort and settle grace` describe at the END of
`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`
(its own `TestCadreNetwork` / `beforeAll` / `afterAll`, mirroring Phases 4 and 5). Nothing outside
that file was touched — no production code changed in this ticket.

Local helpers inside the describe: `insertHostStrand`, `publishBoundInvite`, `waitForAbort`,
`joinerService`. Module-scope `ownerSigner` / `responderService` / `invitationFor` /
`readFormationUsage` and the `startApprovalHook` fixture are reused as-is.

Both cases use the **bound** invite shape (an owner-signed open `Strand` row inserted up front, plus
an invite naming it), which is the shape production publishes and the one that routes through
`recordUsage` → `recordFormationUsage` — the path carrying the real abort checks. Both set
`formationConfig: { provisionTimeoutMs: 3000 }` on the responder, which splits into a 1500 ms work
budget (when the abort fires) and a 1500 ms settle grace. The joiner is unconfigured and waits out
its 15 s default, so it never times out first.

### Case (i) — cancellation leaves the invitation unspent

Lever is a **real stalled approval hook** (`beforeAnswer` holds the first ask), no shims anywhere on
the path. Asserts, in order: `formStrand` rejects with `/Formation provisioning timed out/` (the
listener's own retryable reason — not `Internal formation error`, not a dial read-error); usage
count 0; `hook.requestCount === 1`; `hook.abortedCount === 1` via `waitUntil` (5 s cap) because the
server observes the hang-up a few ticks late. Then the hold is released and **the same token** is
redeemed successfully — `result.strandId === hostStrandId`, count 1, `requestCount` 2, stored
consent re-verifies.

### Case (ii) — a redemption that lands inside the grace is adopted

No hook. Lever is a timing decorator around a **real** `ControlFormationUsageRecorder` over the
**real** control database: `recordUsage` writes the row through the real path, then parks on
`waitForAbort(params.signal, 10_000)` until the work budget aborts, so it settles just inside the
grace with no timer race. Every other recorder method delegates. Asserts: `formStrand` **resolves**
with `hostStrandId`; `observedAbort === true`; count 1; consent re-verifies;
`ed25519PublicKeyB64FromPeerId(result.memberKey) === row.peerKey`; and a second redemption of the
same single-use token is refused with `/Invalid token/` with the count still 1.

`waitForAbort`'s 10 s cap exists so a build that stopped cancelling fails an assertion instead of
hanging to the vitest timeout. An absent `signal` reports false immediately — that is the
signal-dropped regression detector.

## Validation actually run

- `yarn workspace @serfab/integration-tests exec tsc --noEmit -p tsconfig.json` — clean.
- `yarn lint` — clean (one `prefer-const` error on `waitForAbort`'s timer handle was fixed by
  reordering the two closures; the listener is now registered last so neither can run before the
  other's binding exists).
- Full file: `yarn vitest run --reporter=verbose src/scenarios/strand-formation-e2e.integration.ts`
  → **18 passed, 1 failed**. Both Phase 6 cases passed (3344 ms / 2997 ms). The failure is
  Phase 2's `should form strand, start instances, and replicate data`
  (`Timeout waiting for data replicates from Alice to Bob after 15000ms`) — **pre-existing and
  already tracked**: `tickets/.pre-existing-known.md` (~line 85) records this exact test as masked
  by the repo-wide cross-node strand-replication breakage under the live `@optimystic/db-p2p` /
  `../optimystic` working trees. Per the workflow rules it was NOT re-reported and NOT skipped.
- Phase 6 alone re-run after the lint fix (`-t "Phase 6"`) → both pass (3759 ms / 3119 ms).

## Known gaps — please treat these as the starting point

- **The vacuous-pass sanity check was NOT run.** The plan called for temporarily deleting the
  `signal` argument from `StrandFormationManager`'s `recordUsage` call and confirming case (i)
  fails. This run hit its token budget first. Case (ii)'s `observedAbort` assertion covers the
  manager→recorder hop by construction (an absent signal reports false), but the
  listener→manager hop has no such demonstration yet. **Cheapest first review action.**
- **Flake evidence is thin.** Two runs each, both green. Case (ii) settles by construction rather
  than by a timer race, so it should be stable, but "a few runs" was the plan and two is what
  happened.
- **Case (i) has a timing assumption worth eyeballing.** Three in-memory control-DB reads
  (`resolveStrand`'s two, then `recordUsage`'s invite read) must complete inside the 1500 ms work
  budget before the HTTP call goes out, or `hook.requestCount` would be 0 and the case would fail
  for the wrong reason. Measured runtime leaves large headroom, but on a loaded CI box this is the
  first thing that would go.
- **The `ControlDatabase` in-lock abort seam is deliberately uncovered**, and the Phase 6 block
  comment says so at the top of the describe: dropping the `signal` on the
  `controlDatabase.recordFormationUsage({ ..., signal })` call *alone* would not fail either case,
  because the recorder's earlier checks fire first. Driving it needs the write lock held from
  outside, which has no public handle; it stays covered off-network by
  `packages/cadre-core/test/control-formation-invite.spec.ts` (~line 361).
- **`responderService`'s doc comment still carries the prior run's NOTE** that Phases 4/5 unregister
  at the end of the case rather than in a `finally`. Phase 6 does use `finally` (it has assertions
  that can throw while a hook is held), so the note is accurate — but the Phase 4/5 leak is still
  there and untouched.

## Sibling work on the same file

`debt-approval-gated-redemption-remaining-e2e` and `debt-formation-use-number-race-real-concurrency`
also extend this file and the approval-hook fixture. Phase 6 is appended at the end and is purely
additive; no `prereq:` relationship.
