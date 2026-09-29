description: Three of cadre's "give up reaching that machine after N seconds" limits — waking a sleeping machine, asking a machine for a workspace's network addresses, and handing a machine its setup data — now grow with the declared connection speed like the others, so a slow relayed link can use them. The two receiving sides that used to make the sender wait for slow follow-up work now reply first.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (RELAYED_REQUEST_ROUND_TRIPS, relayedRequestBudgetMs; module doc table + "What still fails")
  - packages/cadre-core/src/strand-wake-protocol.ts (DEFAULT_WAKE_TIMEOUT_MS, WAKE_DIAL_ATTEMPTS, DEFAULT_WAKE_DIAL_BUDGET_MS, DialWakeOptions.linkRoundTripMs, processWakeRequest + startWake)
  - packages/cadre-core/src/strand-addr-protocol.ts (CollectStrandAddrsOptions.linkRoundTripMs, attemptTimeoutMs, dialOneSibling NOTE)
  - packages/cadre-core/src/seed-bootstrap.ts (SeedBootstrapConfig.linkRoundTripMs, applySeed → verifyAndMergeSeed + dialSeedOwners, handleSeedStream, readSeedFrame, replyAndClose)
  - packages/cadre-core/src/cadre-node.ts (pushWake; seedServiceBudgets and collectSiblingStrandAddrs helpers; announceDelegateToRelay NOTE arithmetic)
  - packages/cadre-core/src/push-fanout.ts (wakePeer tripwire NOTE)
  - packages/cadre-core/src/types.ts (WakeAck.status doc)
  - packages/cadre-core/src/index.ts (exports)
  - packages/cadre-core/test/strand-wake-protocol.spec.ts, seed-bootstrap.spec.ts, cadre-node.spec.ts, link-budget.spec.ts
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
  - docs/architecture.md (seed receiver/sender hardening bullets, push wake mechanism 3, "Dial budgets are counted in round trips", known limits)
----
# Wake, strand-address and seed-delivery deadlines count round trips

## What changed

`link-budget.ts` gains one count: `RELAYED_REQUEST_ROUND_TRIPS` = relayed dial (4) + one request on the open connection (2) = 6, and `relayedRequestBudgetMs(linkRoundTripMs?)` (21 000 ms at the default 3 500 ms declaration). Exported from `index.ts`.

| deadline | now | at default | was |
| --- | --- | --- | --- |
| one wake attempt | `relayedRequestBudgetMs(L)` | 21 s | 10 s |
| whole wake call | `WAKE_DIAL_ATTEMPTS` (2) × attempt | 42 s | 20 s |
| one strand-address attempt | `relayedRequestBudgetMs(L)` | 21 s | 10 s |
| seed delivery | `relayedRequestBudgetMs(L)` | 21 s | 10 s |

`L` is `network.linkRoundTripMs`, threaded through: `CadreNode.pushWake` → `DialWakeOptions.linkRoundTripMs`; all four `collectStrandAddrs` sites → private `collectSiblingStrandAddrs`; all four `new SeedBootstrapService` sites spread private `seedServiceBudgets()` (`dialBudget` + `linkRoundTripMs`). Explicit `timeoutMs` / `budgetMs` / `seedDeliverTimeoutMs` still win (tests use them).

**Reply-first receivers:**
- **Wake** (`StrandWakeService.processWakeRequest`): after the membership and known-strand gates, it reads the status, starts the wake with `void wake().catch(log)` (`startWake`), and returns `{ accepted: true, status }`, where `status` is the status **at acceptance**. `hibernating`/`idle` in an ack now means "a wake was started". A wake that fails after acceptance is logged on the receiver.
- **Seed** (`handleSeedStream`): `applySeed` is split into `verifyAndMergeSeed` (signature, trust, peer-store merge; all rejections) and `dialSeedOwners`. The handler runs verify-and-merge, then `replyAndClose` (write the ack, close the stream), then the owner dials, then `onSeedApplied`/`onSeedError`. The stream stays counted in `activeStreams` through the dials. An `acked` flag stops the outer `catch` from writing a second ack. Public `applySeed` still runs both halves and returns the same `ApplySeedResult`.

Tripwire `NOTE:`s left: membership read (`COHORT_READ_DEADLINE_MS`) inside the wake and strand-address exchanges (on `DEFAULT_WAKE_TIMEOUT_MS` and `attemptTimeoutMs`); TOFU confirmation inside the seed exchange (`handleSeedStream`); platform-push fallback now waiting up to 42 s (`push-fanout.ts` `wakePeer`); no transfer allowance for seeds (`seedDeliverTimeoutMs` doc).

## Deviations from the plan — check these

- **No `DEFAULT_ADDR_TIMEOUT_MS` / `DEFAULT_SEED_DELIVER_TIMEOUT_MS` constants any more.** Once each call derives the default, nothing read them, and `no-unused-vars` fails on an unused module-level const. The strand-address default lives in `attemptTimeoutMs(options)` (with the NOTE), and the seed default is set in the constructor (documented on `SeedBootstrapConfig.seedDeliverTimeoutMs`). `DEFAULT_WAKE_TIMEOUT_MS` is kept and exported, as the plan asked, because `DEFAULT_WAKE_DIAL_BUDGET_MS` reads it. The plan ticket `debt-cadre-deadlines-sized-against-old-optimystic-bounds` still names `DEFAULT_SEED_DELIVER_TIMEOUT_MS` in its `files:` header, and that name is now stale.
- **Wake: the start comes before the ack is written, not after.** `startWake` runs inside `processWakeRequest`, so `wake()`'s synchronous prefix (in the real path, `HibernationManager.clearTimers` plus a map lookup) runs before `handleStream` writes the frame. Nothing awaits it. A `wake` that throws *synchronously* (not possible for an `async` implementation) would turn into an `accepted: false` ack through `handleStream`'s catch.
- **Seed callback timing moved.** `onSeedError` on a rejected seed now fires after the ack instead of before. On the success path, a failed ack write is now logged and the seed still proceeds to `onSeedApplied`. Before, it emitted `onSeedError` for a seed that had in fact been applied.
- `announceDelegateToRelay`'s NOTE in `cadre-node.ts` quoted the old 10 s strand-address timeout. Its arithmetic is updated: 2 × 21 s + 14 s drive = 56 s held per failed re-drive against a down relay (was 34 s).

## Tests

Added:
- `strand-wake-protocol.spec.ts` "gets the ack while the wake is still running": the receiver's `wake` never settles, and the sender still gets `{ accepted: true, status: 'hibernating' }` within a 1 s attempt deadline, with `wake` called once.
- `seed-bootstrap.spec.ts` "gets the ack while the receiver is still dialing the seed owners": a signed seed with one owner peer, and a receiver whose owner dial is held open. The sender gets `accepted: true` within a 1 s delivery deadline, and `onSeedApplied` has not fired yet. After the dial is released, the handler finishes, the owner address was dialed, and `onSeedApplied` fired with 1.
- Mutation-checked: making each receiver await its slow work again (wake awaited; handler calling `applySeed` before the ack) fails both tests with a timeout.

Updated (they had asserted the post-wake `status: 'active'`):
- Wake decision matrix (hibernating → `'hibernating'`, idle → `'idle'`), the framing round-trip, and the `dialWake` round-trip.
- `cadre-node.spec.ts` "pushWake dials the target…": the ack is `'hibernating'`, then `vi.waitFor` waits until the receiver is `active`.
- `push-wake-e2e.integration.ts`: the two hibernating-strand wakes expect `'hibernating'`, then wait (new `awaitPushedWake`, 30 s cap) for `active`. The relayed-wake case wakes an already-active strand and is unchanged.
- `link-budget.spec.ts`: `relayedRequestBudgetMs` added to the existing "multiplies each operation's round-trip count" case.

## Validation run

- `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core test`: 146 files, 2359 passed, 1 skipped (pre-existing skip).
- Against a fresh `@serfab/cadre-core` build: `push-wake-e2e` (4/4), `deliver-seed-cross-network` (5/5), `strand-addr-seed-convergence` (1/1).
- **Not run:** the full integration suite, and anything at an actual slow link. Nothing here measures a relayed exchange at 3 s. The derivation relies on the existing counts in `link-budget.ts`.

## Review focus

- Is the seed handler's `acked` flag plus `replyAndClose` correct on every path? The paths are: over the cap, read timeout, malformed frame, rejected seed, accepted seed, and a throw after the ack. Each should close the stream exactly once and write at most one ack.
- `dialSeedOwners` returns zero counts if the service shut down between the merge and the dials. The old code would have hit a `TypeError` per owner, caught and counted as failed. Decide whether that is the right report for `applySeed`'s direct callers.
- A seed stream is now held through up to `dialBudget.totalMs` per owner, serially, while it counts against `maxConcurrentSeeds` (100). That was true before as well, but the sender used to be held for the same time; now only the receiver's slot is.
