----
description: Add an integration test proving that when a device automatically opens a connection to another member of its party, real data actually travels over that new connection — today we only prove the connection appears.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/cadre-core/src/cadre-node.ts
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
honoured unchanged. Implement `denyDialPeer`, `denyDialMultiaddr` and
`denyOutboundConnection` — libp2p's dial queue consults `denyDialPeer` on the
peer-id path and `denyDialMultiaddr` on the per-address path, and the third is
belt-and-braces.

`reconcileControlCohort` dials the owner/backbone member (A) before the non-owner
fill (C), so B's step-7 pass WILL hit the denial first. That is fine and worth a
comment: `dialControlSibling` logs and swallows per-peer failures, naming
"connection-gater denial" among them, so one denied sibling never aborts the pass.

## Edge cases & interactions

(All preserved from the original ticket; the scenario file's comments restate
each at its site.)

- **Step 6 write never commits** → precondition assert on `readCohort(C)`.
- **Pin silently no-ops** → `pin.callCount() > 0` at the end.
- **Patch restore ordering** → restore pin in `finally` (nothing else patches).
- **Teardown on a mid-test throw** → `handles` filled per-boot; stop newest first.
- **B auto-redialling A** → gater denies; per-iteration asserts catch leaks.
- **A dialling B** → impossible (no listen addrs); assert
  `A.resolvePeerAddrs(bPeerId)` empty; poll `connectionsTo(A, bPeerId)` empty.
- **`self:peer:update`-triggered reconcile on B** → first suspect if the window
  fails; diagnose with `DEBUG='sereus:cadre:node'`.
- **Unanimity churn on polled writes** → poll `registerSelf()` with `waitUntil`.
- **Test duration** → 120s `it` timeout, single `it`.

<!-- resume-note -->
## Resume note 2 (run interrupted by BUDGET_WARNING, 2026-07-31, second run)

**All code is written and `yarn lint` + `yarn typecheck` are clean.** The first
test run FAILED ~13s in — one diagnosable defect in the scenario's read
patterns, not in the harness or the design. The isolation scenario was NOT
edited and has not been re-run. Remaining work: fix the failing read(s), get
the new scenario green, re-run the isolation scenario, hand off to `review/`.

### What exists in the working tree (uncommitted, from this run)

- `packages/integration-tests/src/harness/control-trio.ts` — NEW. Assertion-free
  `bootControlTrio` / `stopControlTrio` / trio types; faithful port of the
  isolation scenario's `bootTrio` (every `expect` → explicit `throw`, no vitest
  import, all ordering checkpoints preserved). Accepts optional `gaterB`
  threaded into B's config; returns all three nodes + all three peer ids.
- `packages/integration-tests/src/harness/node-fixtures.ts` — EXTENDED.
  `ControlNodeOpts` gained `pinnedOwnerKeys` (→ `trustedOwners.pinnedKeys`) and
  `connectionGater` (→ `network.connectionGater`); added shared `connectionsTo`,
  `hasOutboundTo`, `peerStoreAddrsFor` (ports of the isolation scenario's
  private helpers — that file deliberately keeps its own copies, untouched).
- `packages/integration-tests/src/harness/index.ts` — re-exports control-trio.
- `packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts`
  — NEW. Implements steps 1–9 with two documented deviations:
  1. **Baseline `r0` is read BEFORE `pinCoordinator([C])`** (ticket ordered pin
     first). Reason: live reads refresh from the network via the pinned
     coordinator, and B cannot reach C at baseline time. Commented in the file.
  2. **`severableDialGater()` takes the denied peer id at `sever(peerId)` time**,
     not construction — A's peer id does not exist until A boots, but the gater
     must exist before `bootControlTrio` is called.
  Also: `@libp2p/interface` nests `@multiformats/multiaddr` v13, which has **no
  `getPeerId()`** — the gater's `denyDialMultiaddr` uses
  `ma.getComponents().filter(c => c.name === 'p2p').pop()?.value` instead.

### The failure (exact, from the one run)

Command: `yarn workspace @serfab/integration-tests test src/scenarios/control-cohort-edge-carries-data.integration.ts`

```
QuereusError: Error during query on table 'CadrePeer': Query failed: Some peers
did not complete: 12D3KooWHgks…[block:hBUz…](in-flight) cause=The stream has
been reset; root: The stream has been reset
  ❯ ControlDatabase.queryPeerRecord  control-database.ts:765
  ❯ CadreNode.resolvePeerAddrs       cadre-node.ts:1578
```

Test duration 13.13s — i.e. just after the sever (boot alone takes ~10–13s).
The throw escaped a **direct, unpolled** `resolvePeerAddrs` call. Only two
exist, both post-sever:

- `expect(await A.resolvePeerAddrs(bPeerId)).toHaveLength(0)` — right after the
  sever wait; **most likely culprit**: A's read touches cluster state that (from
  A's view) still involves B, whose streams the hangUp just reset — matching
  "(in-flight) … stream has been reset" exactly.
- The negative window's first-iteration `B.resolvePeerAddrs(cPeerId)`.

### Root-cause knowledge for the next agent (verified in source this run)

**Optimystic live reads are NOT local-only.** Every live table scan runs
`OptimysticVirtualTable.runQuery → resolveMainRead → collection.update()`
(`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:486-559`),
and `Collection.update()` (`../optimystic/packages/db-core/src/collection/collection.ts:116-146`)
syncs the collection log from the network through the transactor before serving
the read. Consequences:

- A direct read issued moments after a hangUp can ride a resetting stream and
  throw. Reads that must survive churn must be polled (`waitUntil` swallows a
  throwing condition as "not yet") or moved to a quiet moment.
- **Open question to answer empirically:** can B-side reads complete at all
  while B is fully isolated (the pin routes B's coordinator to C, which B
  cannot dial)? If yes (e.g. the log sync finds nothing new / degrades
  gracefully), the negative window's per-checkpoint
  `B.resolvePeerAddrs(cPeerId)` non-empty assertion stands as designed. If no,
  that assertion can NEVER pass while isolated; then bracket resolvability
  instead — assert non-empty immediately BEFORE the sever and keep the
  peerStore-empty + zero-connection checks inside the window — and state the
  weakening honestly in the review handoff. Do NOT silently drop the
  checkpoint: it is the "nothing to dial vs nothing dialled" half of the proof.

### Suggested fix order

- Move the `A.resolvePeerAddrs(bPeerId)` emptiness check to BEFORE the sever
  (the property — B's row never carries addresses — is time-independent), or
  poll it via `waitUntil`.
- Re-run; if the window's `B.resolvePeerAddrs` also throws, resolve the open
  question above and restructure the window accordingly.
- Watch step 9's `pin.callCount() > 0` on the first green run: `findCoordinator`
  is the read/fallback seam, `findCluster` the write seam — if nothing consults
  `findCoordinator`, the assertion needs rethinking rather than deleting.
- Then: re-run the isolation scenario unchanged
  (`yarn workspace @serfab/integration-tests test src/scenarios/control-cohort-three-node-isolation.integration.ts`),
  re-run `yarn lint` + `yarn typecheck` (both clean as of this note), write the
  `review/` handoff (honest scope: carriage proven in the READ direction only;
  write direction implied by cohort seating, not separately asserted), and
  delete this ticket.

### Prior resume-note facts still valid

All API locations from the first resume note were re-verified where used:
`reconcileControlCohort` single-flight, `registerSelf` return values, `hangUp`
takes a `PeerId` (`peerIdFromString`), `readCohort` takes a `Libp2p`,
`pinCoordinator` patches both seams and restores in reverse internally,
`waitUntil` defaults 10s/100ms and swallows throwing conditions, vitest picks up
`src/**/*.integration.ts`, membership gater preserves caller outbound hooks.
