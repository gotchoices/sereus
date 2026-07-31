----
description: Add an integration test proving that when a device automatically opens a connection to another member of its party, real data actually travels over that new connection — today we only prove the connection appears.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/integration-tests/src/harness/index.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/quereus-plugin-sereus/src/cluster-size.ts
difficulty: hard
----

## Goal

Add ONE new integration scenario,
`packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts`,
that proves a control-database record written on node C reaches node B **only**
across the connection `CadreNode.reconcileControlCohort` opened from B to C.

`control-cohort-three-node-isolation.integration.ts` already proves the reconcile
routine *forms* that connection. It says in its own comments — twice — that its
end-state check does not prove the connection carries anything, because the
revision it observes may have travelled through A. This ticket closes that gap.
**Do not weaken or edit the isolation scenario.**

## The design (settled — build this, do not re-open it)

Same A/B/C topology as the isolation scenario:

```
        A  (storage profile, own owner, listens on ws, no relay)
       / \
      /   \        B and C both cold-start via applySeed
     B     C       C listens on ws
     |               B: listenAddrs: []  → nobody can dial B, ever
     +----→ C      the only link B can ever have is one B itself opened
```

The proof is an **ordering** argument, not a single assertion:

1. Boot A/B/C in the isolation scenario's exact order, with B's
   `network.controlCohort.reconcileMs` set to `600_000` so B's recurring timer
   provably never fires inside the test. Boot ends when B can resolve C's signed
   `CadrePeer` address record (`B.resolvePeerAddrs(cPeerId)` non-empty) — B knows
   C's address, but has never connected to it.
2. Apply `pinCoordinator([C])` (`harness/forced-cluster.ts`). This is
   **load-bearing, not just determinism** — see "Why the coordinator must be
   pinned" below.
3. Baseline: read `B.getControlDatabase()!.queryPeerRecord(cPeerId)` → `r0`.
   Assert B holds an open connection to A and none to C.
4. **Sever B from A.** Flip B's test-supplied connection gater to deny dialling A,
   then `B.getControlNode()!.hangUp(aPeerId)`. Poll until B holds **zero** open
   control connections. Nobody can dial B (no listen addrs), so B is now fully
   isolated and stays that way unless B itself dials out.
5. **Negative window (~4s, 250ms checkpoints).** At every checkpoint assert:
   - B holds zero open control connections,
   - A holds zero open control connections to B,
   - `peerStoreAddrsFor(B, cPeerId)` is empty — so B's libp2p layer still has no
     address for C and nothing but the record path can supply one,
   - `B.resolvePeerAddrs(cPeerId)` is non-empty — the record path IS live, so the
     absence of a link is "nothing dialled", not "nothing to dial".
6. **Write R1 on C**, while B is isolated:
   `waitUntil(async () => (await C.registerSelf()) === 'refreshed')`, then read
   C's own row → `r1`, assert `r1 > r0`. Assert B *still* holds zero connections:
   this revision was authored with B provably absent from the network.
7. **Link.** Call the production routine `await B.reconcileControlCohort()`
   (polled the same way the isolation scenario polls it — a single pass can lose
   the admission race). Assert `hasOutboundTo(B, cPeerId)`, and that B's open
   control connection set is exactly `{C}`. Record the connection `id`.
8. **Carry.** Poll `B.getControlDatabase()!.queryPeerRecord(cPeerId)` until
   `updatedAt >= r1`. **At every poll iteration** assert that every open control
   connection B holds is to C. Once it converges, assert the connection whose
   `id` was recorded in step 7 is still the open one — the same connection
   carried it, not a later replacement.
9. Closing assertions:
   - `readCohort(B.getControlNode()!)` (from `harness/control-cohort.ts`) contains
     C's peer id — C got seated in B's replication cohort. This is one of the two
     regressions the gap names ("the peer never gets seated in the other's
     replication cohort").
   - `pin.callCount() > 0` — the pin was actually consulted, so it cannot have
     silently no-opped.
   - B never held a connection to any peer but C after step 4.

**Conclusion the test establishes:** R1 was authored on C while B held zero
connections; the only connection B gained afterwards is the one
`reconcileControlCohort` dialled to C; B then observed R1. Therefore R1 crossed
B↔C. Both regressions the gap names are covered — a peer not seated in the
cohort, and a connection opened on a network the database does not use, each
leave step 8 timing out.

### Why the coordinator must be pinned

A control write commits on a super-majority of its cohort, and Cadre leaves
`superMajorityThreshold` at Optimystic's default 0.75
(`packages/quereus-plugin-sereus/src/cluster-size.ts` → `CONTROL_CLUSTER_POLICY`),
so a 3-member cohort needs **all three** approvals.

- C's own cohort excludes B: `Libp2pKeyPeerNetwork.findCluster` admits only peers
  the libp2p peerStore positively classifies as serving this network's protocol,
  which requires a completed identify — i.e. a connection. C has never connected
  to B. So a C-coordinated write in step 6 needs `{A, C}` and commits.
- A's cohort may still *contain* B (A did connect to B before the sever, so B's
  protocols are cached in A's peerStore). An A-coordinated write would demand a
  promise from B, which neither A nor C can reach — it would never commit.

Pinning the coordinator to C is therefore what makes step 6 possible at all.
Assert the precondition explicitly before the write so a surprise fails fast with
a readable message rather than hanging: `readCohort(C.getControlNode()!)` must
NOT contain B's peer id.

Pinning also removes a read-path ambiguity in step 8: B's read goes to C rather
than being answered by B out of its own stale local blocks.

### Why the negative window cannot accidentally form B↔C

Everything B's Optimystic transactor could dial comes from FRET / the libp2p
peerStore, and B's peerStore holds **no address for C** (the isolation scenario
asserts exactly this, and step 5 re-asserts it). A `findCoordinator` result is a
peer id; the dial then needs addresses and finds none. The only component that
can turn C's signed record into a dialable address is
`CadreNode.resolveControlDialAddrs`, which only the reconcile pass calls. So the
pin being active during the negative window is safe.

### Severable gater

B's config takes `network.connectionGater` (`packages/cadre-core/src/types.ts`),
and `createMembershipConnectionGater` spreads the caller's gater, preserving every
hook except `denyInboundEncryptedConnection`. So a test gater's outbound hooks are
honoured unchanged. Build a small local helper:

```ts
interface SeverableGater {
	gater: ConnectionGater;
	/** Deny every future dial to the target peer. Idempotent. */
	sever(): void;
}

function severableDialGater(deniedPeerId: string): SeverableGater;
```

Implement `denyDialPeer`, `denyDialMultiaddr` (via `ma.getPeerId()`) and
`denyOutboundConnection` — libp2p's dial queue consults `denyDialPeer` on the
peer-id path and `denyDialMultiaddr` on the per-address path
(`node_modules/libp2p/dist/src/connection-manager/dial-queue.js`), and the third is
belt-and-braces.

`reconcileControlCohort` dials the owner/backbone member (A) before the non-owner
fill (C), so B's step-7 pass WILL hit the denial first. That is fine and worth a
comment: `dialControlSibling` logs and swallows per-peer failures, naming
"connection-gater denial" among them, so one denied sibling never aborts the pass.

## Shared boot helper

The boot ordering is subtle and is the same one the isolation scenario proves out.
Do NOT copy it into the new file, and do NOT edit the isolation scenario (a
separate ticket, `integration-test-harness-helper-consolidation-remaining-files`,
owns de-duplicating that file's private helpers — leave it alone here).

Instead add `packages/integration-tests/src/harness/control-trio.ts`, re-exported
from `harness/index.ts`, holding an assertion-free `bootControlTrio`:

```ts
export interface ControlTrioOptions {
	/** B's `network.controlCohort.reconcileMs`. */
	reconcileMsB: number;
	/** Filled in as each node boots so a caller's `finally` can stop partial state. */
	handles: ControlTrioHandles;
	/** Test-supplied gater for B (composed under the membership gate). */
	gaterB?: ConnectionGater;
}

export interface ControlTrioHandles { A?: CadreNode; B?: CadreNode; C?: CadreNode; }

export interface ControlTrio {
	A: CadreNode; B: CadreNode; C: CadreNode;
	aPeerId: string; bPeerId: string; cPeerId: string;
}

export function bootControlTrio(options: ControlTrioOptions): Promise<ControlTrio>;
export function stopControlTrio(handles: ControlTrioHandles): Promise<void>;
```

Harness modules in this package do not import `vitest`; keep that. Port the
isolation scenario's boot steps 1–6 verbatim in meaning, turning each `expect(...)`
into an explicit `throw new Error('<what was violated>')`. Every ordering
checkpoint must survive the move — they are the proof, not decoration:

- A self-registers a `CadrePeer` row with addresses before any seed is minted.
- B is vouched BEFORE it starts, and A's seed for B provably cannot name C.
- B's ONE start-time eager reconcile pass is drained (self-registration lands,
  then `sleep(1_000)`, then `await B.reconcileControlCohort()`) **before C
  starts**, so that pass can never be what forms B↔C.
- At C's start: B has zero connections to C and zero peerStore addresses for C.
- A vouches C, C applies its seed, C reaches A, C self-publishes (polled
  `registerSelf() === 'refreshed'`), and C's record becomes resolvable on B.

Reuse whatever of `wsTransports` / `makeOwnOwner` / `connectionsTo` /
`hasOutboundTo` already lives in `harness/node-fixtures.ts`; add
`peerStoreAddrsFor` there or to `control-trio.ts` if it is not already shared.

## Edge cases & interactions

- **Step 6 write never commits.** If `readCohort(C)` unexpectedly contains B, the
  write needs unanimity and B is unreachable. Assert that precondition before the
  write so the failure names the cause instead of burning a 60s timeout.
- **Pin silently no-ops.** `pinCoordinator` returns a handle; assert
  `callCount() > 0` at the end. A pin that never fired means the whole
  coordinator argument above did not apply to this run.
- **Patch restore ordering.** `pinCoordinator` patches
  `Libp2pKeyPeerNetwork.prototype`; restore it in a `finally`, and restore in
  reverse order of application if anything else patches (nothing else should
  here). `key-network-patch.ts` throws on out-of-order teardown.
- **Teardown on a mid-test throw.** Fill `handles` as each node boots; the test's
  `finally` must stop whatever came up (newest first) and swallow+log individual
  stop failures, so one failed stop neither leaks the other two nodes' listeners
  nor masks the original failure.
- **B auto-redialling A.** libp2p's connection manager may try to restore a
  connection to A; the gater must deny it. The step-5/8 per-iteration assertions
  are what catch a leak here, so keep them inside the loops, not just at the end.
- **A dialling B.** A cannot (B has no listen addresses). Assert
  `(await A.resolvePeerAddrs(bPeerId)).length === 0` once, and poll
  `connectionsTo(A, bPeerId)` empty during the negative window. Do NOT assert on
  A's raw peerStore contents for B — that is not a guaranteed-empty observable.
- **`self:peer:update`-triggered reconcile on B.** `startRecordRefresh` wires a
  reconcile pass on that event, independent of the 10-minute cadence. B listens on
  nothing, so its address set should never change — but if the negative window
  ever fails, this is the first suspect (same NOTE the isolation scenario carries).
  Diagnose with `DEBUG='sereus:cadre:node'`.
- **Unanimity churn on polled writes.** Every control write in a 3-member cohort
  is effectively unanimous, so a single stream reset fails the commit outright.
  Poll `registerSelf()` with `waitUntil` exactly as the isolation scenario does —
  never call it once. (The underlying divergence is tracked separately; do not
  chase it here.)
- **Test duration.** Budget a 120s `it` timeout like the isolation scenario, and
  keep the file to a single `it` so the suite's serial runtime stays sane.

## TODO

- Add `packages/integration-tests/src/harness/control-trio.ts` with
  `bootControlTrio` / `stopControlTrio` / the trio types, assertion-free (explicit
  throws, no `vitest` import), porting the isolation scenario's boot ordering
  including every checkpoint listed above; accept an optional `gaterB`.
- Re-export it from `packages/integration-tests/src/harness/index.ts`.
- Add `peerStoreAddrsFor` to the harness if it is not already shared.
- Write `packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts`
  implementing steps 1–9 above, with a file header that states plainly what this
  proves that the isolation scenario does not.
- Add the `severableDialGater` helper (local to the new scenario file — it is
  scenario-specific).
- Do not touch `control-cohort-three-node-isolation.integration.ts`.
- Run the new scenario:
  `yarn workspace @serfab/integration-tests test 2>&1 | tee /tmp/edge-carries.log`
  (stream it — never silently redirect). Then re-run the isolation scenario to
  confirm it is unchanged and still green.
- `yarn lint` and `yarn typecheck` clean.
- Hand off to `review/` honest about what the scenario does and does not prove —
  in particular that carriage is demonstrated in the **read** direction (B pulls
  R1 across the edge); the write direction (B promising a C-coordinated write over
  the same edge) is implied by cohort seating but not separately asserted.
