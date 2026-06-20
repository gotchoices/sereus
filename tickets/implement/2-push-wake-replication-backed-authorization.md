description: Upgrade the push-wake tests so a node learns who its fellow members are by syncing the shared membership store over the network — the real production path — instead of being hand-fed those facts locally as the tests do today.
prereq: control-db-two-node-convergence-test
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (header lines 23-45, makeOwnAuthority ~154-160, seedReceiverRecord ~168-184, scenarios ~210-375), packages/integration-tests/src/harness/test-network.ts (new waitForCrossNodeControlSync from prereq), packages/cadre-core/src/strand-wake-protocol.ts (processWakeRequest/isMember gate ~70-93,207-230), packages/cadre-core/src/cadre-node.ts (isMember/resolvePeerAddrs/getSeedBootstrapService/authorizePeer)
difficulty: medium
----

## Background

`push-wake-e2e.integration.ts` currently proves the wake **wire path** but NOT control-DB replication. Its header (lines 23-45) is explicit: because cross-node control reads did not converge, each node is made **its own authority** and membership facts are **seeded locally on the node that consults them**:

- `seedReceiverRecord` — the **dialer** authority-signs + inserts the *receiver's* self-signed `CadrePeer` record into the **dialer's own** control DB so `dialer.resolvePeerAddrs(rx)` passes (`push-wake-e2e.integration.ts:168-184`).
- The **receiver** calls `Rx.authorizePeer(senderPeerId)` into its **own** DB so `Rx.isMember(sender)` is true (scenario 1 line 241; scenario 3 deliberately omits it to prove rejection).

The production path is different: membership is written **once on the authority node** and **replicates** to the receiver, which then reads the *sibling-written* row to authorize the wake (`StrandWakeService.processWakeRequest` → `isMember` reads the local control DB — `strand-wake-protocol.ts:207-230`). The prereq ticket (`control-db-two-node-convergence-test`) proves that replication works over a directly-connected control pair. This ticket uses that proof to make at least one push-wake scenario **replication-backed** end-to-end.

## What this ticket builds

Add a **replication-backed authorization** push-wake scenario (alongside, not replacing, the existing locally-seeded ones — keep those as fast wire-path coverage). In the new scenario:

- Use **one authority node** (or designate node A as the cadre authority) that writes the membership facts: `authorizePeer(senderPeerId)` and the receiver's `CadrePeer` address record — **only** on the authority's control DB.
- Establish the direct control connection + both-sides wait recipe from the prereq so the control collections' cohort forms across the authority, sender, and receiver.
- **Wait for convergence** on the *receiver's* control DB using `waitForCrossNodeControlSync` (from the prereq) — assert `Rx.getControlDatabase().queryCadrePeers()` shows the sender, and `await Rx.isMember(senderPeerId) === true`, **without** any local `Rx.authorizePeer(...)` call.
- Then run the real wake: `pushWake` → `resolvePeerAddrs` → `dialWake`, and assert the strand wakes. This proves the `isMember` gate passes via **replication**, not local seeding.

Where the sender resolves the receiver's address, likewise rely on the receiver's self-published record having **replicated** to the sender (sender reads a sibling-written `CadrePeer` row), rather than `seedReceiverRecord`.

### Expected outputs (TDD)

- Replication-backed scenario: after convergence, `Rx.isMember(sender) === true` and `S.resolvePeerAddrs(rx).length > 0` with **no** local seeding on the consulting node; wake ack accepted; strand transitions awake.
- Negative case preserved: a non-member `O` whose `CadrePeer` row was never written on the authority (so it cannot converge anywhere) is rejected — `Rx.isMember(O) === false`, wake rejected.

## Edge cases & interactions

- **Convergence timing vs the wake:** the wake must run *after* the receiver has converged on the sender's membership. Gate the wake behind `waitForCrossNodeControlSync` (poll), never a fixed sleep.
- **Three-node cohort (authority + sender + receiver):** ensure all three are connected so the control collections' cohort spans them; a missing direct link can leave one node unable to pull the membership block (see prereq's cohort/local-only notes).
- **Self-published address record must replicate:** the receiver's `resolvePeerAddrs`-resolvable record requires the receiver to **self-publish** (`registerSelf`) AND that row to converge to the sender. Account for the authority-insert-then-self-refresh sequence (`cadre-node.ts:594-631`): the first row needs an authority insert; if the authority is a different node, the receiver may only be able to self-*update* after its row exists — verify the ordering converges, or have the receiver be its own authority for its self-record while the *authority* vouches membership. Document whichever ordering you pick.
- **Relay path (scenario 2 analog):** if you also cover the NAT/relay topology, confirm a usable (possibly relayed) dial path post-convergence; relay-only links may not seat control cohort membership (see prereq) — keep the replication-backed assertion on a topology where the cohort provably forms.
- **Do not regress the wire-path scenarios:** the existing locally-seeded scenarios stay; this adds coverage. Keep total runtime within the idle-timeout window.
- **Honest handoff:** if replication-backed convergence proves too timing-sensitive to be non-flaky in CI, keep the locally-seeded scenarios green and mark the replication-backed one `it` with generous timeouts (or `it.todo` with a precise note) rather than shipping a flaky test — and say so in the review handoff.

## TODO

- Land `control-db-two-node-convergence-test` first (provides `waitForCrossNodeControlSync` + the proven connect/poll recipe).
- Add a replication-backed authorization scenario to `push-wake-e2e.integration.ts` (or a sibling file) that writes membership only on the authority, waits for the receiver to converge, then runs the real wake.
- Assert `isMember`/`resolvePeerAddrs` pass via convergence (no local seeding on the consulting node); preserve the negative non-member rejection.
- Keep the existing locally-seeded scenarios; update the file header to note that replication-backed authorization is now exercised (and by which scenario).
- Run the push-wake suite; type-check + lint.
