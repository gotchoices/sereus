----
description: When a node has other known members that are currently switched off or unreachable, reading or writing its own settings must answer from local data and never freeze. Add the test that proves it.
prereq:
files: packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/peer-record-resolution.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/control-cohort.ts
difficulty: hard
----

# Coverage: control-DB reads/writes with known-but-offline peers must not hang

## What this adds

One new spec, `packages/cadre-core/test/control-database-offline-peers.spec.ts`, that stands up a
**real** `CadreNode` whose control database already holds membership rows for peers that are not
reachable, then runs the full set of control reads and writes under per-operation deadlines and
asserts an explicit outcome for each.

Plus a small shared-helper extraction so this spec and the existing solo spec do not carry two
copies of the same harness.

## Where this sits

`control-database-solo.spec.ts` covers the **cadre of one** — no siblings at all. This ticket
covers the next shape: the node knows about siblings, and none of them answer. That is the normal
state of a phone + laptop setup most of the day.

Two neighbouring tickets cover different questions; do not merge with either:

- `debt-control-write-availability-degraded-cohort-member` (plan/, sequence 11) — members that are
  **connected but slow**. Those *do* enter the write cohort and count against the approval
  threshold. This ticket's peers never enter the cohort at all.
- `control-db-convergence-optimystic-p2p` (blocked/) — data not replicating **between** nodes once
  a group forms. This ticket is about a single node's liveness when its peers are absent. If the
  new spec turns out to fail for that same substrate reason, record the link in the handoff rather
  than duplicating the blocked ticket.

## Expected behaviour (assert the strong form)

Every row this node reads is already in its own local control database, and Optimystic downsizes a
cohort it cannot fill (`CONTROL_CLUSTER_POLICY.allowDownsize`, `quereus-plugin-sereus/src/cluster-size.ts`),
so the correct outcome is **answer locally**, not "fail fast":

| Operation | Required outcome |
| --- | --- |
| `db.hasOwnerKey()` / `db.getOwnerKeys()` | resolves with the genesis owner key |
| `db.queryCadrePeers()` | resolves listing self **and** every offline peer |
| `db.queryPeerRecord(offlinePeerId)` | resolves with the row, addresses intact |
| `node.resolvePeerAddrs(offlinePeerId)` | resolves with the authorized address (see anti-vacuity note) |
| `node.isMember` / `node.listMembers` / `node.listAuthorizedMembers` | resolve, offline peer included |
| `node.registerSelf()` | resolves `'inserted'` (first) / `'refreshed'` (re-run) |
| `node.authorizePeer(anotherOfflinePeer)` | resolves; a follow-up `queryCadrePeers()` shows both |
| `node.reconcileControlCohort()` | **resolves** (never rejects — its per-sibling failures are swallowed by contract) |
| `node.stop()` | resolves inside the lifecycle budget, including with a dial in flight |

A rejection on any of the read/write rows above is a finding, not an expected alternative — the
data is local. "Did not hang" alone is too weak: a silently empty `queryCadrePeers()` where the
local rows exist is also a failure, so assert contents, not just settlement.

## Harness shape

### The offline peer must be *resolvable*, or the test is vacuous

`CadreNode.authorizePeer(peerId, addrs)` writes an owner-vouched row with `Sig: null`.
`resolvePeerAddrs` requires a valid **self**-signature and a record no older than
`DEFAULT_PEER_RECORD_MAX_AGE_MS` (15 min, `peer-record.ts`). An unsigned or stale row resolves to
`[]`, `resolveControlDialAddrs` then misses the peerStore too, and **no dial is ever attempted** —
the spec would pass while exercising nothing.

So mint each offline peer the way `peer-record-resolution.spec.ts` already does
(`insertForeignMember`, lines 56-69): generate an Ed25519 key, derive the peerId, `signPeerRecord`
over fresh addresses with `updatedAt: Date.now()`, insert via
`node.getSeedBootstrapService()!.insertSelfPeerRecord(record)`. Then **assert
`resolvePeerAddrs(offlinePeerId)` returns the address** before the rest of the operations run —
that assertion is the guard that the dial path is armed.

### Two flavours of unreachable

- **departed** — a second real `CadreNode` (its key generated in-test so we can sign its record)
  started on `/ip4/127.0.0.1/tcp/0/ws`, its real listen address captured, then `stop()`ed. The
  address is dead; the OS refuses the connection immediately. This is the ticket's originally
  suggested shape and the one that also proves a genuinely-published address is what got left
  behind.
- **blackhole** — a synthetic peer at `/ip4/192.0.2.<n>/tcp/4001/ws/p2p/<id>` (RFC 5737 TEST-NET-1,
  guaranteed unrouted). The connect never gets an answer, so this is where a freeze would live.
  Assert only the liveness property here, never timing: if some CI network answers TEST-NET-1 the
  case silently degrades into the refused flavour, which must still pass.

### Node config

Start from the solo spec's config: WebSockets-only transports, `listenAddrs: []` (the phone/browser
posture — see `types.ts` `NetworkConfig.listenAddrs`), empty `bootstrapNodes`, `MemoryRawStorage`,
`InMemoryKeyStore`, a fresh random `partyId` per test. Genesis exactly as the solo spec does
(`getIdentityOwnerKey` → `ensureOwnerKey` → `initializeSeedBootstrap` → `registerSelf`).

### Deadlines

Reuse cadre-core's own `withTimeout` (`control-stream.ts`) exactly as the solo spec's `within`
does, so a freeze reports as `offline-peer control op <label> timed out after <ms>ms` rather than a
bare vitest timeout. Budgets: 15 s per control op; 30 s for a `reconcileControlCohort()` pass
(it deliberately dials dead addresses, and js-libp2p applies its own dial timeout underneath);
30 s for `start()`/`stop()`.

## Test matrix

Core, for **both** profiles (`transaction` and `storage` — they differ in `fretProfile`,
`enableRelay`, and `arachnode.enableRingZulu`, so they take different bring-up paths):

- departed peer × profile
- blackhole peer × profile

Plus, at `transaction` only:

- **three blackhole peers** — `runReconcileControlCohort` dials siblings **sequentially**
  (`cadre-node.ts` ~line 1693), so N unreachable siblings cost N × dial timeout in one pass. The
  default out-degree cap is 6 (`DEFAULT_CONTROL_COHORT_TARGET_DEGREE`, `control-cohort.ts`), which
  is the worst realistic case; three is enough to show the cost accumulates.
- **concurrent dial storm** — kick a reconcile pass off unawaited (`void node.reconcileControlCohort()`),
  immediately run the whole read/write set under their deadlines, then await the pass under its
  own deadline. This is the assertion that a dial storm cannot block a local read or write.
- **circuit-relay transport variant** — same blackhole case with
  `transports: [webSockets(), circuitRelayTransport()]`. `@libp2p/circuit-relay-v2` is already a
  cadre-core devDependency, so this is free. It closes half of the "a hang whose trigger is a
  transport" gap named in the source ticket.

WebRTC is deliberately **out of scope**: cadre-core does not depend on `@libp2p/webrtc` and it needs
a browser or `node-datachannel` runtime, so adding it here is a dependency + runtime question rather
than a test-harness one. Filed as `backlog/debt-webrtc-transport-control-liveness-coverage`.

## Shared-helper extraction

`control-database-solo.spec.ts` owns `within`, `expectNotListening`, `readColumn`, `soloConfig`, and
`freshPartyId`. The new spec needs all five. Lift them into
`packages/cadre-core/test/control-db-node-helpers.ts` — the same convention as the existing
`control-constraint-helpers.ts`, `membership-gate-helpers.ts`, `wake-stream-helpers.ts` — and have
both specs import them:

```ts
/** `<scope> control op <label> timed out after <ms>ms` on a freeze. */
export function withinOp<T>(scope: string, label: string, ms: number, op: () => Promise<T>): Promise<T>;

export function expectNotListening(node: CadreNode): void;
export function readColumn(node: CadreNode, sql: string, column: string): Promise<unknown[]>;
export function freshPartyId(tag: string): string;

export interface ControlNodeConfigOpts {
	partyId: string;
	profile: NodeProfile;
	keyStore: InMemoryKeyStore;
	storage: MemoryRawStorage;
	/** Defaults to `[webSockets()]` — the mobile/browser posture. */
	transports?: NetworkConfig['transports'];
	/** Defaults to `[]` — no inbound connections, as RN/browser cannot accept them. */
	listenAddrs?: string[];
}
export function controlNodeConfig(opts: ControlNodeConfigOpts): CadreNodeConfig;
```

The solo spec keeps its behaviour bit-for-bit; only the timeout label gains its `'solo'` scope
argument. `control-database-solo.spec.ts`'s closing comment ("Not covered here, deliberately: a
cadre of *more than one* whose peers are offline … see backlog
`debt-control-db-offline-peer-no-hang-coverage`") must be updated to point at the new spec.

## If the spec finds a real hang

That is the point of the ticket — it is a **finding**, not a test bug. Handling, in order:

1. If the fix is bounded and local (e.g. a missing deadline on a dial or resolve path inside
   cadre-core), land it here and keep the assertion in its strong form.
2. If the root cause sits in Optimystic or otherwise outside this repo, land the rest of the spec
   green, file `tickets/fix/bug-<slug>.md` carrying the exact failing case as a code block plus the
   observed symptom, and say so explicitly in the review handoff.
3. `it.skip`, `describe.skip`, commenting the case out, or weakening an assertion to get a green run
   are all forbidden.

## Edge cases & interactions

- **Anti-vacuity.** Every offline peer's `resolvePeerAddrs` must be asserted non-empty before the
  operation set runs. Without it the spec proves nothing (unsigned row → `[]` → no dial).
- **Record freshness.** `updatedAt` must be `Date.now()` at insert; a record older than 15 minutes
  stops resolving mid-test if a case ever runs that long.
- **Reconcile concurrent with ops.** Covered by the dial-storm case above. A reconcile pass calls
  `refreshMembershipGate` (read-only) while `authorizePeer` holds the control write lock via
  `mutateCadrePeer` — assert the write still completes inside its deadline with a pass in flight.
- **Serial dial accumulation.** Three (cap: six) unreachable siblings in one pass. Assert the pass
  resolves inside its budget and that no control op's deadline fired while it ran.
- **`stop()` with a dial in flight.** Start a reconcile against a blackhole, do not await it, call
  `stop()` under the lifecycle deadline. Shutdown must not wait on an unanswerable connect.
- **`committedAlone()` bookkeeping.** With zero connections every write is local-only, so
  `authorizePeer` queues into `pendingPeerWrites` for later re-replication. Assert that queueing
  does not change the returned outcome and that no drain fires (there is no 0→≥1 growth).
- **`storage` profile enables relay** (`enableRelay ?? profile === 'storage'`) while `listenAddrs`
  is `[]`. Confirm bring-up and teardown stay inside budget in that combination; it is the one
  config where a relay reservation attempt could interact with the missing listen address.
- **Refused vs never-answered.** The departed flavour rejects the dial promptly; the blackhole
  flavour may not settle until libp2p's own dial timeout. Both must leave control ops untouched.
- **Test isolation.** Fresh `partyId`, fresh `InMemoryKeyStore`, fresh `MemoryRawStorage` per node;
  every node stopped in a `finally`, including the departed second node if a case fails before its
  own `stop()`.
- **Read-back after a write is a separate assertion** from the write's return value — a write that
  returns `'inserted'` but whose read-back is empty is the silent-failure mode this spec exists to
  catch.

## Validation

Stream output (never redirect silently — the runner's idle timeout kills a quiet command):

```
yarn workspace @serfab/cadre-core vitest run test/control-database-offline-peers.spec.ts test/control-database-solo.spec.ts 2>&1 | tee /tmp/offline-peers.log
yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core.log
yarn workspace @serfab/cadre-core typecheck
yarn lint
```

`tsconfig.typecheck.json` already includes `test`, so the new spec and helper are typechecked.
If the stale-build guard (`test/global-setup.ts`) trips, rebuild the linked workspaces rather than
working around it.

Known pre-existing failure in this suite: one win32 `skipIf` in `key-store.spec.ts:231`
(`tickets/.pre-existing-known.md`). Anything else unrelated to this diff goes in
`tickets/.pre-existing-error.md` per the workflow rules — do not chase it here.

## TODO

### Phase 1 — helpers + core matrix

- Add `packages/cadre-core/test/control-db-node-helpers.ts` with `withinOp`, `expectNotListening`,
  `readColumn`, `freshPartyId`, `controlNodeConfig` (interface above)
- Rewrite `control-database-solo.spec.ts` to import them; keep its assertions and its 120 s/180 s
  test budgets unchanged, and update its trailing "not covered here" comment to name the new spec
- Add `control-database-offline-peers.spec.ts` with a `mintOfflinePeer` helper (Ed25519 key →
  `signPeerRecord` → `insertSelfPeerRecord`) that asserts `resolvePeerAddrs` non-empty before
  returning
- Cover departed × {transaction, storage} and blackhole × {transaction, storage} with the full
  operation table above
- Run both specs green

### Phase 2 — the stress and transport cases

- Three-blackhole sequential-dial case
- Concurrent dial-storm case (unawaited reconcile + full operation set + awaited pass)
- `stop()`-with-dial-in-flight case
- Circuit-relay transport variant of the blackhole case

### Phase 3 — close out

- Full `cadre-core` suite, `typecheck`, `lint`
- Update `docs/STATUS.md` where it describes control-DB liveness coverage
- Review handoff: state exactly which operations were asserted, what the measured worst-case
  reconcile pass cost, whether any hang was found and how it was disposed of, and that WebRTC
  transport coverage is deferred to `debt-webrtc-transport-control-liveness-coverage`
