description: When one machine in a group is connected but slow or unresponsive, shared-settings changes made on another machine can now be blocked by it. Write a test that measures what actually happens, so we know whether it fails cleanly or freezes.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (new), packages/integration-tests/src/harness/forced-cluster.ts (new), packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md
difficulty: hard
----

# Coverage: control writes with a connected-but-degraded party member

The control database (shared settings + membership) replicates every block to the whole party
(`CONTROL_REPLICATION_BREADTH` = 16, effectively "everyone"). A control write commits only when a
super-majority of the **cohort** — the peers the block was offered to — approves. Because the
cohort is now the whole party, a member that is *connected but degraded* (slow, packet-losing,
mid-relay-reconnect) sits inside the cohort and counts against the bar. At the previous replication
breadth of two, that member would usually have been outside the cohort and simply ignored.

Nobody has measured what that costs. This ticket is the measurement.

**Not the same as `debt-control-db-offline-peer-no-hang-coverage` (complete).** That covers members
that are *unreachable* — they never enter the cohort, and the write commits alone. This one is
about members that *do* enter the cohort.

## What the write path does (established by reading it — do not re-derive)

Paths below live in the sibling reference workspace `../optimystic` unless prefixed `packages/`.

`ControlDatabase` → Quereus → `NetworkTransactor` → `CoordinatorRepo` → `ClusterCoordinator`.

1. **No phase-level timeout in the coordinator.** `ClusterCoordinator.collectPromises`
   (`packages/db-p2p/src/repo/cluster-coordinator.ts:460`) fans out to every cohort peer and does a
   bare `Promise.all`. Each peer's failure is caught per-peer into `null`, so a *failing* peer only
   costs an approval — but a peer that never settles at all would hang the phase forever. Nothing
   at this layer bounds it.
2. **The per-RPC deadline is what actually bounds a silent peer.** `ClusterClient.update`
   (`packages/db-p2p/src/cluster/client.ts:32`) applies `withRpcDeadlineDefaults`
   (`packages/db-p2p/src/rpc-deadline.ts:19,26`): `DEFAULT_DIAL_TIMEOUT_MS` = 3000 bounds
   connecting; `DEFAULT_RESPONSE_TIMEOUT_MS` = 10000 bounds waiting for a reply on an established
   stream and genuinely aborts the stream (`packages/db-p2p/src/protocol-client.ts:129`), so it
   unblocks the read rather than merely arming a timer.
3. **Two attempts per remote peer.** `ClusterCoordinator.updateMember`
   (`cluster-coordinator.ts:132`) re-attempts a *remote* failure `promiseImmediateRetries` times
   (default 1) ⇒ 2 attempts. The local peer bypasses the client and is invoked exactly once.
4. **The bar at three nodes is unanimity.** `superMajority = ceil(peerCount × 0.75)`
   (`cluster-coordinator.ts:334`); `ceil(3 × 0.75) = 3`. So `peerCount > 1 && approvalCount <
   superMajority` throws (`cluster-coordinator.ts:364-374`) with the exact string:

   ```
   Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)
   ```

5. **The transaction budget above it is 30 s, and a super-majority failure IS retried inside it.**
   The control database's transactor is built at
   `../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:192`
   with `timeoutMs: 30_000`, `abortOrCancelTimeoutMs: 5_000`, `dialTimeoutMs: 3_000`.
   `NetworkTransactor.pend` sets `expiration = now + 30_000`
   (`packages/db-core/src/transactor/network-transactor.ts:461`) and hands it to `processBatches`
   (`packages/db-core/src/utility/batch-coordinator.ts:111`), whose `catch` re-resolves a
   **different** coordinator (excluding the one that just failed) and retries, recursively, for as
   long as `expiration > Date.now()`. A thrown super-majority failure is not special-cased, so it
   is retried. The recursion terminates when every peer is excluded (`findCoordinator` then throws
   `SELF_COORDINATION_EXHAUSTED` / `NO_COORDINATOR_AVAILABLE`, which is swallowed — the *original*
   first-attempt error stays authoritative).
6. **What the caller finally sees.** `pend` rebuilds the failure as
   `Some peers did not complete: <per-batch detail>; root: <rootCause.message>` where `rootCause` is
   `firstBatchError(batches)` — the first attempt's super-majority error
   (`network-transactor.ts:491-506`). A super-majority failure is a *throw*, not a `StaleFailure`,
   so the conflict/retry classification below it never engages and the error propagates.

### Therefore, the prediction the test must confirm or refute

| Case | Predicted outcome |
| --- | --- |
| No degradation | Write commits. |
| Degraded **under** the 10 s response deadline (e.g. 2 s) | Write commits, paying the delay as latency. |
| Degraded **past** the 10 s response deadline | Clean, named failure. First coordinator's promise phase ≈ 2 × 10 s ≈ **20 s** (peers are dialled in parallel, so the phase is as slow as its slowest peer; the second attempt's dial is warm). `processBatches` then still has budget, so it re-coordinates through another peer and the whole thing is capped by the 30 s transaction budget. Caller-visible: **≥ ~20 s, ≤ ~35 s**, error message containing `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`. |

**If instead it hangs**, that is a defect this ticket found, not a test bug — see *If the finding is
a hang* below.

## Why a naive three-node test proves nothing

`Libp2pKeyPeerNetwork.findCluster` (`packages/db-p2p/src/libp2p-key-network.ts:556`) builds the
cohort as `[self, ...serves]`, where `serves` comes from FRET's `assembleCohort` filtered to peers
whose libp2p peerStore protocol list already carries `/optimystic/<networkName>/…`. FRET's routing
table is not warm inside a test's lifetime — the harness comment at
`packages/integration-tests/src/harness/test-party.ts:56` records 213/213 single-peer cohorts
measured across a `happy-path` run (tracked as `backlog/debt-harness-control-cohort-never-multi-peer`).
A cohort of one never reaches the super-majority branch at all.

**This ticket does not fix that backlog item. It forces the cohort instead**, and only the cohort.

### The forcing seam

`createLibp2pNode` attaches the key network to the node it returns —
`(node as any).keyNetwork = keyNetwork` (`packages/db-p2p/src/libp2p-node-base.ts:1301`) — and it is
the *same object instance* the coordinator captured (`libp2p-node-base.ts:695` →
`coordinatorRepo(keyNetwork, …)` at `:817`). So replacing `node.keyNetwork.findCluster` after node
creation substitutes cohort **discovery** and nothing else: the real `ClusterClient` (and therefore
the real 3 s / 10 s deadlines), the real libp2p transport, and the real `ClusterMember` on every
peer all stay in place.

### Patch all three nodes, not just the coordinator

Each member independently re-derives its own view and gates the coordinator's declared peer set
against it: `deriveExpectedCluster` (`libp2p-node-base.ts:783`, which calls the *same*
`keyNetwork.findCluster`) feeds `ClusterMember.admitMembership`
(`packages/db-p2p/src/cluster/cluster-repo.ts:884`).

With only the coordinator patched, each member's own `findCluster` still returns self-only and the
outcome depends on FRET's network-size confidence — which the test does not control:

- **Not confident** (`derived.confidence <= 0.5`, `cluster-repo.ts:222,909`): falls to the
  low-confidence branch. `assumedClusterSize` defaults to `minAbsoluteClusterSize` = 2
  (`libp2p-node-base.ts:716,737`; Cadre deliberately leaves it there — see the
  `CONTROL_REPLICATION_BREADTH` docblock in `packages/quereus-plugin-sereus/src/cluster-size.ts`).
  `admissionFloor(2) = max(2, ceil(0.75 × 2)) = 2`, declared = 3 ≥ 2 → **admits**.
- **Confident**: `kEst` = 1 from the self-only view. Predicate 2 passes
  (`admissionFloor(1) = max(2, ceil(0.75 × 1)) = 2`, declared 3 ≥ 2), but predicate 3 computes
  `|{a,b,c} △ {self}| = 2` against `maxDiff = ceil(sizeTolerance × kEst) = ceil(0.5 × 1) = 1` →
  **rejects** with `membership-not-admitted:inconsistent-with-derived-view`
  (`cluster-repo.ts:964-975`).

A test whose result flips on FRET confidence measures the wrong thing. Patch `findCluster` on **all
three** nodes to return the same three-peer set, so every member's derived view equals the declared
set (`symmetricDiff = 0`) and the admission gate is a no-op under either branch.

> **Correction to prior analysis carried in the plan ticket:** `membershipAdmissionFraction`
> defaults to **0.75**, not 0.67 (`cluster-repo.ts:262`). The 0.67 figure in the partition-safety
> `NOTE` at `cluster-repo.ts:991` refers to a different factor. The admit/reject conclusions above
> are unchanged; the arithmetic is corrected.

## Decisions (settled — implement these, do not re-open)

- **Package: `packages/integration-tests`.** Three real libp2p nodes with real transports is what
  that suite is for; `packages/cadre-core/test` is unit/near-unit territory and has no multi-node
  real-network precedent. *Tradeoff:* the better labelled-deadline harness (`withinOp` in
  `packages/cadre-core/test/control-db-node-helpers.ts`) lives on the other side. **Bring the
  pattern, not the import** — cadre-core's test helpers are not exported from the package, so
  re-implement the same one-liner locally (below) rather than reaching across packages.
- **The degraded member is a full `CadreNode`,** with the stall injected by re-registering its
  cluster protocol handler. Rationale: the "degraded but under the deadline" case requires a *real*
  `ClusterMember` to actually validate and approve the record, and the retry path (finding 5)
  re-coordinates through another peer, which needs every node to serve the repo protocol too. A
  bare libp2p node that only speaks the cluster protocol would make the approving cases untestable
  and the retry path unrepresentative. *Tradeoff:* three full nodes is the more expensive shape;
  accepted, and it matches the existing three-node scenario's cost profile.
- **The `findCluster` patch lives in a named harness helper,**
  `packages/integration-tests/src/harness/forced-cluster.ts`, exported from `harness/index.ts` —
  not an inline cast per spec. The "patch all three" invariant is expressed once, in one function
  that takes the whole node set.
- **Delay matrix:** `0` (control — must commit), `2_000` (under the 10 s response deadline — must
  commit), and *never reply* (past the deadline — must fail with the named error inside budget).
  Three nodes is deliberately the boundary case: `ceil(3 × 0.75) = 3` means one degraded member is
  decisive.

## Interfaces to build

```ts
// packages/integration-tests/src/harness/forced-cluster.ts

/** One entry of a forced cohort — the shape `IKeyNetwork.findCluster` returns. */
interface ForcedClusterPeer { multiaddrs: string[]; publicKey: string }

/**
 * Replace `findCluster` on EVERY supplied node's key network with a constant
 * cohort spanning all of them. Returns a restore function.
 *
 * Must be applied to every node, not only the coordinator: each member re-derives
 * its own view through the same `findCluster` and gates the declared set against it.
 */
export function forceFullCohort(nodes: readonly CadreNode[]): () => void;
```

The helper builds each entry from the node's own live state — `node.getControlNode()!.getMultiaddrs()`
for addresses and the peer id's `publicKey.raw` base64url-encoded for `publicKey` — mirroring what
the real `findCluster` produces at `libp2p-key-network.ts:645-668`. Assert every entry has at least
one multiaddr before returning; an addressless forced entry would produce
`no valid addresses` dial failures that look like the degradation under test.

```ts
// The stall injection, in the spec file.

/**
 * Re-register the node's cluster protocol handler so inbound cluster RPCs are
 * delayed by `delayMs` (or never answered when `delayMs` is `Infinity`) before
 * the real handler runs.
 */
async function degradeClusterHandler(node: CadreNode, delayMs: number): Promise<() => Promise<void>>;
```

Read the currently-registered handler for `/optimystic/control-<partyId>/cluster/1.0.0` off the
node's libp2p registrar, unregister it, and register a wrapper that awaits the delay (respecting an
abort so teardown is prompt) then delegates. The returned function restores the original.

```ts
/** Labelled deadline — same contract as cadre-core's `withinOp`, re-stated locally. */
function within<T>(label: string, ms: number, op: () => Promise<T>): Promise<T>;
```

A freeze must surface as `degraded-cohort control op <label> timed out after <ms>ms`, never as a
bare vitest timeout — a bare timeout names no operation and is the difference between "we found a
hang in `authorizePeer`" and "the test file was slow".

## Edge cases & interactions

- **Anti-vacuity: assert the cohort really was three peers.** Instrument the forced `findCluster`
  with a call counter and captured peer sets; assert it was called and returned three peers for the
  write under test. A regression that quietly reverts to a self-only cohort would otherwise turn
  this into a test that passes by measuring nothing.
- **Assert no vote carried a `membership-not-admitted` reason.** If the admission gate ever does
  bite, the test must fail loudly on *that* rather than silently reporting a super-majority failure
  with the wrong cause. Capture it from the coordinator's rejection detail or from
  `DEBUG='…cluster-member…'` output — whichever the implementation can read without new production
  surface.
- **Assert a lower bound on the failure's wall time,** not only an upper one. An instant failure
  means the deadline path was never exercised (most likely an admission rejection or an addressless
  dial), which is a different defect wearing the same error.
- **Reads while a write is degrading.** A control read issued while the promise phase is stalled
  must still answer from local state under its own deadline — the liveness property
  `packages/cadre-core/test/control-database-offline-peers.spec.ts` asserts for unreachable peers.
- **Both write directions.** `authorizePeer` (owner-vouched INSERT) and `removePeer`
  (stamp-retiring DELETE under `CadrePeer.AuthorizedDelete`) are genuinely different SQL paths; the
  offline-peer review found the DELETE path had been missed. Cover both.
- **Recovery.** After the degraded member is restored, a subsequent write must commit normally — a
  failed write must not leave the coordinator or the transaction state store wedged.
- **The write-while-alone re-replication queue.** `CadreNode.noteControlWrite` flags writes that
  commit alone. Check what it records — and what it must *not* record — when a write **fails**
  rather than commits self-only. A failed write queued as "committed alone" would be a real bug.
- **Repeat stalls per write.** Finding 5 means the degraded node is hit again by the retry
  coordinator, so the stalling handler must tolerate multiple concurrent stalled streams and its
  teardown must abort all of them.
- **Cleanup on the failure path.** Every node stopped in a `finally` (follow `stopTrio` in
  `control-cohort-three-node-isolation.integration.ts` — log-and-continue, never throw out of
  teardown), the stalling handler torn down, and the forced-cohort restore called. Note that a
  failed `pend` fires `cancelBatch` as an unawaited background microtask with its own 5 s budget, so
  teardown can race in-flight cancels; stopping nodes must not depend on those settling.

## Test cases

- **`commits with a healthy three-member cohort`** — control case, no degradation. Both
  `authorizePeer` and `removePeer` commit; read-back asserted separately from the write resolving.
  Also the anti-vacuity anchor: cohort size 3 observed.
- **`commits with a member delayed under the response deadline`** — 2 s delay. Both writes commit.
  Assert the elapsed time is bounded (comfortably under the 10 s deadline plus slack) so a
  regression that silently escalates to the timeout path is caught.
- **`fails with a named super-majority error when a member stalls past the response deadline`** —
  never-replying member. Assert: the rejection message contains
  `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`; elapsed ≥ ~15 s and
  ≤ ~45 s; no `membership-not-admitted` in any reason; the cohort was 3.
- **`a control read answers locally while a write is stalled`** — issue the write unawaited, then
  run reads under their own deadlines.
- **`recovers: a write commits normally once the degraded member is restored`** — restore the
  handler, then write again and read back.
- **`does not queue a failed write for re-replication`** — inspect `pendingPeerWrites` after the
  failure case (same private-field cast pattern as
  `packages/cadre-core/test/control-database-offline-peers.spec.ts:78`).

## If the finding is a hang

The coordinator's unbounded `Promise.all` (finding 1) is then reaching production unprotected and
the RPC deadline is not covering some path. That is a defect, not a test bug:

- **Do not loosen the test to make it pass.** Keep it as the reproducer.
- File a `fix/` ticket naming the exact operation that froze, the elapsed time, and which layer's
  deadline failed to fire.
- Record the wall-clock reality you measured in the review handoff either way — the numbers above
  are a prediction, and the measured ones are the deliverable.

## TODO

### Phase 1 — harness

- Add `packages/integration-tests/src/harness/forced-cluster.ts` with `forceFullCohort(nodes)` per
  the interface above: patches `findCluster` on every node's `keyNetwork`, builds entries from live
  multiaddrs + peer public keys, asserts every entry is addressed, counts calls, returns a restore.
- Export it from `packages/integration-tests/src/harness/index.ts`.

### Phase 2 — the spec

- Add `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`.
- Boot a three-node party (A owner/storage, B and C transaction) reusing the config and
  `makeOwnOwner` / `stopTrio` shapes from `control-cohort-three-node-isolation.integration.ts`; wait
  for all three to hold live control connections before forcing the cohort, so the forced entries
  carry connected addresses.
- Implement `within` (labelled deadline) and `degradeClusterHandler` (delay/never-reply wrapper over
  the registered cluster protocol handler, with abortable teardown).
- Write the six test cases above, each under labelled deadlines, each asserting read-back separately
  from write resolution.

### Phase 3 — validate and record

- Run the new scenario, streaming output (`yarn … 2>&1 | tee <scratchpad>/degraded.log`) so the
  runner's 10-minute idle timer never expires on a silent redirect. Run it more than once — the
  timing assertions are the point, and a single green run does not establish they are stable.
- Record the **measured** wall-clock and error text for the past-deadline case in the review
  handoff, alongside the prediction, and say plainly whether they matched.
- If the measurement contradicts the prediction in a way that indicates a product defect (a hang, or
  a failure with a different root cause), file the `fix/` ticket described above and keep the test.
- Update `docs/architecture.md` → "Replication cluster size" with one or two sentences stating the
  measured write-availability cost of whole-party control replication, so the number lives with the
  decision it justifies rather than only in a spec file.

<!-- resume-note -->
## Resume notes (prior run: research complete, NO code written yet)

A prior agent run hit its token budget after finishing the code-reading phase and before creating
any files. Nothing in the working tree was touched. Everything below was verified against the
actual code this session — start at Phase 1 of the TODO and trust these findings.

### Mechanics verified (exact seams for the two injection helpers)

- **Registrar access for `degradeClusterHandler`:** the libp2p node's `components` property is a
  plain public assignment (`node_modules/libp2p/dist/src/libp2p.js:59`), so
  `(node.getControlNode() as any).components.registrar` works. The `Registrar` interface
  (`@libp2p/interface-internal`, `registrar.d.ts:43`) provides `getHandler(protocol)` returning
  `{ handler, options }`, plus `handle(protocol, handler, options)` and `unhandle(protocol)` —
  swap = `getHandler` → `unhandle` → `handle(wrapped, sameOptions)`; restore = reverse.
- **StreamHandler signature (libp2p v3):** `(stream: Stream, connection: Connection): void |
  Promise<void>` — positional args, not the old `{ stream, connection }` object.
- **The registered cluster handler already contains the authorization gate.** `ClusterService`
  registers `handleIncomingStream.bind(this)` at `(prefix)/cluster/1.0.0`
  (`../optimystic/packages/db-p2p/src/cluster/service.ts:74,154`) and its inbound-stream
  authorization runs inside that bound method — so delegating to the captured handler preserves
  the full production path.
- **`forceFullCohort` details:** `keyNetwork` sits on the control libp2p node
  (`libp2p-node-base.ts:1301`); `CadreNode.getControlNode(): Libp2p | null` is public
  (`packages/cadre-core/src/cadre-node.ts:3583`). `findCluster` is a *prototype* method — patch by
  assigning an own property on the instance, restore by `delete`-ing the own property (do NOT
  reassign the unbound original). Build each entry from `controlNode.getMultiaddrs()` and
  `controlNode.peerId.publicKey.raw` encoded `base64url` via `uint8arrays`' `toString`. The
  return type `ClusterPeers` is importable from `@optimystic/db-core` (integration-tests already
  depends on it). Return a fresh copy per call — callers may mutate. Prefer returning a small
  handle object `{ restore(), callCount(), cohortSizes() }` over the bare restore function in the
  ticket sketch; the anti-vacuity assertions need the counters.

### Behavioral findings that shape assertions

- **Failed writes provably never queue:** `CadreNode.authorizePeer` awaits
  `seedBootstrapService.authorizePeer` *before* `noteControlWrite` (`cadre-node.ts:3985-3987`), so
  a throw skips the queue entirely; additionally `committedAlone()` is false with live
  connections. Test case 6 asserts the absence.
- **Super-majority failure text confirmed** at `cluster-coordinator.ts:374`, exactly as predicted
  in this ticket. `updateMember`'s local branch (`:133-135`) bypasses the ClusterClient — the
  basis of the hazard below.
- **⚠ The failure-case prediction has a known hole — measure, don't assume.** The
  batch-coordinator retry excludes only the *failed coordinator* and re-coordinates through
  another peer. If it ever selects the DEGRADED node C as coordinator, C's repo protocol (not
  degraded) accepts the pend, and C's own cluster vote is local (bypasses the stalled cluster
  handler), while A and B answer normally ⇒ the write may legitimately **commit** at ~20-35 s
  instead of failing. Mitigating factor: coordinator selection goes through
  `keyNetwork.findCoordinator` (NOT patched by `forceFullCohort`), and with cold FRET it likely
  returns self (A) and then finds no alternate candidate — which reproduces the predicted
  failure. If the measured outcome is a slow commit through C, that is *availability, not a
  defect* — record it and adjust the test to assert the measured reality, per the "measured
  numbers are the deliverable" rule.
- **Error-chain matching:** Quereus may wrap the transactor error, so assert by walking the
  `.cause` chain and aggregating messages before regex-matching the super-majority string and the
  `membership-not-admitted` absence.
- **Per-RPC deadlines confirmed:** `DEFAULT_DIAL_TIMEOUT_MS` 3000 / `DEFAULT_RESPONSE_TIMEOUT_MS`
  10000 (`rpc-deadline.ts`).
- **Timing caution for the 2 s-delay case:** each cluster transaction pays the delay per phase
  (promise, commit-collect, commit-broadcast), and a control write runs pend + commit at the
  transactor level — plausibly ~6 RPC rounds to the delayed member ⇒ ~12 s+ total. Do not assert
  "< 15 s" a priori; measure first, then fix bounds with honest slack while keeping the
  commit-case ceiling below the failure-case floor.

### Structure decisions (settled this session)

- Vitest picks up `src/**/*.integration.ts`; pool `forks`, `fileParallelism: false`. Default
  `testTimeout` 60 s and `hookTimeout` 30 s are both too small — pass explicit per-`it` timeouts
  (120 s) and an explicit `beforeAll` timeout (~180 s).
- Boot the trio ONCE in `beforeAll` and share across the six sequential `it`s (a trio boot is the
  dominant cost; six boots would flirt with the runner's 10-minute window). Restore
  degradation/patches at the end of every case so cases stay order-tolerant; case 6 issues its own
  failing write rather than depending on case 3's.
- Unlike the isolation scenario, **all three nodes listen** on `/ip4/127.0.0.1/tcp/0/ws` (B must
  be dialable for cluster fan-out). Boot sequence: A owner/storage + `makeOwnOwner`; vouch+seed B;
  vouch+seed C; wait `registerSelf() === 'refreshed'` on B and C; wait cross-resolution
  (`B.resolvePeerAddrs(C)` non-empty and vice versa); drive `B.reconcileControlCohort()` until a
  B↔C connection exists; assert every node's `getControlNode()!.getMultiaddrs()` non-empty; then
  `forceFullCohort([A, B, C])`. All writes issue from A (only A holds seed bootstrap).
- Case 4's unawaited stalled write: capture `.catch(e => e)` immediately and await its settlement
  (under a labelled deadline) before restoring the handler, to avoid an unhandled rejection and a
  teardown race.
