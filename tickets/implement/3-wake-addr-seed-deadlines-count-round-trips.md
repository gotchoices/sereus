description: Make three of cadre's "give up reaching that machine after N seconds" limits — waking a sleeping machine, asking a machine for a workspace's network addresses, and handing a machine its setup data — grow with the declared connection speed like the others already do, so a deployment on a slow relayed link can use all of them. Two of the receiving sides also stop making the sender wait for slow follow-up work before replying.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (new round-trip count + helper; module doc "What still fails" list)
  - packages/cadre-core/src/strand-wake-protocol.ts (DEFAULT_WAKE_TIMEOUT_MS, DEFAULT_WAKE_DIAL_BUDGET_MS, DialWakeOptions, StrandWakeService.processWakeRequest/handleStream)
  - packages/cadre-core/src/strand-addr-protocol.ts (DEFAULT_ADDR_TIMEOUT_MS, CollectStrandAddrsOptions, dialOneSibling NOTE)
  - packages/cadre-core/src/seed-bootstrap.ts (DEFAULT_SEED_DELIVER_TIMEOUT_MS, SeedBootstrapConfig, applySeed split, handleSeedStream, owner-dial NOTE at ~line 816)
  - packages/cadre-core/src/cadre-node.ts (pushWake ~7290; collectStrandAddrs call sites ~5998, 6184, 6208, 6375; SeedBootstrapService construction sites ~7069, 7318, 7585, 7780)
  - packages/cadre-core/src/push-fanout.ts (wakePeer — tripwire NOTE only)
  - packages/cadre-core/src/types.ts (WakeAck.status doc ~1943)
  - packages/cadre-core/src/index.ts (export the new link-budget helper beside the others ~524)
  - packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/cadre-node.spec.ts (~921), packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/link-budget.spec.ts
  - docs/architecture.md (Relay Integration → "Dial budgets are counted in round trips, not milliseconds" ~1118; Push wake mechanism 3 ~778; seed sender hardening ~392; strand-addr section ~542)
----
# Wake, strand-address and seed-delivery deadlines count round trips

## Background

`NetworkConfig.linkRoundTripMs` (default 3500 ms) is one declared assumption about how long a message takes to reach another machine and come back over the path they actually use, through a relay when that is the only path. `packages/cadre-core/src/link-budget.ts` holds how many of those round trips each operation was measured to cost and derives deadlines from it: a relayed dial is 4 (`RELAYED_DIAL_ROUND_TRIPS`), one request and its answer over an already-open connection is 2 (`CIRCUIT_REQUEST_ROUND_TRIPS`: protocol negotiation plus the exchange). Sereus supports relayed links up to a 3-second round trip.

Three sender-side deadlines each bound "open a connection, possibly relayed, then one request and its answer", and are still fixed at 10 000 ms. That cannot open a relayed connection above a 2.5-second round trip, so at the supported link these three paths fail and the other machine looks absent:

| constant | file | bounds |
| --- | --- | --- |
| `DEFAULT_WAKE_TIMEOUT_MS` (10 000) and `DEFAULT_WAKE_DIAL_BUDGET_MS` (20 000 = two attempts) | `strand-wake-protocol.ts` | one wake attempt; the whole wake call |
| `DEFAULT_ADDR_TIMEOUT_MS` (10 000) | `strand-addr-protocol.ts` | one attempt to ask a sibling for its strand addresses |
| `DEFAULT_SEED_DELIVER_TIMEOUT_MS` (10 000) | `seed-bootstrap.ts` | the whole seed delivery (dial, write, ack read) |

The receiver-side `*_READ_TIMEOUT_MS` constants beside them are caps on how long an inbound frame may take and are out of scope (the lint gate ticket that follows classifies them).

## Design

### One new count in `link-budget.ts`

Add the operation "open a connection that may need a relay, then one request and its answer over it":

```ts
/** RELAYED_DIAL_ROUND_TRIPS + CIRCUIT_REQUEST_ROUND_TRIPS: a fresh relayed connection plus one exchange on it. */
export const RELAYED_REQUEST_ROUND_TRIPS = RELAYED_DIAL_ROUND_TRIPS + CIRCUIT_REQUEST_ROUND_TRIPS; // 6

/** Deadline for opening a (possibly relayed) connection and completing one small request on it. */
export function relayedRequestBudgetMs(linkRoundTripMs?: number): number; // 6 × resolved → 21 000 ms at the default
```

No transfer allowance: wake and strand-address frames are capped at 64 KiB and are a few hundred bytes in practice; a seed is a peer list of a few KB (its 1 MiB `MAX_SEED_SIZE` is a defensive cap). Add a `NOTE:` tripwire on the seed deadline: if seeds ever grow toward that cap, add a transfer allowance the way `PUSH_TRANSFER_ALLOWANCE_MS` does. Add the new count to the module doc's table and export the helper from `index.ts` beside the others. Update the module doc's "What still fails" bullet: these three no longer belong there; `COHORT_READ_DEADLINE_MS` stays and now points at `debt-cadre-deadlines-sized-against-old-optimystic-bounds` (which took that arm); add a pointer to `debt-formation-and-relay-admission-deadlines-ignore-the-declared-link` for the formation and relay-admission deadlines found while planning this.

### Both receivers that did slow work before replying now reply first

A deadline can only be counted in round trips if it contains only link work. Two of these three exchanges today also contain the RECEIVER's slow follow-up work, which is not link work and is bounded by the receiver's own (larger, also derived) budgets:

- **Wake.** `StrandWakeService.processWakeRequest` awaits `wake()` before the ack is written. For a quiesced strand that is `CadreNode.handleStrandWake` → `resumeStrandRuntime`: a strand-address collection from siblings, a strand libp2p node build, and `awaitFirstRelayAttempts` — a relay reservation drive budgeted at 4 round trips (14 s at the default). Counting that into the sender's attempt would make one attempt about 12 round trips (42 s) and couple the sender's deadline to the receiver's configuration.
- **Seed.** `handleSeedStream` acks only after `applySeed`'s owner-dial loop, which can take `dialBudget.totalMs` (56 s at the default) per unreachable owner. The existing `NOTE:` at `seed-bootstrap.ts` ~816 already proposes acking before dialing.

Decision: **both receivers reply once they have decided, then do the slow work.**

- Wake: the receiver still gates on membership and on the strand being known, replies `{ accepted: true, status }` where `status` is the strand's status **at acceptance** (so `hibernating`/`idle` means "a wake was started", not "the strand is now up"), and then starts the wake without awaiting it: `void this.options.wake(strandId).catch(err => log(...))`. That makes a push-wake the same as an activity-driven local wake, which `HibernationManager.beginWake` already treats as fire-and-forget and coalesces per strand. Update `WakeAck.status`'s doc in `types.ts` and the architecture doc's push-wake paragraph. Nothing reads `ack.status` except a log line and tests: `push-fanout.ts` only needs "was the peer reachable", which is unchanged. A wake that fails after acceptance is now logged on the receiver instead of being returned as `accepted: false`; `push-fanout` only logs that value today, so no caller changes behaviour.
- Seed: split `SeedBootstrapService.applySeed` into its verify-and-merge half and its owner-dial half (two private methods; small single-purpose functions per AGENTS.md). Public `applySeed` still runs both and returns the same `ApplySeedResult` (owner-dial counts included) for its direct callers (`CadreNode.applySeed`). `handleSeedStream` runs verify-and-merge, writes the ack **and closes the stream**, then runs the owner dials, then emits `onSeedApplied`/`onSeedError` as today, so `CadreNode`'s ordering (it keeps owner-flagged peers as cold-start dial targets in `onSeedApplied`) is unchanged. Keep the stream counted in `activeStreams` through the owner dials so the concurrency cap still bounds concurrent owner-dial phases. Replace the owner-dial `NOTE:` with a one-line statement that the ack precedes the dials and why.

The stream close before the slow work is load-bearing: the sender reads the reply to end-of-stream (`readStreamToEnd` inside `exchangeFrame`), so an ack written on a stream that stays open does not reach the caller until the stream closes.

### The derived deadlines

| deadline | derivation | at the default (3500 ms) | was |
| --- | --- | --- | --- |
| one wake attempt | `relayedRequestBudgetMs(L)` | 21 000 ms | 10 000 |
| whole wake call | `WAKE_DIAL_ATTEMPTS` (2, new constant in `strand-wake-protocol.ts`, following `CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS` in `peer-dial.ts`) × the attempt deadline | 42 000 ms | 20 000 |
| one strand-address attempt | `relayedRequestBudgetMs(L)` | 21 000 ms | 10 000 |
| seed delivery | `relayedRequestBudgetMs(L)` | 21 000 ms | 10 000 |

Notes per site, to carry into the doc comments:

- **Wake.** Keep the module constants as the default-declaration values, written as calls (`export const DEFAULT_WAKE_TIMEOUT_MS = relayedRequestBudgetMs();`, `DEFAULT_WAKE_DIAL_BUDGET_MS = WAKE_DIAL_ATTEMPTS * DEFAULT_WAKE_TIMEOUT_MS`), the idiom `peer-dial.ts` and `relay-reservation.ts` already use. `DialWakeOptions` gains `linkRoundTripMs?: number`; `dialWake` resolves `perAddressMs = options.timeoutMs ?? relayedRequestBudgetMs(options.linkRoundTripMs)` and `totalMs = options.budgetMs ?? WAKE_DIAL_ATTEMPTS * perAddressMs` — the same override shape as `CadreNode.controlDialBudget()`, so the tests that pass a low `budgetMs` keep working. `CadreNode.pushWake` passes `{ linkRoundTripMs: this.config.network?.linkRoundTripMs }`. Update the 20 s rationale in `DEFAULT_WAKE_DIAL_BUDGET_MS`'s doc comment: the reasoning (two genuine attempts) stands, the number becomes derived.
- **Strand address.** One attempt is either a dial by peer id (normally reusing an open control connection: 2 round trips) or a fallback to the sibling's control addresses (a fresh, possibly relayed dial: 6). One deadline covers both, so it is sized for the fallback. `CollectStrandAddrsOptions` gains `linkRoundTripMs?`; `timeoutMs` still wins. All four `collectStrandAddrs` call sites in `cadre-node.ts` pass the declaration — route them through one small private helper so they cannot drift. Update the `dialOneSibling` `NOTE:` (cost is targets × attempt deadline, now 21 s each at the default; siblings are asked concurrently, so a collection costs the slowest sibling, not the sum).
- **Seed.** `SeedBootstrapConfig` gains `linkRoundTripMs?`; `seedDeliverTimeoutMs` still wins; the default becomes `relayedRequestBudgetMs(config.linkRoundTripMs)`. The four `new SeedBootstrapService({...})` sites in `cadre-node.ts` already share `dialBudget: this.controlDialBudget()`; fold that and `linkRoundTripMs` into one private helper they all spread. State in the doc comment that seed delivery does not set `runOnLimitedConnection` and so does not use a limited relayed connection today; the relayed-dial count is the upper bound on the dial it can use, the same choice `controlDialBudget` makes for every address.

Do not add new `NetworkConfig` fields: the declaration is the setting. The per-call options stay for tests.

## Edge cases & interactions

- **Ack-first ordering (wake and seed).** Reply written, stream closed, and only then the slow work. Verified by the two tests below.
- **Wake rejected paths unchanged.** Non-member, unknown strand, over the concurrency cap, malformed or oversized frame, read timeout: each still replies `accepted: false` and never starts a wake. Already-live strand: accepted with its live status and no wake call, as today. Verified by the existing decision-matrix tests, updated only where they assert post-wake status.
- **Detached wake failures.** The detached promise must be `void`-prefixed with a `.catch` that logs (`no-floating-promises` is enforced for src). Verified by lint.
- **Wakes in flight at shutdown.** A detached push-wake running while the node stops is the same situation as an activity-driven wake at shutdown, which already exists; `HibernationManager` coalesces and `StrandInstanceManager.trackRuntimeBuild` tracks the build. Verified by inspection; no new handling.
- **Concurrent wakes.** Once the reply is sent, detached wakes are no longer counted by `maxConcurrent`. They are bounded by the number of strands this node participates in, because `beginWake` coalesces per strand and unknown strands are rejected before any wake starts. Say so in the `maxConcurrent` doc. Verified by inspection.
- **Seed rejected before merge.** Untrusted signer, bad signature, not initialised: ack `accepted: false`, no owner dials, `onSeedError` — as today.
- **Seed owner dial throws after the ack.** Already caught per owner and counted; the handler's outer `catch` must not try to write a second ack on the closed stream. Verified by inspection.
- **Public `applySeed` result.** Unchanged shape and counts for direct callers. Verified by the existing seed tests passing unchanged.
- **Receiver membership check is still inside the exchange.** The wake and strand-address receivers call `isMember` → `CadreNode.isAuthorizedMember` → a control database read before replying. A read that consults a silent cohort peer can take up to `COHORT_READ_DEADLINE_MS` (5 s). That is a read deadline, owned by `debt-cadre-deadlines-sized-against-old-optimystic-bounds`; do not count it here. Leave a one-line `NOTE:` on the derived attempt deadline naming it.
- **TOFU seed trust.** A receiver configured with an interactive trust-on-first-use policy asks a human before acking, and that wait is inside the sender's deadline (10 s today, 21 s after). It is not link time and is pre-existing. Leave a `NOTE:` tripwire at `handleSeedStream`: if TOFU is used on the wire path, ack "pending" or move confirmation out of the exchange.
- **Push fan-out waits longer before falling back.** `push-fanout.ts` tries a direct `pushWake` and falls back to FCM/APNs only when it throws. A suspended phone typically fails its relay address fast and burns the rest of the budget on its direct address, so the platform-push fallback now waits up to about 42 s at the default instead of 20 s. This is the cost of the supported link. Leave a `NOTE:` tripwire at `wakePeer`: if the delay shows up, start the platform push in parallel with the direct dial, or after one attempt.
- **Invalid declaration.** `relayedRequestBudgetMs` goes through `resolveLinkRoundTripMs`, which throws on a non-finite or non-positive value; `CadreNode.start()` already calls it eagerly, so no new validation is needed. Verified by inspection.
- **A machine declaring a different link than its peers.** Already documented in `link-budget.ts` ("What still fails"); nothing new.

## Tests

Default is no new test. Two contract tests pin the one piece of behaviour that is new and easy to regress, the reply order:

- `strand-wake-protocol.spec.ts`: a receiver whose `wake` never resolves still produces `{ accepted: true, status: 'hibernating' }` for the sender, and `wake` was called once.
- `seed-bootstrap.spec.ts`: a receiver whose owner dial hangs still delivers `accepted: true` to the sender (use the existing stream-pair harness in that file or `test/wake-stream-helpers.ts`).

Update, don't add: the wake decision-matrix, framing and `dialWake` round-trip cases, plus `cadre-node.spec.ts` "pushWake dials the target and a hibernating receiver transitions to active", which assert the post-wake `status: 'active'`. They should now expect the status at acceptance, and where they check that the receiver ends up `active`, await the detached wake. In `link-budget.spec.ts`, add the new helper as one more expectation in the existing "multiplies each operation's round-trip count" case; no new `it`.

## TODO

- Add `RELAYED_REQUEST_ROUND_TRIPS` and `relayedRequestBudgetMs` to `link-budget.ts`, export from `index.ts`, and update the module doc table and the "What still fails" list.
- Wake: derive the two defaults, add `WAKE_DIAL_ATTEMPTS`, add `linkRoundTripMs` to `DialWakeOptions`, and resolve `timeoutMs`/`budgetMs` as above; reply before waking in `processWakeRequest`/`handleStream`; update `WakeAck.status` doc; thread the declaration in `CadreNode.pushWake`.
- Strand address: derive the default, add `linkRoundTripMs` to `CollectStrandAddrsOptions`, route the four `cadre-node.ts` call sites through one helper, update the `dialOneSibling` NOTE.
- Seed: derive the default, add `linkRoundTripMs` to `SeedBootstrapConfig`, split `applySeed`, ack and close before the owner dials in `handleSeedStream`, replace the owner-dial NOTE, and fold the four construction sites' shared options into one helper.
- Leave the three `NOTE:` tripwires: the membership read on the derived attempt deadlines, TOFU at `handleSeedStream`, and the fallback delay at `push-fanout.ts` `wakePeer`.
- Update `docs/architecture.md`: the "Four cadre deadlines are still fixed milliseconds" bullet (~1131; it becomes one deadline, the cohort read deadline, pointing at `debt-cadre-deadlines-sized-against-old-optimystic-bounds`, plus a pointer to `debt-formation-and-relay-admission-deadlines-ignore-the-declared-link`), the derived list in "Dial budgets are counted in round trips", the push-wake paragraph (derived numbers, reply at acceptance), the seed sender-hardening bullet (derived default, ack before owner dials), and the strand-address section if it states 10 s.
- Update and add the tests listed above.
- Run `yarn workspace @serfab/cadre-core test`, `yarn workspace @serfab/cadre-core typecheck`, and `yarn lint` in the foreground.
