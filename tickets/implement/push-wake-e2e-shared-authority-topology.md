description: A networking test pretended two machines in the same group could each declare themselves the boss; now that they share one group database only one boss is allowed, so the test must be rebuilt around a single shared boss before it can be turned back on.
prereq:
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (scenario 2 — the skipped "NAT'd receiver over a circuit-relay" test ~309; scenario 4 — the proven single-authority recipe ~480-564; helpers makeOwnAuthority ~164, seedReceiverRecord ~178, connectControlNodes ~205; scenario 1 — direct-dial sibling ~252), packages/cadre-core/src/control-schema.ts (AuthorityKey.Authorized bootstrap branch ~18-27), packages/cadre-core/src/control-database.ts (insertAuthorityKey ~515, queryCadrePeers ~402), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (the proven 2-node convergence recipe)
difficulty: medium
----

## Problem (reproduced)

Un-skipping scenario 2 (`delivers a wake to a NAT'd receiver over a circuit-relay
(signaling-first) dial`) and running it fails deterministically with:

```
QuereusError: CHECK constraint failed: Authorized
  ❯ DeferredConstraintQueue.evaluateEntry .../deferred-constraint-queue.ts
  ❯ ... Database.exec
```

The throw happens at `makeOwnAuthority(Rx, rxKey)` → `db.insertAuthorityKey(...)`.
Confirmed via `yarn vitest run src/scenarios/push-wake-e2e.integration.ts -t "NAT'd receiver"`
in `packages/integration-tests` — fails at ~2s, before any wake is attempted.

### Root cause (matches the fix-ticket hypothesis exactly)

`control-db-network-backed` routed the `CadreControl` tables to the default
optimystic network vtab (`control-database.ts` `setDefaultVtabName('optimystic')` +
`setDefaultVtabArgs({ transactor: 'network', ... })`), making the party's
`AuthorityKey` table a single **party-shared, replicated** store. Scenario 2
bootstraps BOTH `S` and `Rx` to relay `L` (`bootstrapNodes: [lAddr]`), so a control
cohort forms during `start()`. `S`'s genesis `AuthorityKey` replicates into the
shared collection, so by the time `makeOwnAuthority(Rx)` runs, Rx's genesis insert
sees `(select count(1) from AuthorityKey)` = 1 and the schema's bootstrap branch
`(select count(1) from AuthorityKey) <= 1` is **false**. Rx supplies no
cross-authority signature, so the deferred `Authorized` CHECK fails.

This is the **correct** shared-authority semantic — two independent self-genesis
authorities SHOULD collide on a shared network. The test encodes an in-memory-era
assumption (each node its own isolated authority). Do **not** weaken the
`AuthorityKey.Authorized` bootstrap branch.

## What already exists to copy

Scenario 4 in the same file (`wakes a member whose authorization and address were
learned by control-DB replication...`) **already implements** the network-backed
single-shared-authority pattern and passes:

- ONE authority node (`A`, `profile: 'storage'`) is the SOLE writer; `S` and `Rx`
  are plain members that call NEITHER `makeOwnAuthority` NOR `initializeSeedBootstrap`.
- The authority `A.authorizePeer(sPeerId)` writes `S`'s membership row, and
  `seedReceiverRecord(A, rxPeerId, rxKey, ...)` writes Rx's self-signed address
  record (one authority-signed insert carrying Rx's own `Sig`).
- Readers learn those rows by **pull-on-read** convergence
  (`waitForCadrePeerConverged`, `waitForCrossNodeControlSync`).

So **no new "join-an-existing-authority" helper is needed** — a plain member is a
node that simply never genesises. The job is to re-author scenario 2's topology to
the same single-authority shape, adapted for the NAT/relay specifics.

## Researched facts that constrain the design

- **Optimystic control dials traverse circuit-relay (limited) connections.**
  `optimystic/packages/db-p2p/src/libp2p-key-network.ts:294-316` opens every control
  stream with `runOnLimitedConnection: true`. So replication CAN cross a relay — but
  prefer not to depend on it (see commit-cohort note).
- **Multi-node control _commits_ are fragile under a star.** Scenario 4's own design
  note (file header + inline comment #2) records that a 3-member commit needs the
  cluster members to reach EACH OTHER; a star (only S→A, Rx→A) leaves S↔Rx unlinked
  and the commit "resets streams it cannot route". With Rx genuinely NAT'd, S↔Rx can
  only go over the relay, which is exactly the unstable link to avoid. **Therefore
  keep every control _write_ inside a 2-node cohort** (`reads`/pull-on-read are fine
  at any size — the proven 2-node convergence test does a single `connectControlNodes`
  and reads converge).
- **Rx's circuit dial address is deterministic.** The optimystic relay test
  (`db-p2p/test/circuit-relay-long-lived.spec.ts`) listens on `${relayAddr}/p2p-circuit`
  and the materialised listen addr is `<relayAddr>/p2p-circuit/p2p/<peerId>`. `lAddr`
  and `rxPeerId` (derived from `rxKey`) are both known before Rx starts, so Rx's
  circuit addr can be CONSTRUCTED as `` `${lAddr}/p2p-circuit/p2p/${rxPeerId}` ``
  — letting the address-record write happen before Rx joins the cohort.

## Recommended topology (single shared authority, zero multi-node commits)

Make the relay `L` the **sole party authority + storage hub** (it is already
dedicated transport infra; giving it the lone authority key is a legitimate
single-authority topology and mirrors scenario 4's `A` = authority + storage +
sole writer, which the 2-node convergence test proves). `S` and `Rx` are plain
members. Stage ALL writes in the `{L, S}` 2-node window, then start `Rx` last so it
only ever reads:

```
   L  (relay + storage + SOLE authority; genesis ALONE, before S/Rx connect)
  / \
 S   Rx        S, Rx: plain members (never genesis)
 (sender)  (NAT'd receiver, started LAST)

 control writes:  L.authorizePeer(S)            -> S's membership   (read by Rx)
                  seedReceiverRecord(L, Rx,...)  -> Rx's addr record (read by S)
                  ...both committed while ONLY {L,S} are connected.
 wake dial:       S --(circuit via L)--> Rx      (the test's real subject)
```

Sequence (each control write is a 2-node `{L,S}` commit):
1. Start `L` (relay + `profile: 'storage'`). `makeOwnAuthority(L, lKey)` — genesis
   ALONE (cohort `{L}`), so the lone `AuthorityKey` commits without collision.
2. Start `S` (plain member, sender). `connectControlNodes(S, L)` (both-sides
   confirmed) so the cohort is exactly `{L, S}`.
3. Construct `rxCircuitAddr = ` `` `${lAddr}/p2p-circuit/p2p/${rxPeerId}` ``. While
   only `{L, S}` are connected, on `L`:
   - `L.authorizePeer(sPeerId)` → S's membership row.
   - `seedReceiverRecord(L, rxPeerId, rxKey, [rxCircuitAddr, syntheticDirect])` →
     Rx's self-signed address record (keep the synthetic direct addr so the
     signaling-first ordering assertion — circuit sorts ahead of direct — survives).
4. Converge `S` on Rx's record: `waitForCrossNodeControlSync(S.getControlDatabase()!,
   async () => (await S.resolvePeerAddrs(rxPeerId)).length > 0, ...)`; assert
   `resolved[0]` contains `/p2p-circuit`.
5. Start `Rx` LAST (NAT'd: `listenAddrs: [` `` `${lAddr}/p2p-circuit` `` `]`,
   `bootstrapNodes: [lAddr]`). Wait for its control connection to `L` and for its
   relay reservation to materialise a `/p2p-circuit` addr in `controlAddrs(Rx)` (so
   the relay slot for the wake dial genuinely exists). Rx is NOT hibernated — keep
   scenario 2's "already live → accepted" design (see file header notes 56-78).
6. Converge `Rx` on S's membership via replication:
   `waitForCadrePeerConverged(Rx.getControlDatabase()!, sPeerId, ...)`, then assert
   `await Rx.isMember(sPeerId) === true` — with NO local `Rx.authorizePeer(...)`.
7. Bring up an ACTIVE strand on `Rx` (`mode: 'bootstrap'`, stays active — NOT the
   hibernating resume; that hits the known `control-network-cohort-discovery` gap).
8. `const ack = await S.pushWake(rxPeerId, strandId, 'nat wake')` — the relayed dial
   over the limited circuit connection. Assert `{ accepted: true, status: 'active' }`
   and the strand stays `active`.
9. Remove the `it.skip` (→ `it`) and the stale skip comment block above scenario 2
   (lines ~297-308), replacing it with a short note on the single-authority topology.

### Why this is robust

- Only ONE authority self-genesises in the party (`L`), so no `Authorized` collision.
- Every control WRITE is a clean `{L, S}` 2-node commit (matches the proven
  `control-db-two-node-convergence` recipe). Rx joins AFTER all writes and only reads
  — no 3-node commit, no S↔Rx control link, no full-mesh-over-relay flakiness.
- The relayed wake dial (the scenario's unique subject) is exercised end-to-end.
- This deliberately does NOT re-prove replication-backed authorization in depth
  (scenario 4 / `2-push-wake-replication-backed-authorization` owns that). Here
  replication carries exactly one fact (S's membership → Rx); Rx's address record is
  written on the authority and read by S, as in scenario 4.

### Fallbacks if step 3's constructed addr or step 6's convergence misbehave

- If constructing `rxCircuitAddr` proves wrong, log `controlAddrs(Rx)` once after the
  reservation to capture the exact form; the address-record write then has to move
  after Rx connects — in that case verify empirically whether the resulting 3-node
  `seedReceiverRecord` commit succeeds (optimystic dials now use
  `runOnLimitedConnection`), and only if it resets streams, keep the constructed-addr
  ordering.
- If Rx does not converge on S's membership through `L` alone, ensure `L` is
  `profile: 'storage'` (so it holds the `CadrePeer` blocks Rx pulls) and that the
  `Rx↔L` connection is both-sides confirmed before asserting `isMember`.

## Direct-dial sibling (scenario 1) — de-flake (secondary, "ideally")

Scenario 1 (`wakes a hibernating member over a real direct control dial`) currently
passes only because its two `makeOwnAuthority` nodes have NO `bootstrapNodes` and
never call `connectControlNodes`, so no cohort forms and each genesis stays
local-only — a timing-luck pass the fix ticket flags. Rework it to the same single
authority: make `S` the sole authority + sender (`makeOwnAuthority(S, sKey)`), `Rx` a
plain member, `connectControlNodes(Rx, S)` (direct — neither is NAT'd), have `S`
write its own membership (`S.authorizePeer(sPeerId)`) and seed Rx's record locally
(`seedReceiverRecord(S, ...)` — S is the authority, so this is a local read for S; do
it in the 2-node `{S, Rx}` window), then drive the existing hibernate→wake→active
flow. Keep it green. This is lower priority than scenario 2 (the ticket says
"ideally"); if it resists the 2-node staging, leave a short note and keep the
existing passing form rather than destabilising a green test.

## Validation

- `cd packages/integration-tests && yarn vitest run src/scenarios/push-wake-e2e.integration.ts --reporter=verbose 2>&1 | tee /tmp/pushwake.log`
  — all FOUR scenarios green (scenario 2 un-skipped). Stream the output (`tee`);
  these are real-libp2p tests (~10-60s).
- `cd packages/integration-tests && yarn typecheck`.
- The scenarios use `Date.now()`-suffixed party/strand ids and real WS transport;
  run a couple of times to confirm the relayed dial + convergence are not flaky.
- No production code change is expected — this is a test/topology rework. If any
  small cadre-core helper turns out genuinely necessary, keep it minimal and do NOT
  touch the `AuthorityKey.Authorized` bootstrap branch.

## TODO

- [ ] Re-author scenario 2 to the single-authority relay topology above; make `L` the
      relay + `storage` + sole authority (`makeOwnAuthority(L, lKey)`, genesis alone),
      and `S`/`Rx` plain members.
- [ ] Stage both control writes (`L.authorizePeer(S)`, `seedReceiverRecord(L, Rx, ...)`)
      inside the `{L, S}` 2-node window; construct `rxCircuitAddr` so the address-record
      write precedes Rx joining the cohort. Preserve the synthetic-direct addr so the
      signaling-first ordering assertion stays meaningful.
- [ ] Start `Rx` last; wait for its relay reservation; converge `S` (resolve) and `Rx`
      (`isMember`) via the existing `waitForCrossNodeControlSync` /
      `waitForCadrePeerConverged` helpers — assert gates pass with no local seeding on
      the consulting node.
- [ ] Wake an ACTIVE strand over the circuit; assert `{ accepted: true, status: 'active' }`.
- [ ] Remove `it.skip` and the stale skip-comment block (~297-308); add a short
      single-authority topology note. Update the file-header bullet for scenario 2
      (currently "Currently `it.skip`...") to reflect it now runs.
- [ ] (Ideally) De-flake scenario 1 to a single shared authority as above; keep green.
- [ ] Run the full push-wake suite + typecheck (stream output); confirm all four
      scenarios pass and the direct-dial + replication scenarios remain green.
