description: A machine joining a shared workspace used to sit idle for half a minute before recording that it is a member and which device it is; it now does that about a second after the workspace becomes usable. Built, reviewed and verified.
files: packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-first-sync-gate.ts, packages/cadre-core/src/timeout-scheduler.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/strand-instance-manager-membership.spec.ts, packages/cadre-core/test/strand-first-sync-gate.spec.ts, packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts, packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts, docs/strands.md, docs/architecture.md
----

# What landed

A joining machine's last two membership writes — seating its `Strand.Member` row by redeeming the invitation its formation staged, and writing its own machine→party `Strand.MemberPeer` binding — used to run about 30 seconds after the strand became writable. The loop that does them (`StrandMembershipReconciler`) is armed at bring-up and kicks one immediate pass, but on a joiner that pass runs while the first-sync write gate is still withholding the database, so it finds none and returns. Its next opportunity was the flat 30 s interval it had armed at `start()`.

Implement commit `6f43f62`; review fixes in the commit carrying this ticket.

**The kick.** `StrandInstanceManager.publishDatabase` calls `reconcile()` on the strand's reconciler if one is registered. That method is the single seam where a withheld database becomes available — the first-sync gate's `onHeaderHeld` and the founder-bootstrap-through-the-gate path both funnel through it, and it is the only place `instance.database` is ever assigned. It needs no `wasGated` test: a launch that was never gated publishes before the reconciler is constructed, so the map has no entry to kick and the loop's own immediate pass already sees the database. The call is `void`-ed (publishing stays synchronous) and chains on the loop's own tail.

**A cadence that suits an unfinished join.** The reconciler's timer changed from one repeating `setInterval` to a self-rescheduling `setTimeout` chain — the next pass is armed only once the previous one settles. A pass that leaves the join UNFINISHED (`consumeInvite` failed because the `Strand.Invite` row has not replicated here, the cohort is briefly unwritable, no database yet, no transport peer id yet) re-arms on a doubling ladder from `INITIAL_JOIN_RETRY_INTERVAL_MS` (1 s), capped at the configured poll interval. A pass that is merely IDLING — no member row and no staged invitation, i.e. nobody has admitted this party at all — re-arms on the flat poll interval and resets the ladder. `DEFAULT_REVOCATION_POLL_INTERVAL_MS` is untouched.

**Merging the two writes into one transaction was weighed and not done.** The saving is unmeasured and merging them merges their failure modes: today a redemption that lands but reports torn heals on the next pass, which sees the member row and proceeds to the binding. The hypothesis, the 27 + 18 `/cluster` baseline and the revisit condition are a `NOTE:` at the site in `doPass`. Nothing is queued for it.

## Interface changes (no backwards compat, per AGENTS.md)

- The reconciler's timer seam is `TimeoutScheduler` (`setTimeout` / `clearTimeout`) from the new `packages/cadre-core/src/timeout-scheduler.ts`, shared with the first-sync gate's probe loop, which previously carried its own identical copy under the name `FirstSyncScheduler`. Both names are gone; `@serfab/cadre-core` exports `TimeoutScheduler` and `defaultTimeoutScheduler`. The revocation enforcer's `RevocationRefreshScheduler` is a different (interval) shape and is unchanged.
- `INITIAL_JOIN_RETRY_INTERVAL_MS` is exported from `@serfab/cadre-core`.
- `StrandMembershipReconciler.start()` no longer arms a timer synchronously; the first timer appears when the first pass settles. Anything asserting "a timer exists right after `start()`" has to settle the loop first.
- `StrandMembershipReconciliationConfig.pollIntervalMs` is the IDLE cadence and the ladder's cap, not a flat retry interval.

## Review findings

Read the implement diff first, then the handoff. Checked the timer lifecycle and ladder arithmetic, pass serialization, the stop / done / terminal interactions, the kick's placement against every path that can publish a database, resource cleanup on quiesce, and every doc that describes this loop.

**Major: none.** Not "looks good" — specifically: the kick is on the only site that assigns `instance.database`, and the ordering is safe because `StrandFirstSyncGate.start()` schedules its first probe one interval out rather than probing inline, so the reconciler is always registered before the gate can publish. The founder-bootstrap-through-the-gate path (`ensureFounderBootstrap`) funnels through the same method and so is kicked too. The ladder's arithmetic matches the delays its unit test asserts, and no path leaves a timer armed after the loop stops.

**Minor, fixed in this pass:**

- **A duplicated timer seam.** The diff introduced `MembershipRetryScheduler` and its `defaultScheduler` — character for character the `FirstSyncScheduler` and `defaultScheduler` that `strand-first-sync-gate.ts` already defines, for the same purpose (an unref'd, self-rescheduling timeout seam injectable as a hand-cranked clock). Extracted to `timeout-scheduler.ts`; both loops and both specs now use it.
- **A throw out of the injected scheduler could stall the join permanently and silently.** The diff moved a call into an injected dependency (`scheduleNext` → `scheduler.setTimeout` / `clearTimeout`) into `doPass`'s `finally`, where previously only a boolean assignment lived. A throw there rejects `tail`; after that every later `reconcile()` short-circuits on the rejected chain and the loop never runs again, and the two `void`-ed call sites (`start()`, `publishDatabase`) raise an unhandled rejection. `reconcile()` now catches and logs, which makes the "never rejects" contract that `reconcile()`, `settle()` and both call sites all document structural rather than incidental. Reachability is low — it takes a throwing `setTimeout` — but the failure is the exact class this ticket exists to remove, so the invariant is worth more than the instance.
- **A test gap around stop-during-a-pass.** The one existing in-flight-stop test reaches the done state, where the re-arm declines for a different reason, so nothing covered the case that matters for `clearOwnMemberPeerBinding`: `stop()` during a pass that will NOT finish, whose `finally` still runs `scheduleNext` and must not arm a timer against an instance being torn down. Added `stop() DURING an unfinished pass leaves no timer behind`. Verified non-vacuous — with `scheduleNext`'s `stoppedFlag` guard removed it fails on a leaked 30 s timer (`expected [30000] to deeply equal []`).
- **Four stale cadence descriptions.** Six places in the tree describe this loop's cadence; the diff updated two. `docs/architecture.md` and `docs/strands.md` both still said the loop retries on the revocation-enforcer cadence, and the doc comments on `CadreNodeConfig.strandMembershipReconciliation` and `StartStrandConfig.membershipReconciliation` both still called `pollIntervalMs` the retry cadence. All four now say what it is. Also fixed the section anchor in the new `docs/strands.md` cross-reference (`#joining` did not resolve).

**Tripwires — recorded at the site, not filed as tickets:**

- The retry ladder is the DEFAULT for any pass outcome nobody classified, so a future early return added to `doPass` inherits the fast retry unless it calls `noteIdlePass`. Correct for every outcome that exists today. `NOTE:` on the `lastPassIdle` field in `strand-membership-reconciler.ts`.
- Dropping a dead invitation (expired, cancelled, consumed elsewhere) does not mark the pass idle, so the next attempt is one ladder rung away rather than a full poll interval — the asymmetry the handoff flagged. Costs one extra read per dead credential, because the pass after it does classify itself idle. Recorded as an accepted-tradeoff `NOTE:` at the `DEAD_INVITE_REJECTION` branch with its revisit condition.

**Considered and declined, or already decided — not re-filed:**

- The single-transaction variant carries an accepted-tradeoff `NOTE:` at its site with a revisit condition that has not tripped. Left alone.
- A kick arriving while a retry timer is already pending can queue one redundant pass and advance the ladder two rungs for one wall-clock period. Benign — the chain serializes it, the writes are idempotent, and the cost is one extra `Strand.Member` read — so no code changed for it.
- `backlog/bug-removed-party-cannot-redeem-its-way-back` is untouched, as the handoff says: a kick cannot restart a loop that has latched `stoppedFlag`, by design.
- `JOIN_FINISH_MS` at 20 s in the new end-to-end gate is a judgement call the handoff already argues; the observed cost is about 1 s, so the headroom is real. Accepted as written.

**Handoff gap resolved:** the handoff's "the last edit could not be re-tested" no longer holds — the build-freshness guard had cleared, and the two specs ran green before any review edit.

## Verification

- `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn workspace @serfab/cadre-core build` — all clean.
- Full `yarn workspace @serfab/cadre-core test`: **2180 passed, 1 skipped, 4 failed**. All four failures are the budget-FLOOR specs already listed in `tickets/.pre-existing-known.md` against `blocked/budget-floors-trip-while-optimystic-block-floor-work-is-in-flight` and `blocked/warm-restart-into-declared-schema-diverges-from-declaration` — costs FELL below the specs' lower bounds. Not re-reported, not touched, nothing skipped or loosened.
- Affected unit specs together (`strand-membership-reconciler`, `strand-instance-manager-membership`, `strand-first-sync-gate`, `strand-founder-bootstrap`): 66 of 66 passed.
- Integration scenarios, 24 tests all green: `blind-relay-phone-to-phone-e2e`, `strand-formation-cross-party-seed`, `strand-chat-participants-converge`, `strand-membership-closed-strand-e2e`, `strand-membership-second-machine`, `strand-party-removal-via-formation-e2e`, `strand-removal-cuts-network`, `strand-late-cadre-join`. The two scenarios that set `revocationPollMs` for the revocation ENFORCER were deliberately left alone and still pass.
- The last two edits of the review pass are comment-only (`NOTE:` blocks) and a documentation anchor. A re-run of the unit specs after them was refused by the build-freshness guard — `@optimystic/db-core` and `@optimystic/db-p2p` dist are stale again because the concurrent runner in the sibling `../optimystic` workspace edited src, the condition `.pre-existing-known.md` already records. Typecheck and lint pass on the current tree, and the non-comment diff is identical to what ran green.
