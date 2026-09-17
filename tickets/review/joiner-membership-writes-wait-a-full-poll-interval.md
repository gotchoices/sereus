description: A machine joining a shared workspace used to sit idle for half a minute before recording that it is a member and which device it is; it now does that about a second after the workspace becomes usable. Built and verified.
files:
  - packages/cadre-core/src/strand-membership-reconciler.ts (the retry ladder; the timer seam changed from setInterval to setTimeout)
  - packages/cadre-core/src/strand-instance-manager.ts (publishDatabase — the kick; buildStrandRuntime comments)
  - packages/cadre-core/src/index.ts (two new exports)
  - packages/cadre-core/test/strand-instance-manager-membership.spec.ts (kick coverage)
  - packages/cadre-core/test/strand-membership-reconciler.spec.ts (ladder coverage; the `scheduler wiring` block is now `retry scheduling`)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (the new end-to-end gate at the default cadence)
  - packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (workaround removed)
  - packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts (workaround removed)
  - docs/strands.md ("Joining")
difficulty: medium
----

# What was built

A joining machine's last two membership writes — seating its `Strand.Member` row by redeeming the invitation its formation staged, and writing its own machine→party `Strand.MemberPeer` binding — used to run about 30 seconds after the strand became writable. The loop that does them (`StrandMembershipReconciler`) is armed at bring-up and kicks one immediate pass, but on a joiner that pass runs while the first-sync write gate is still withholding the database, so it finds none and returns. Its next opportunity was the flat 30 s interval it had armed at `start()`. Two arms fix that; a third, optional arm was deliberately not taken.

**Arm 1 — the kick.** `StrandInstanceManager.publishDatabase` now calls `reconcile()` on the strand's reconciler, if one is registered. That method is the single seam where a withheld database becomes available: the first-sync gate's `onHeaderHeld`, and the founder-bootstrap-through-the-gate path, both funnel through it. It needs no `wasGated` test of its own — a launch that was never gated publishes BEFORE the reconciler is constructed, so the map has no entry to kick and the loop's own immediate pass already sees the database. The call is `void`-ed (publishing stays synchronous) and chains on the loop's own tail, so it cannot overlap a pass in flight.

**Arm 2 — a cadence that suits an unfinished join.** The reconciler's timer changed from one repeating `setInterval` to a self-rescheduling `setTimeout` chain: the next pass is armed only once the previous one settles. The delay is chosen per pass:

- A pass that leaves the join UNFINISHED — `consumeInvite` failed because the `Strand.Invite` row has not replicated here, the cohort is briefly unwritable, no database yet, no transport peer id yet — re-arms on a doubling ladder from `INITIAL_JOIN_RETRY_INTERVAL_MS` (1 s), capped at the configured poll interval.
- A pass that is merely IDLING — no member row and no staged invitation, i.e. nobody has admitted this party at all — re-arms on the flat poll interval and resets the ladder. That is the state the 30 s cadence was designed for, and there is nothing this machine can do faster.

`DEFAULT_REVOCATION_POLL_INTERVAL_MS` is untouched.

**Arm 3 — dropped, not forgotten.** Merging the redemption and the binding into one transaction was not attempted: the saving is unmeasured (the source ticket's experiment was abandoned), and merging them also merges their failure modes — today a redemption that lands but reports torn simply heals on the next pass, which sees the member row and proceeds to the binding. The hypothesis, the 27 + 18 `/cluster` baseline and the condition for revisiting it are recorded as a `NOTE:` at the exact site in `doPass`. Nothing is queued for it.

## Interface changes (no backwards compat, per AGENTS.md)

- `StrandMembershipReconcilerDeps.scheduler` is now `MembershipRetryScheduler` (`setTimeout` / `clearTimeout`) instead of the enforcer's `RevocationRefreshScheduler` (`setInterval` / `clearInterval`). The enforcer's own seam is unchanged. Only tests injected one.
- `INITIAL_JOIN_RETRY_INTERVAL_MS` and `MembershipRetryScheduler` are exported from `@serfab/cadre-core`.
- `StrandMembershipReconciler.start()` no longer arms a timer synchronously; the first timer appears when the first pass settles. Anything asserting "a timer exists right after `start()`" has to settle the loop first.

## What to run

    yarn workspace @serfab/cadre-core typecheck
    yarn workspace @serfab/cadre-core test strand-membership-reconciler strand-instance-manager-membership
    yarn workspace @serfab/integration-tests test blind-relay-phone-to-phone-e2e
    yarn workspace @serfab/integration-tests test strand-chat-participants-converge
    yarn workspace @serfab/integration-tests test strand-formation-cross-party-seed
    yarn lint

## Use cases the change has to keep true

- **A joiner over a real relay finishes its join with the strand.** `blind-relay-phone-to-phone-e2e.integration.ts` is the new end-to-end gate and runs at the PRODUCTION cadence — nothing in it overrides `revocationPollMs`. Within `JOIN_FINISH_MS` (20 s) of `whenStrandWritable` resolving, the joiner's own `Strand.Member` row and its own `Strand.MemberPeer` binding must both be present, and the staged invitation must be un-staged. VERIFIED NON-VACUOUS: with the kick removed and the ladder's first rung set to 30 s, this gate fails on the timeout ("Timeout waiting for B's Member seat and its own MemberPeer binding ... after 20000ms") and passes again once both are restored. Observed with the fix in place: the whole scenario runs in about 3 s.
- **A joiner that writes the instant `addStrand` resolves still converges.** The membership writes now overlap the app's first write, which is the shape `strand-chat-participants-converge` test 2 exercises deliberately. Run 4 times post-change, green every time (2.1–2.7 s). This is the risk the source ticket flagged (concurrent strand inserts tearing) and four runs is a small sample — a reviewer who wants more confidence should run it several more times rather than reasoning about it.
- **A joiner at the production cadence redeems without help.** `strand-formation-cross-party-seed` test 2 dropped its `revocationPollMs: 2_000` workaround and completes in about 2.5 s.
- **Idling is still cheap.** A machine nobody has admitted re-checks once per poll interval, not once per second: covered by "a joiner nobody has admitted yet re-arms at the flat poll interval (the 30 s default)".
- **The ladder climbs and resets.** "an UNFINISHED join climbs a doubling ladder capped at the poll interval, and idling resets it" asserts the exact delay sequence `[4000, 1000, 2000, 4000, 4000, 1000]` at `pollIntervalMs: 4_000` against the injected scheduler.
- **The kick happens exactly once, and only where it is needed.** Two unit cases in `strand-instance-manager-membership.spec.ts`: a gated launch (Header withheld, then flipped) publishes and produces exactly one extra `reconcile()`; a launch that was never gated produces none.
- **Nothing was quietly disarmed.** `strand-party-removal-via-formation-e2e` and `strand-removal-cuts-network` set `revocationPollMs` for the revocation ENFORCER, not for this ladder — deliberately untouched. Both still pass.

## Results

- `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn workspace @serfab/cadre-core build` — all clean.
- The two cadre-core specs: 40 of 40 passed.
- Integration scenarios run and green: `blind-relay-phone-to-phone-e2e` (twice, plus the deliberately-broken control run), `strand-chat-participants-converge` (4 times), `strand-formation-cross-party-seed`, `strand-membership-closed-strand-e2e`, `strand-membership-second-machine`, `strand-party-removal-via-formation-e2e`, `strand-removal-cuts-network`, `strand-two-party-two-machine`, `strand-circuit-same-party-e2e`, `strand-late-cadre-join`, `strand-addr-seed-convergence`, `strand-creation`, `strand-formation-concurrent-redemption`, `strand-formation-e2e`, `strand-unpublish-sibling-convergence`.
- Full `yarn workspace @serfab/cadre-core test`: 2179 passed, 1 skipped, 4 FAILED — all four are the budget-floor specs already listed in `tickets/.pre-existing-known.md` against `blocked/budget-floors-trip-while-optimystic-block-floor-work-is-in-flight` and `blocked/warm-restart-into-declared-schema-diverges-from-declaration`. Not re-reported, not touched, nothing skipped or loosened.

## Known gaps — read these before reviewing

- **The last edit could not be re-tested.** After the green 40-of-40 run I added the arm-3 `NOTE:` comment in `doPass`. A re-run of the two specs is now refused by the build-freshness guard: `@optimystic/db-core`'s dist is stale because a concurrent runner in the sibling `../optimystic` workspace is mid-edit — the same condition `.pre-existing-known.md` records as blocking the budget-spec re-measure. `git diff` confirms the edit added no non-comment line, and typecheck, lint and build pass, but RE-RUN BOTH SPECS once that guard clears. Do not build the sibling workspace to unblock it.
- **20 s is a judgement call.** `JOIN_FINISH_MS` has to sit below the 30 s regression to be worth anything, and above whatever a slow circuit costs. The observed cost is about 1 s; every other gate in that file budgets 60 s for circuit headroom. If it ever goes flaky on slower hardware the honest fix is a longer budget that is still under 30 s, not deleting the gate.
- **A dead invitation costs one extra fast retry.** A pass where `consumeInvite` is rejected as expired, cancelled or consumed-elsewhere drops the invitation and returns WITHOUT marking the pass idle, so the next attempt is one ladder rung away rather than a poll interval. The pass after that is idle and re-arms flat. Harmless, but it is a deliberate asymmetry a reviewer will notice.
- **`lastPassIdle` is the whole classification.** Every unfinished outcome that is not "no member row and no staged invitation" climbs the ladder — including "no live database" and "no transport peer id". That is intentional (an unpublished database is an unfinished join, which is the case this ticket exists for) and is covered by "a pass with no live database retries on the LADDER, not the idle interval", but it means a future early-return added to `doPass` inherits the fast ladder by default. Worth checking that is still the right default if one is added.
- **Arm 3 remains unmeasured.** See the `NOTE:` in `doPass`. Nobody has counted `/cluster` streams for the single-transaction variant, and this ticket did not add a way to.
- **`backlog/bug-removed-party-cannot-redeem-its-way-back` is untouched.** A kick cannot restart a loop that has latched `stoppedFlag`, by design. `reconcile()` is the entry point that ticket would want to re-use once it re-arms the loop.

## Review findings

- Arm 3 (one transaction instead of two for the redemption and the binding) was weighed and left undone: unmeasured saving, and it would merge two independent failure modes. Parked as a `NOTE:` at the site in `StrandMembershipReconciler.doPass` (`packages/cadre-core/src/strand-membership-reconciler.ts`), carrying the 27 + 18 `/cluster` baseline and the condition for revisiting.
