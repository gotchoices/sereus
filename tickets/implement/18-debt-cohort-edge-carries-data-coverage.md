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

## The design (AMENDED run 3 — pin scoping; otherwise as originally settled)

Same A/B/C topology as the isolation scenario:

```
        A  (storage profile, own owner, listens on ws, no relay)
       / \
      /   \        B and C both cold-start via applySeed
     B     C       C listens on ws
     |               B: listenAddrs: []  → nobody can dial B, ever
     +----→ C      the only link B can ever have is one B itself opened
```

Ordering argument: boot → baseline (r0 + time-independent assertions) → sever
B↔A (gater + hangUp) → negative window (B fully isolated, C's record still
resolvable on B) → C authors R1 under a **write pin** to C → **unpinned**
`B.reconcileControlCohort()` forms B→C → **carry pin** to C, B observes R1 over
the recorded connection → closing (cohort seating, pin call counts).

### AMENDMENT (run 3, verified in source): the original "one pin around everything" design is IMPOSSIBLE

A pinned `findCoordinator` on isolated B fails **deterministically**: B's live
read → coordinator C → `RepoClient` dial with **no address** for C → fails →
retry excludes C → pin throws `every pinned coordinator candidate is excluded`
→ `NetworkTransactor.get` aggregate error → `queryCadrePeers`/`listMembers`
throws → `runReconcileControlCohort` rejects **before dialing anyone**. So a
pin active across the link step recreates the exact chicken-and-egg the
reconcile pass exists to break. Hence TWO scoped pins:

- `writePin = pinCoordinator([C])` around C's R1 write only (restored in an
  inner `finally` before the reconcile step).
- `carryPin = pinCoordinator([C])` applied after the link forms, before the
  carry poll — required not just for determinism: B was absent from the {A,C}
  write, so B's local state can never contain R1 and an unpinned carry read
  could serve B's stale view forever.
- Outer `finally` restores `carryPin` then `writePin` (both idempotent; they
  never overlap — writePin is restored before carryPin is applied).

Also relocated (fixes the run-2 13s failure): `A.resolvePeerAddrs(bPeerId)`
emptiness is asserted at BASELINE (pre-sever; the property is time-independent
— B never gains a listen address), never after the hangUp where the read rides
resetting streams. The pre-sever bracket assert
`B.resolvePeerAddrs(cPeerId)` non-empty also sits at baseline.

### Source facts established run 3 (all verified; saves re-derivation)

- `CadreNode.refreshMembershipGate` NEVER rejects (drain catches). But
  `listMembers` → `queryCadrePeers` → live scan → `collection.update()` →
  `TransactorSource.tryGet` → `NetworkTransactor.get` — THROWS on read failure,
  and `runReconcileControlCohort` (cadre-node.ts:1686) does not catch it.
  `dialControlSibling` catches only around the dial, not around
  `resolveControlDialAddrs`.
- `getRepo` (quereus-plugin-optimystic collection-factory.ts:183) returns the
  LOCAL `coordinatedRepo` when the coordinator is self — no self-dial.
- Real `Libp2pKeyPeerNetwork.findCoordinator` (db-p2p libp2p-key-network.ts:383):
  the FRET-neighbor path admits SELF without the `shouldAllowSelfCoordination`
  guard (`id === this.libp2p.peerId.toString()`, ~line 422); only the
  last-resort self block is guarded (partition detection / grace period can
  block it). The per-key coordinator cache lives INSIDE the real method, so a
  pin (full method replacement) bypasses it.
- `Collection.updateInternal` (db-core collection.ts:125): an
  authoritative-ABSENT header (`tryGet` → undefined) makes `update()` complete
  as a no-op and the read serves the collection's EXISTING in-memory state —
  i.e. an isolated node's read can legitimately succeed with stale rows.
- `readCohort` (harness/control-cohort.ts) is a local FRET `findCluster` probe
  — safe on any node at any time, no DB read.
- Why an UNPINNED R1 write on C is unsafe: set-cover could pick A as
  coordinator; A's peerStore still classifies B (identify survives disconnect)
  → A's cluster view includes unreachable B → commit hangs. Divergent per-node
  cluster VIEWS are fine (boot proves consensus tolerates them); only who
  coordinates matters here.

## State after run 3

Runs 1–2 work (harness + first scenario draft) was already committed by the
runner. Run 3 changed ONE file, uncommitted:

- Harness (`control-trio.ts`, `node-fixtures.ts`, `index.ts`): DONE, committed,
  correct — do not touch.
- Scenario file: REWRITTEN this run with the amended design above (scoped pins,
  relocated baseline asserts, 16-checkpoint window, inner/outer finally). Lint
  and typecheck NOT re-run after the rewrite. The test has NOT been run since
  the rewrite.
- Isolation scenario: untouched, not re-run.

## Remaining work (in order)

- `yarn lint` + `yarn typecheck` (clean before the rewrite; rewrite is
  comment/structure-heavy, expect clean).
- Run: `yarn workspace @serfab/integration-tests test src/scenarios/control-cohort-edge-carries-data.integration.ts 2>&1 | tee /tmp/edge.log`
  (stream output — 10-min idle timeout). 120s `it` budget, boot alone ~10–13s.
- ONE empirical unknown remains: does the negative window's per-checkpoint
  `B.resolvePeerAddrs(cPeerId)` succeed on isolated, UNPINNED B? It should
  (self-coordination via the unguarded FRET-self path + stale in-memory serve,
  per source facts above), but two sub-risks: (a) last-resort self-coordination
  blocked by partition-detection/grace-period if the FRET path doesn't offer
  self; (b) on a local block MISS, `CoordinatorRepo.get` consults cluster peers
  → dials A → gater denies → unknown whether it swallows (answers absent) or
  throws. If the window read throws deterministically: DELETE only the
  per-checkpoint `resolvePeerAddrs` assert (keep zero-connection + A-side-zero
  + peerStore-empty checks), rely on the pre-sever bracket assert (already in
  the file at baseline) plus the fact that the link step's dial can only have
  gotten C's address from the record path (peerStore proven empty every
  checkpoint) — and state that weakening HONESTLY in the review handoff. Do
  NOT weaken silently.
- If the reconcile pass itself fails unpinned (`listMembers` throwing on
  isolated B): that means an isolated node cannot reconcile AT ALL — a real
  product finding; capture DEBUG='sereus:cadre:node' output and file a fix/
  ticket for cadre-core rather than bending this scenario.
- Watch closing asserts on first green run: `writePin.callCount() > 0`
  (C-side reads around the write consult pinned `findCoordinator`) and
  `carryPin.callCount() > 0` (B's carry read) — if one is 0, rethink that
  assert rather than deleting it.
- Re-run isolation scenario unchanged:
  `yarn workspace @serfab/integration-tests test src/scenarios/control-cohort-three-node-isolation.integration.ts`
- Write `review/` handoff (honest scope: carriage proven in READ direction
  only; write direction implied by cohort seating; note the window weakening if
  taken), delete this ticket.

## Prior-run facts still valid

`reconcileControlCohort` single-flight; `registerSelf` returns `'refreshed'`;
`hangUp` takes a `PeerId` (`peerIdFromString`); `readCohort` takes a `Libp2p`;
`pinCoordinator` patches both seams (`findCoordinator` replace + `findCluster`
reorder-wrap), restores in reverse internally, `callCount()` counts
`findCoordinator` only; `waitUntil` defaults 10s/100ms and swallows throwing
conditions; vitest picks up `src/**/*.integration.ts`; membership gater
preserves caller outbound hooks; `@libp2p/interface` nests multiaddr v13 (no
`getPeerId()` — gater uses `getComponents()`); Optimystic live reads are never
local-only (they sync via `collection.update()` first).
