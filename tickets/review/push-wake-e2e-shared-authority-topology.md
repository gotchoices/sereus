description: A networking test that wakes a sleeping machine through a relay was rebuilt so every machine in a group shares one designated leader instead of each claiming to be its own; the rebuilt test is now turned back on and a sibling test was tidied the same way.
prereq:
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (scenario 1 ~252-303; scenario 2 ~318-435; file-header topology notes ~18-79), packages/integration-tests/src/harness/test-network.ts (waitForCadrePeerConverged, waitForCrossNodeControlSync), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (the proven 2-node convergence recipe this mirrors)
difficulty: medium
----

## What this was

`push-wake-e2e.integration.ts` scenario 2 (`delivers a wake to a NAT'd receiver
over a circuit-relay (signaling-first) dial`) was `it.skip` because it used the
in-memory-era recipe where every node self-genesises its own `AuthorityKey`. Now
that the `CadreControl` store is party-shared and replicated
(`control-db-network-backed`), two self-genesis authorities in one party collide on
the `AuthorityKey.Authorized` bootstrap CHECK (`CHECK constraint failed: Authorized`).
This ticket re-authored the topology to a single shared authority and un-skipped it,
and (the "ideally" secondary) de-flaked scenario 1 the same way.

**Test/topology rework only — no production code changed.** The
`AuthorityKey.Authorized` bootstrap branch was deliberately left untouched (the
collision is the correct shared-authority semantic, not a bug).

## What changed

### Scenario 2 (un-skipped) — relay L is the sole authority

- `L` is now `profile: 'storage', enableRelay: true` AND the party's sole authority
  (`makeOwnAuthority(L, lKey)`), genesis ALONE before S/Rx connect. `S` and `Rx` are
  plain members that never genesis.
- Both control writes happen inside the 2-node `{L, S}` window (the proven
  `control-db-two-node-convergence` recipe): `L.authorizePeer(sPeerId)` (S's
  membership) and `seedReceiverRecord(L, rxPeerId, rxKey, [rxCircuitAddr, syntheticDirect])`
  (Rx's self-signed address record).
- `rxCircuitAddr` is **constructed** as `` `${lAddr}/p2p-circuit/p2p/${rxPeerId}` ``
  from `rxKey` BEFORE `Rx` starts (`rxPeerId = peerIdFromPrivateKey(rxKey)`), so the
  address-record write precedes Rx joining the cohort. The synthetic-direct addr is
  kept so the signaling-first ordering assertion (`resolved[0]` contains `/p2p-circuit`)
  stays meaningful.
- `S` converges on Rx's record via `waitForCrossNodeControlSync` (real resolve path)
  BEFORE Rx starts. `Rx` starts LAST (NAT'd: `listenAddrs:[`` `${lAddr}/p2p-circuit` ``]`,
  `bootstrapNodes:[lAddr]`), waits for its relay reservation, then converges on S's
  membership via `waitForCadrePeerConverged` — with NO local `Rx.authorizePeer`.
- The strand is brought up ACTIVE (`mode:'bootstrap'`, never hibernated) so the wake
  hits the "already live → accepted" branch; the relayed dial over the limited circuit
  connection is the real subject.

### Scenario 1 (de-flaked) — sender S is the sole authority

- `S` is now `profile:'storage'` with an EPHEMERAL identity + explicit authority key
  (`makeOwnAuthority(S, sKey)`); `Rx` is a plain hibernating member (no `makeOwnAuthority`).
- `connectControlNodes(Rx, S)` forms a direct 2-node `{S, Rx}` cohort; `S` writes its
  own membership (`authorizePeer(sPeerId)`) and Rx's address record. `Rx.isMember(S)`
  now passes via REPLICATION (`waitForCadrePeerConverged`), not local seeding. `S`
  resolves Rx's record from its OWN write (local).
- Ephemeral S identity is deliberate: it prevents S self-publishing an addr-bearing
  `CadrePeer` row that would (wrongly) be recruited into Rx's strand-resume cohort —
  the same invariant scenario 4's design note #3 documents.

### Docs

- File-header rewritten: the "locally-seeded vs replication-backed" framing is replaced
  by a "single shared authority" section enumerating which node is the authority in each
  scenario (S / L / A) and noting scenario 3 is the lone genesis-local-only exception.
  Stale `it.skip` / "skipped scenario 2" comment block removed.

## How to validate

```
cd packages/integration-tests
yarn vitest run src/scenarios/push-wake-e2e.integration.ts --reporter=verbose
yarn typecheck
```

Expected: **all FOUR scenarios green** (scenario 2 no longer skipped). These are
real-libp2p tests; each scenario runs ~0.2–1.5s locally.

Done during implement:
- Full suite green **3 consecutive runs** (flakiness check the ticket asked for).
- `yarn typecheck` clean (exit 0).
- `yarn eslint …/push-wake-e2e.integration.ts` clean (exit 0).

## Things a reviewer should scrutinize (honest gaps)

1. **The tight circuit-addr equality assertion.** Scenario 2 asserts
   `expect(circuitAddr).toBe(rxCircuitAddr)` — the constructed addr must exactly equal
   the materialised reservation listen addr. It passed every run, but it depends on
   libp2p's multiaddr string normalisation; if a libp2p bump changes the form, this is
   the first thing to break. The actual routing is independently proven by `pushWake`
   succeeding, so relaxing this to a containment check (`/p2p-circuit/p2p/${rxPeerId}`)
   would be a safe de-risk if it ever flakes. Judge whether the strict assert is worth
   its brittleness.

2. **Localhost speed hides real-network latency.** All four scenarios complete in
   ~1s on loopback with FRET-fast convergence. CI on slower/real networks is the real
   flakiness risk; the convergence waits use 30s `timeoutMs` and the test timeouts were
   bumped 60s→90s for headroom, but this has only been exercised locally. Worth a few
   CI runs before trusting it.

3. **Scenario 2 wakes an ACTIVE strand, not a hibernating one.** A *hibernating* NAT
   receiver driven to `active` is NOT proven here: the woken strand's `networked` resume
   would try to recruit the relay/server peers and fail super-majority — the known
   `control-network-cohort-discovery` gap (already tracked by `tickets/plan/control-network-cohort-discovery.md`).
   This is a deliberate, documented limitation (file-header "Scenario 2 — NOT hibernated"
   note), not a regression. No new ticket spawned because the gap is already tracked.

4. **Scenario 1's S is now storage + relay-by-default.** `profile:'storage'` flips
   `enableRelay` to true (cadre-node.ts:492). For this direct-dial 2-node case that is
   harmless (no NAT, no circuit links), and the green resume-to-active confirms S is not
   recruited into Rx's strand cohort (S has no addr-bearing `CadrePeer` row). Still worth
   a sanity read that the de-flake didn't trade timing-luck for a different subtle coupling.

5. **No production code was touched** — so the only risk surface is the test's own
   topology assumptions. The reviewer should treat the four green scenarios as a floor,
   not proof the production replication path is bug-free.
