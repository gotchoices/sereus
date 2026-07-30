description: Add a three-node network test proving a party member automatically connects to a sibling it only heard about second-hand, with no shortcut connection helping it along.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts (NEW), packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts (2-node sibling — copy its nodeConfig/makeOwnOwner helpers), packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts (connectionsTo helper, listenAddrs:[] client-only trick), packages/cadre-core/src/cadre-node.ts (reconcileControlCohort ~1609, resolveControlDialAddrs ~1746, resolvePeerAddrs ~1515, registerSelf ~1286, listAuthorizedMembers ~3739), packages/cadre-core/src/control-cohort.ts (selection policy), packages/integration-tests/src/harness/index.ts (waitUntil, waitForCadrePeerConverged, sleep)
difficulty: medium
----

## What this closes

`reconcileControlCohort` proactively dials a node's cadre siblings so the
`CadreControl` collections form a connected, replicating cohort. Its existing
acceptance test (`control-cohort-auto-convergence.integration.ts`) proves
end-to-end convergence with zero test-side `dial()`, but in a **2-node party the
first connection is necessarily made by the cold-start path** (`applySeed`'s
owner dial) — the reconcile routine can only dial siblings already present in the
replicated `CadrePeer` table. So the case where **the reconcile dial is the only
thing that forms a connection** has no end-to-end proof today.

This ticket adds a 3-node scenario where B reaches C *only* because C's signed
`CadrePeer` address row replicated to B through A, and B's reconcile pass then
dialed it.

## Topology (resolved design)

```
        A  (storage, own owner, listens on ws, NO relay)
       / \
      /   \   both cold-start via applySeed (production path)
     B     C
     ^     |
     |     |  C listens on ws; C's peerStore holds no dialable addr for B
     +-----+  B: listenAddrs: []  → C physically CANNOT dial B
        B dials C — the assertion under test
```

- **A** — `profile: 'storage'`, own owner (`makeOwnOwner`), `listenAddrs:
  ['/ip4/127.0.0.1/tcp/0/ws']`, **no relay** (three local nodes + a relay gives
  unstable circuit links — see the design notes in `push-wake-e2e.integration.ts`).
- **B** — `profile: 'transaction'`, **`listenAddrs: []`** (the client-only
  RN/phone shape). This is the linchpin: B is undialable, so any B↔C connection
  is necessarily one **B** opened, and B's own `CadrePeer` row carries no addrs
  so C can never resolve a way back.
- **C** — `profile: 'transaction'`, listens on ws so B has something to dial.
- **B and C both pin A's owner key** via `trustedOwners: { pinnedKeys: [aOwnerPub] }`
  (`CadreNodeConfig.trustedOwners`, cadre-node.ts:826). This makes each node's
  authorized-member predicate real rather than riding the empty-anchor
  fail-open carve-out in `admitInboundControlConnection` (cadre-node.ts:1040), so
  C admits B's inbound because B's row carries A's verifiable voucher. With the
  anchor pre-pinned, `applySeed(seed)` needs **no** per-call `trustPolicy`
  override — the default anchored policy accepts A's seed.

## Ordering (this is what makes the isolation claim true)

Each numbered step must happen in this order; the isolation proof is an ordering
property, not an assertion.

1. Start A, `makeOwnOwner(A, aKey)`. Wait until A's own `CadrePeer` row has
   `addrs.length > 0` (its self-publish rides the ~1s start timer).
2. Start B. `A.authorizePeer(bPeerId)` → `seedB = A.createSeed()` →
   `B.applySeed(seedB)`. **C does not exist yet**, so `seedB.peers` provably
   cannot name C — assert that. Wait for B's outbound connection to A.
3. Start C. **Before C is authorized**, assert B has no connection to C and no
   dialable peerStore address for C. This checkpoint is non-racy: at this instant
   nothing anywhere has told B that C exists.
4. `A.authorizePeer(cPeerId)` → `seedC = A.createSeed()` → `C.applySeed(seedC)`.
   `authorizePeer` writes C's row with `Sig` null and an empty `Multiaddr`
   (seed-bootstrap.ts:309) — deliberately not yet resolvable.
5. Drive C's self-publish: `waitUntil(async () => (await C.registerSelf()) === 'refreshed')`.
   C is not its own owner, so `publishSelfRecord` can only take the
   `updateSelfPeerRecord` branch, which needs C's row to have replicated from A
   first. Polling `registerSelf()` is the production API (the CLI and the
   heartbeat call the same method); the default heartbeat is 7.5 min, far outside
   the test window, which is why the test drives it.
6. Wait until C's row is resolvable **on B**: `(await B.resolvePeerAddrs(cPeerId)).length > 0`.
   That gate is the full signed path — record present, `publicKey ↔ peerId`
   binding, self-signature, freshness, trust policy (cadre-node.ts:1515).

## The two cases (one file, one `describe`, shared `bootTrio()` helper)

`reconcileMs` is read once when the refresh timers are wired, so it cannot be
changed mid-test — hence two `it()` blocks over two boots.

**Case 1 — automatic.** B configured with `controlCohort: { reconcileMs: 2_000 }`.
After step 6, just wait: assert B acquires a connection to C with
`direction === 'outbound'`. Then assert the cohort works end to end — call
`C.registerSelf()` once more and wait for B's view of C's record to reach the new
`updatedAt` (a row **C** authored after B↔C formed). Be honest in the comment:
that row may still arrive via A; it is an end-state cohort assertion, not a proof
of the B↔C wire.

**Case 2 — reconcile is load-bearing (the isolation proof).** B configured with
`controlCohort: { reconcileMs: 600_000 }` so the recurring timer never fires
inside the test. After step 6:
  - Negative window: for ~5s (poll, then assert at the end) B has **no**
    connection to C, while `B.resolvePeerAddrs(cPeerId)` is non-empty and B's
    peerStore holds **no** dialable addr for C. This is what proves no other
    subsystem (FRET stabilization, cohort-topic, connection manager) forms the
    link — FRET learns C's peer id from A's announce snapshot but its
    `dialProtocol(peerId)` has no address to use.
  - Then one explicit `await B.reconcileControlCohort()` — the same public
    routine the timer calls, not a raw `dial()`.
  - Assert B now has an `outbound` connection to C, and that
    `B.resolveControlDialAddrs`' primary source was the record, i.e.
    `resolvePeerAddrs` was non-empty *before* the dial (already asserted) while
    the peerStore was empty for C — so the cold-start fallback
    (`peerStoreAddrs`, cadre-node.ts:1759) could not have supplied the address.

Both cases must contain **zero** test-side `getControlNode().dial()`.

## Edge cases & interactions

- **peerStore fallback masking the record path.** `resolveControlDialAddrs` tries
  `resolvePeerAddrs` first and only then the peerStore, so the record path wins
  whenever it resolves. The test must still assert peerStore-empty-for-C *before*
  the dial, otherwise a future regression that breaks the record path would pass
  on the fallback. After the dial, identify populates B's peerStore with C —
  assert emptiness only at pre-dial checkpoints.
- **Transient inbound deny on C.** If B dials C before B's row has replicated to
  C, `admitInboundControlConnection` denies (cadre-node.ts:1024 NOTE) and the
  connection dies moments after `dial()` resolves. Never assert on a `dial()`
  return value; always poll for the settled connection state. In case 2 the
  single explicit pass may lose this race — poll `reconcileControlCohort()` in a
  `waitUntil` loop rather than calling it exactly once, and say so in a comment.
- **Deny lands after upgrade.** The membership gater denies after the dialer's
  upgrade completes, so a refused dial can look momentarily successful. Poll for
  `direction === 'outbound' && status === 'open'` and re-check, mirroring
  `control-cohort-cold-start-retry.integration.ts` step 3.
- **C's self-update must replicate to A.** C is `transaction` profile and A is
  the storage node; `updateSelfPeerRecord` commits through the cohort. If this
  turns out not to converge, that is a real product finding — do **not** paper
  over it by having A write C's record with a test-held key (the
  `seedReceiverRecord` shortcut in `push-wake-e2e.integration.ts`), because an
  owner-written row carries `Sig` null and `resolvePeerAddrs` rejects it, which
  would silently gut the test. File a `fix/` ticket instead.
- **Seed contents.** `createSeed()` snapshots the whole `CadrePeer` table, so
  `seedC` legitimately names B — harmless, because B's row has no addrs and
  `applySeed` only dials owner-flagged peers. Assert `seedB` does not name C.
- **Record freshness.** `DEFAULT_PEER_RECORD_MAX_AGE_MS` is 15 min, well beyond
  the test; no freshness handling needed, but do not add fake timers.
- **B's own row.** With `listenAddrs: []`, B's self-publish writes an
  address-less row. Confirm this does not make `registerSelf` throw or the
  `CadrePeer` update constraint reject an empty `Multiaddr`; if it does, that is
  a product bug worth its own ticket, not a test workaround.
- **Selection policy.** `selectControlCohortDials` always dials backbone (owner)
  members and fills non-owners up to `targetDegree` (default 6); with two
  siblings nothing is capped. Leave `targetDegree` at its default so the test
  exercises the shipped policy.
- **Teardown.** Stop C, B, A in a `finally`, tolerating undefined (a boot that
  threw), exactly as the sibling scenarios do.
- **Timeouts.** Each `it()` gets ~120_000 ms; use `waitUntil` with explicit
  `description` strings for every wait — no bare `sleep` except the negative
  window, and that one polls rather than sleeping blind.

## TODO

- Create `packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts`
  with a file-header comment stating what this proves that the 2-node scenario
  cannot, and why B listens on nothing.
- Port the `wsTransports` / `nodeConfig` / `makeOwnOwner` / `connectionsTo`
  helpers from the two sibling control-cohort scenarios; extend `NodeOpts` with
  `pinnedOwnerKeys?: string[]` mapping to `trustedOwners.pinnedKeys`.
- Write `bootTrio({ reconcileMsB })` performing ordering steps 1–6 and returning
  `{ A, B, C, aPeerId, bPeerId, cPeerId, seedB }`.
- Implement case 1 (automatic, `reconcileMs: 2_000`).
- Implement case 2 (negative window + explicit reconcile passes,
  `reconcileMs: 600_000`).
- Run the file: `yarn workspace @serfab/integration-tests test 2>&1 | tee /tmp/cohort3.log`
  (stream the output — never silent-redirect; the runner kills on a 10-min idle).
  Run it at least twice to shake out ordering flake.
- `yarn lint` and the package typecheck must pass.
- Add one line to `docs/cadre-consistency.md` (or the Control Network section of
  `docs/architecture.md`, whichever already describes the cohort reconcile)
  noting that the reconcile-as-sole-connector path now has an e2e proof, and
  which scenario file holds it.
- Hand off to `review/` with an honest note on: which assertions are ordering
  properties vs. wire proofs, and whether the case-2 negative window proved
  stable across runs.
