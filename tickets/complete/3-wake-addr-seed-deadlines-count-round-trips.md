description: Three of cadre's "give up reaching that machine after N seconds" limits — waking a sleeping machine, asking a machine for a workspace's network addresses, and handing a machine its setup data — now grow with the declared connection speed like the others, so a slow relayed link can use them. The two receiving sides that used to make the sender wait for slow follow-up work now reply first.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (RELAYED_REQUEST_ROUND_TRIPS, relayedRequestBudgetMs)
  - packages/cadre-core/src/strand-wake-protocol.ts (DEFAULT_WAKE_TIMEOUT_MS, WAKE_DIAL_ATTEMPTS, DEFAULT_WAKE_DIAL_BUDGET_MS, DialWakeOptions.linkRoundTripMs, processWakeRequest + startWake, handleStream + answerStream)
  - packages/cadre-core/src/strand-addr-protocol.ts (CollectStrandAddrsOptions.linkRoundTripMs, attemptTimeoutMs, handleStream + answerStream)
  - packages/cadre-core/src/seed-bootstrap.ts (SeedBootstrapConfig.linkRoundTripMs, applySeed → verifyAndMergeSeed + dialSeedOwners, handleSeedStream, readSeedFrame)
  - packages/cadre-core/src/control-stream.ts (replyAndClose)
  - packages/cadre-core/src/cadre-node.ts (pushWake; seedServiceBudgets and collectSiblingStrandAddrs helpers)
  - packages/cadre-core/src/push-fanout.ts, types.ts, index.ts
  - docs/architecture.md
----
# Wake, strand-address and seed-delivery deadlines count round trips

## What landed

`link-budget.ts` has one new count, `RELAYED_REQUEST_ROUND_TRIPS` = relayed dial (4) + one request on the open connection (2) = 6, and `relayedRequestBudgetMs(linkRoundTripMs?)`: 21 000 ms at the default 3 500 ms declaration.

| deadline | now | at default | was |
| --- | --- | --- | --- |
| one wake attempt | `relayedRequestBudgetMs(L)` | 21 s | 10 s |
| whole wake call | `WAKE_DIAL_ATTEMPTS` (2) × attempt | 42 s | 20 s |
| one strand-address attempt | `relayedRequestBudgetMs(L)` | 21 s | 10 s |
| seed delivery | `relayedRequestBudgetMs(L)` | 21 s | 10 s |

`L` is `network.linkRoundTripMs`. It reaches `dialWake` from `CadreNode.pushWake`, all four `collectStrandAddrs` sites through `collectSiblingStrandAddrs`, and all four `SeedBootstrapService` constructions through `seedServiceBudgets()`. Explicit per-call `timeoutMs` / `budgetMs` / `seedDeliverTimeoutMs` still win.

Both receivers now reply as soon as they have decided, then do the slow work:
- **Wake**: after the membership and known-strand checks, the receiver acks with the strand's status **at acceptance** and starts the wake without awaiting it. `hibernating`/`idle` in an ack means "a wake was started". A wake that fails afterwards is logged on the receiver.
- **Seed**: verify and merge, ack and close the stream, then dial the owners, then fire `onSeedApplied`. The stream stays counted against `maxConcurrentSeeds` through the dials. Public `applySeed` still runs both halves.

The implement ticket also removed `DEFAULT_ADDR_TIMEOUT_MS` and `DEFAULT_SEED_DELIVER_TIMEOUT_MS`, because nothing read them once each call derives its default.

## Review findings

Read the diff of `ticket(implement): wake-addr-seed-deadlines-count-round-trips` before the handoff. Also read the original implement ticket's plan, `docs/architecture.md`'s changed sections, `hibernation-manager.ts` (`wakeStrand`/`beginWake`), and every consumer of `WakeAck.status`.

**Correctness: checked, nothing wrong found.**
- Seed handler: I traced every path against the `acked` flag. Over the cap: one reply and close, then return. Read timeout, malformed frame, or a throwing `onSeedReceived`: not acked yet, so the catch sends one error reply and closes. Rejected seed: one reply, then `onSeedError`. Accepted seed: one reply, then the owner dials, then `onSeedApplied`. A throw after the ack: the catch fires `onSeedError` and writes nothing. Each path closes the stream exactly once and writes at most one frame. The reply helper never throws, so setting `acked` before it is safe.
- `dialSeedOwners` returns zero counts when the service shut down between the merge and the dials. I accepted this as the right report for `applySeed`'s direct callers: it says no dial was attempted, which is true. The old code attempted each dial, hit a `TypeError` per owner, and counted it as failed, which was noise. The window only exists when a caller shuts the service down during its own `applySeed`.
- Wake: `status` is read before `startWake` runs, so the ack cannot show a status the wake set part-way through. `HibernationManager.wakeStrand` coalesces with an activity-driven wake through `beginWake`, so a push-wake racing a local wake builds once. `ack.status` is read nowhere in `src` except a log line: `push-fanout` only needs "did the peer answer", and the reference apps never read it.
- Deadline derivation: `relayedRequestBudgetMs` goes through `resolveLinkRoundTripMs`, which rejects an invalid declaration. `dialWake` derives its total from the attempt deadline when only `timeoutMs` is given, which matches `controlDialBudget`'s override shape.
- Receiver-side `*_READ_TIMEOUT_MS` (10 s) were left as they were. The plan put them out of scope, and `link-deadline-literal-lint-gate` classifies them.

**DRY / error handling: one minor finding, fixed.** The implementer added a `replyAndClose` helper that was private to `seed-bootstrap.ts`. The wake and strand-address receivers still had the same write-then-close code twice each, with empty `catch {}` blocks that swallowed errors silently, which AGENTS.md forbids. I moved `replyAndClose(stream, reply, label)` into `control-stream.ts` beside `writeFrame` and `exchangeFrame`, where it now logs both failures, and made all three receivers use it. The wake and strand-address `handleStream` methods now split into the concurrency cap, a reply, and a private `answerStream` that reads and decides, turning any failure into the non-accepting reply. One behaviour change: if writing a successful reply throws, it is now logged instead of being followed by a second attempt to write an error reply on the same broken stream. The existing framing tests (`strand-wake-protocol.spec.ts`, `strand-addr-protocol.spec.ts` handler cases) cover these paths and pass unchanged.

**Tests: checked, none added or cut.** The two new ordering tests ("gets the ack while the wake is still running", "gets the ack while the receiver is still dialing the seed owners") each pin the one new contract, reply before the slow work, and the implementer showed they fail when that order is reverted. The updated tests assert the status at acceptance, and `cadre-node.spec.ts` and `push-wake-e2e` then wait until the receiver is `active`, so the wake is still checked end to end. Nothing restates the implementation or only verifies a mock.

**Docs: checked, current.** `docs/architecture.md` covers the seed ack-before-dials order, push-wake mechanism 3 (reply at acceptance, derived numbers), "Dial budgets are counted in round trips", and the known-limits bullet (only `COHORT_READ_DEADLINE_MS` is left, plus the formation and relay-admission pointer). I found no remaining "10 s" or "20 s" for these three deadlines in `docs/`. One stale board reference was fixed: `debt-cadre-deadlines-sized-against-old-optimystic-bounds`'s `files:` header named the removed `DEFAULT_SEED_DELIVER_TIMEOUT_MS`. The mention in `link-deadline-literal-lint-gate` is historical and correct, so I left it.

**Tripwires (the implementer's; I checked they are placed and worded correctly):** membership read inside the wake and strand-address exchanges (`DEFAULT_WAKE_TIMEOUT_MS`, `attemptTimeoutMs`); TOFU confirmation inside the seed exchange (`handleSeedStream`); platform-push fallback waiting up to 42 s (`push-fanout.ts` `wakePeer`); no transfer allowance for large seeds (`SeedBootstrapConfig.seedDeliverTimeoutMs`); per-owner serial dials holding a `maxConcurrentSeeds` slot (documented on `handleSeedStream`; same bound as before, and the sender is no longer held). I added none.

**Performance / resource cleanup: checked, nothing wrong found.** Detached wakes are bounded by the strands this node participates in (unknown strands are refused, and wakes coalesce per strand). This is documented on `maxConcurrent`. Seed and wake streams are closed before any slow work, and nothing opened in the new code outlives its handler except the detached wake, which `HibernationManager` owns.

**Validation.** `yarn workspace @serfab/cadre-core typecheck`: clean. `yarn lint`: clean. `yarn workspace @serfab/cadre-core test`: 146 files, 2359 passed, 1 skipped (the skip predates this ticket). I did not re-run the integration scenarios after the receiver refactor. The implementer ran `push-wake-e2e`, `deliver-seed-cross-network` and `strand-addr-seed-convergence` against the pre-refactor build. The refactor keeps the wire behaviour the same, and the unit framing tests use real duplex streams. No test measures a relayed exchange at a 3-second round trip; the derivation relies on the counts measured in `link-budget.ts`.
