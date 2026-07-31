description: When one machine in a group is connected but slow or unresponsive, shared-settings changes made on another machine can now be blocked by it. A test that measures what actually happens is now written; this ticket's remaining work is to run it, record the measured timings, and finish the handoff.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/index.ts, docs/architecture.md
difficulty: hard
----

# Coverage: control writes with a connected-but-degraded party member

The control database (shared settings + membership) replicates every block to the whole party
(`CONTROL_REPLICATION_BREADTH` = 16, effectively "everyone"). A control write commits only when a
super-majority of the **cohort** — the peers the block was offered to — approves. Because the
cohort is now the whole party, a member that is *connected but degraded* (slow, packet-losing,
mid-relay-reconnect) sits inside the cohort and counts against the bar. Nobody has measured what
that costs. This ticket is the measurement.

**Not the same as `debt-control-db-offline-peer-no-hang-coverage` (complete).** That covers members
that are *unreachable* — they never enter the cohort. This one is about members that *do* enter it.

## What the write path does (established by reading it — do not re-derive)

Paths below live in the sibling reference workspace `../optimystic` unless prefixed `packages/`.

1. **No phase-level timeout in the coordinator.** `ClusterCoordinator.collectPromises`
   (`packages/db-p2p/src/repo/cluster-coordinator.ts:460`) does a bare `Promise.all` over the
   cohort; per-peer failures become `null`, but a never-settling peer would hang the phase.
2. **The per-RPC deadline bounds a silent peer:** `DEFAULT_DIAL_TIMEOUT_MS` = 3000,
   `DEFAULT_RESPONSE_TIMEOUT_MS` = 10000 (`packages/db-p2p/src/rpc-deadline.ts`), genuinely
   aborting the stream.
3. **Two attempts per remote peer** (`promiseImmediateRetries` default 1); local peer invoked once.
4. **The bar at three nodes is unanimity:** `ceil(3 × 0.75) = 3`; failure throws exactly
   `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`
   (`cluster-coordinator.ts:374` — verified this session).
5. **30 s transaction budget above it; super-majority failures ARE retried inside it** via
   batch-coordinator re-coordination excluding the failed coordinator; when candidates exhaust, the
   original first-attempt error stays authoritative.
6. **Caller sees** `Some peers did not complete: …; root: <first super-majority error>`, possibly
   wrapped further by Quereus — assert by walking the `.cause` chain.

### Prediction the test must confirm or refute

| Case | Predicted outcome |
| --- | --- |
| No degradation | Write commits. |
| Degraded under the 10 s response deadline (2 s) | Write commits, delay paid as latency. |
| Degraded past the deadline (never answers) | Named failure, elapsed ≥ ~20 s and ≤ ~35 s, message above. |

**Known hole in the failure prediction — measure, don't assume:** batch-coordinator retry may
re-coordinate through the DEGRADED node C, whose repo protocol is NOT degraded and whose own
cluster vote is local — the write may then legitimately **commit** at ~20–35 s. That is
*availability, not a defect*: record it and adjust the test to assert the measured reality.
Mitigating factor: `findCoordinator` is deliberately NOT patched and cold FRET likely selects self.

**If instead it hangs**, that is a defect this ticket found, not a test bug: keep the test as the
reproducer, file a `fix/` ticket naming the exact frozen operation, elapsed time, and which layer's
deadline failed to fire.

<!-- resume-note -->
## State: code COMPLETE, typecheck green — execution NOT started

A prior run wrote all the code below and verified `yarn typecheck` passes in
`packages/integration-tests`. Nothing has been executed yet; `yarn lint` has not been run. Working
tree contains only these changes:

- **`packages/integration-tests/src/harness/forced-cluster.ts` (new).** `forceFullCohort(nodes)`
  patches `findCluster` as an own-property override on every node's
  `getControlNode().keyNetwork`, returning a handle `{ restore(), callCount(), cohortSizes() }`
  (counters back the anti-vacuity assertions). Entries built from live
  `controlNode.getMultiaddrs()` + `peerId.publicKey.raw` base64url; throws on any addressless or
  keyless entry; fresh copy per call; `restore()` deletes the own property. Exported from
  `harness/index.ts`.
- **`packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`
  (new).** All six cases from the spec, in one `describe` sharing a single trio boot
  (`beforeAll`, 240 s timeout; per-`it` timeouts 120–150 s):
  1. healthy commit (authorize + remove, anti-vacuity anchor, no queue entry);
  2. 2 s-delayed commit (both directions, ceiling `DELAYED_COMMIT_CEILING_MS` = 30 s, wrapper
     intercepted-stream count asserted non-zero);
  3. never-answering member → named super-majority failure, `.cause`-chain regex, no
     `membership-not-admitted`, elapsed within [`FAILURE_FLOOR_MS` = 15 s, `FAILURE_CEILING_MS`
     = 45 s], rollback asserted, no queue entry;
  4. reads answer locally under 15 s deadlines while a write stalls (write captured
     `.then(null, e)` immediately, settlement joined before handler restore);
  5. recovery write commits after restore;
  6. failed DELETE (removePeer against stalled member) neither queues in `pendingPeerWrites` nor
     rolls the victim out.
  Local helpers: `within` (labelled deadline: `degraded-cohort control op <label> timed out after
  <ms>ms`), `timedSettle`, `errorChainText` (cause-chain flattener), `degradeClusterHandler(node,
  partyId, delayMs)` — registrar `getHandler`/`unhandle`/`handle` swap on
  `/optimystic/control-<partyId>/cluster/1.0.0` via the control node's `components.registrar`,
  abortable (`Infinity` = hold stream until teardown then abort it), tolerates concurrent stalled
  streams, `restore()` idempotent and awaited in every case's `finally`; `afterAll` restores any
  active degradation, restores the forced cohort, stops C/B/A log-and-continue.
  Boot: all three listen on `/ip4/127.0.0.1/tcp/0/ws`; A owner/storage + `makeOwnOwner`; vouch+seed
  B then C (`joinMember`); `registerSelf() === 'refreshed'` polled on B and C; cross-resolution
  both ways; `B.reconcileControlCohort()` driven until a B↔C connection; multiaddrs asserted
  non-empty; then `forceFullCohort([A, B, C])`. All writes issue from A.
  Every case `console.log`s `[measured] …` lines with wall-clock + error text — those lines ARE the
  deliverable numbers.

### Mechanics already verified against code (trust, don't re-derive)

- Registrar: control node's `components.registrar`; `getHandler(protocol)` →
  `{ handler, options }`; handler signature is positional `(stream, connection)`; the captured
  handler contains the inbound-authorization gate.
- `authorizePeer` awaits the write BEFORE `noteControlWrite` (`cadre-node.ts:3979-3988`), so a
  throw provably never queues — case 6 asserts the absence.
- `membershipAdmissionFraction` default 0.75; with all three nodes patched the admission gate is a
  no-op (symmetric diff 0) under either FRET-confidence branch.
- Vitest config: `src/**/*.integration.ts`, pool forks, `fileParallelism: false`; default timeouts
  too small, hence the explicit per-hook/per-it timeouts already in the file.

## TODO (remaining)

### Phase 3 — validate and record

- Run `yarn lint` (repo root) — not yet run; fix anything it flags in the two new files.
- Run the scenario, streaming output so the runner's 10-minute idle timer never expires:
  `cd packages/integration-tests && yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts --reporter=verbose 2>&1 | tee <scratchpad>/degraded.log`
  (the suite's global setup fails fast if any cadre dist is stale — `yarn build` at root first if
  it complains). Run it **more than once** — the timing assertions are the point.
- The three timing constants (`FAILURE_FLOOR_MS` 15 s / `FAILURE_CEILING_MS` 45 s /
  `DELAYED_COMMIT_CEILING_MS` 30 s) are provisional predictions: adjust to the measured reality
  with honest slack, keeping the commit-case ceiling below the failure-case floor.
- If the failure case instead COMMITS through the degraded node (the known hole above): that is
  availability, not a defect — flip that case's assertions to the measured outcome and say so in
  the handoff. If anything HANGS: keep the test as reproducer and file the `fix/` ticket per the
  "If instead it hangs" paragraph.
- Watch for: B/C heartbeat `registerSelf` fires 7.5 min after their start — if the whole suite ever
  runs that long, a heartbeat write can land mid-stall (slows the heartbeat, should not touch
  assertions; note it if seen in the log).
- Record the **measured** wall-clock and error text for the past-deadline case in the review
  handoff, alongside the prediction, and say plainly whether they matched.
- Update `docs/architecture.md` → "Replication cluster size" with one or two sentences stating the
  measured write-availability cost of whole-party control replication.
- Write the review/ handoff ticket (honest about gaps — e.g. single-machine timings, the forced
  cohort substituting discovery) and delete this ticket.
