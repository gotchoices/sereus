description: A networking test that wakes a sleeping machine through a relay was rebuilt so every machine in a group shares one designated leader instead of each claiming to be its own; the rebuilt test is now turned back on, a sibling test was tidied the same way, and the work passed review.
prereq:
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/integration-tests/src/harness/test-network.ts (waitForCadrePeerConverged, waitForCrossNodeControlSync), packages/cadre-core/src/cadre-node.ts (authorizePeer ~1883, registerSelf/publishSelfRecord ~593, enableRelay default ~492), packages/cadre-core/src/strand-cohort.ts (deriveCohortSeed)
difficulty: medium
----

## What this was

`push-wake-e2e.integration.ts` scenario 2 (`delivers a wake to a NAT'd receiver
over a circuit-relay (signaling-first) dial`) was `it.skip` because it used the
in-memory-era recipe where every node self-genesises its own `AuthorityKey`. Once the
`CadreControl` store became party-shared and replicated (`control-db-network-backed`),
two self-genesis authorities in one party collide on the `AuthorityKey.Authorized`
bootstrap CHECK. The implement ticket re-authored the topology to a single shared
authority and un-skipped it, and de-flaked scenario 1 the same way.

**Test/topology rework only — no production code changed.**

## What changed (implement)

- **Scenario 2 (un-skipped):** relay `L` is now `profile:'storage', enableRelay:true`
  AND the party's sole authority; it genesises alone, then `L` writes S's membership and
  Rx's circuit address record inside a 2-node `{L,S}` window. Rx's circuit addr is
  constructed from `rxKey` before Rx starts; Rx joins last and converges via replication.
- **Scenario 1 (de-flaked):** sender `S` is the sole authority (ephemeral identity +
  explicit authority key); Rx is a plain member that learns S's membership by replication
  (`waitForCadrePeerConverged`) instead of local seeding.
- **Docs:** file-header rewritten to the "single shared authority" framing; stale
  `it.skip` comment block removed.

## Review findings

**Verdict: APPROVED.** Implementation is sound; one minor comment-accuracy fix applied
inline. No production code was at risk (test-only change). All gates green.

### What was checked

- **Implement diff read first, fresh eyes** (`git show 0ebea2b`), before the handoff.
- **Topology assumptions verified against production source** (not taken on faith):
  - `authorizePeer(peerId)` with no multiaddrs writes an **addr-less** `CadrePeer` row
    (`cadre-node.ts:1883`) — so scenario 1's `S.authorizePeer(sPeerId)` cannot pollute
    Rx's strand-resume cohort seed. ✔
  - `deriveCohortSeed` (`strand-cohort.ts:33-47`) skips rows with no `multiaddr`, so an
    addr-less membership row is never recruited as a bootstrap addr. ✔
  - `enableRelay = network?.enableRelay ?? (profile === 'storage')` (`cadre-node.ts:492`)
    — confirms handoff concern #4: scenario 1's storage-profile `S` defaults to a relay.
    Harmless for a direct-dial 2-node case (no NAT, no circuit links). ✔
  - `publishSelfRecord` (`cadre-node.ts:593-631`): a node with a stable identity whose row
    already exists takes the **existing → `updateSelfPeerRecord`** branch (self-UPDATE),
    best-effort/non-fatal. Relevant to scenario 2 (see finding below). ✔
- **Replication is genuinely exercised, not faked:** the convergence predicates
  (`waitForCadrePeerConverged`, `waitForCrossNodeControlSync`) poll for the *sibling-written*
  row by exact `peerId` / via the real `resolvePeerAddrs` gate path — they cannot pass on a
  locally-seeded shortcut. ✔
- **Harness helpers exist and match usage** (`test-network.ts:275-302`). ✔
- **Docs sweep:** `docs/architecture.md:172` references the `control-network-cohort-discovery`
  follow-up; that plan ticket exists (`tickets/plan/control-network-cohort-discovery.md`),
  so scenario 2's documented "wakes an ACTIVE strand, not hibernating" limitation
  (handoff concern #3) is genuinely tracked. No stale skip references remain in docs. ✔
- **Lint + typecheck + tests:** `eslint` exit 0, `yarn typecheck` exit 0, all 4 scenarios
  green across **3 independent full-suite runs** this pass (6 total counting implement).

### Findings & disposition

- **MINOR (fixed inline):** scenario 2's comments claimed Rx "ONLY reads — no writes."
  That is technically false: Rx has a stable `privateKey` and L already wrote Rx's
  `CadrePeer` record, so Rx's background `registerSelf` self-UPDATEs its own row after
  start. The write is harmless (the signaling-first ordering assertion is captured
  *before* Rx starts; no assertion waits on a Rx-written row), but the comment would
  mislead a future debugger investigating an unexpected Rx write. Corrected both the
  header block and the inline comment to state Rx "writes nothing the assertions hinge on"
  with the self-UPDATE caveat, matching scenario 4's already-honest design note #1.

- **Considered, left as-is — strict circuit-addr equality (handoff concern #1):**
  `expect(circuitAddr).toBe(rxCircuitAddr)`. Judged worth keeping: it proves the
  *constructed* address (written to the record before Rx started) exactly equals Rx's
  *materialised* reservation listen addr — without it the test could vouch for a phantom
  slot. The libp2p multiaddr-normalisation brittleness is real but acknowledged in-comment
  and trivially recoverable (relax to a `/p2p-circuit/p2p/<rx>` containment check) if a
  libp2p bump ever breaks it. Not worth pre-emptively weakening a meaningful assertion.

- **Considered, no action — CI/real-network latency (handoff concern #2):** only
  exercised on loopback. 30s convergence + 90s test timeouts give headroom. A real
  slow-network soak is out-of-band (not agent-runnable); flagged for a few CI runs before
  fully trusting, as the handoff already noted.

- **No new tickets spawned.** No major findings. The one deferred limitation (hibernating
  NAT-receiver resume over a relay) is already tracked by
  `tickets/plan/control-network-cohort-discovery.md`.

### Empty categories (explicit)

- **Correctness bugs:** none — topology verified against production semantics above.
- **Resource cleanup:** none — every scenario stops all nodes in `try/finally`.
- **Type safety:** none — no `any`, typecheck clean.
- **Error handling:** n/a — pure integration test; failures surface through assertions.

## How to validate

```
cd packages/integration-tests
yarn vitest run src/scenarios/push-wake-e2e.integration.ts --reporter=verbose
yarn typecheck
```

Expected: all FOUR scenarios green (scenario 2 no longer skipped).
