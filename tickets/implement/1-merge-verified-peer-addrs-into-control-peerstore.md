----
description: Each node already knows its teammates' verified network addresses, but only its own reconnect loop uses them — the layers underneath still try to dial a teammate by name with an empty address book and fail. Copy those verified addresses into the shared address book so every layer can dial.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/peer-addr-book.ts (new), packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/cadre-core/test/peer-addr-book.spec.ts (new)
difficulty: medium
----

Split from `plan/feat-merge-cadre-peer-addrs-into-libp2p-peerstore` (control-network arm;
the strand-network arm is `merge-strand-peer-addrs-into-strand-peerstore`). Filed from the
investigation of gotchoices/Optimystic#11 (NAT-only cohort members admitted but undialable;
replication hangs with clean logs).

## Problem

`CadreNode` publishes a signed, freshness-stamped address record for itself into its
`CadrePeer` row (`registerSelf`), and `resolvePeerAddrs(peerId)` (`cadre-node.ts:1645`)
returns another member's addresses after five gates: record present, `publicKey`↔`PeerId`
binding, self-signature, freshness (`DEFAULT_PEER_RECORD_MAX_AGE_MS`, 15 min), trust policy.

The only consumer is the control-cohort reconcile pass, which dials the raw multiaddrs
directly (`dialControlSibling`, `cadre-node.ts:1894`). The resolved addresses are never
written into the control node's libp2p **peerStore**. Everything below cadre-core that
dials by bare peer id — Optimystic's cluster client, repo client, FRET ping/announce, all
funnelling into `libp2p.dialProtocol(peerId, …)` — therefore sees an empty address book for
a sibling whose connection has dropped, and fails with `NoValidAddressesError` until a
reconcile pass happens to re-dial. On NAT'd/mobile topologies where connections churn, that
gap is where replication silently stalls.

The seed path already does the right thing (`seed-bootstrap.ts:736` merges seed peers into
the peerStore); the steady-state path does not.

## Design

### 1. A shared, expiry-proof merge helper — `packages/cadre-core/src/peer-addr-book.ts` (new file)

New file, not another method on `cadre-node.ts` (already 4,770 lines — see
`backlog/debt-cadre-node-single-file-size`), because the strand arm reuses it.

```ts
/** Outcome of one address-book merge, for logging and tests. */
export type MergeAddrsResult = 'merged' | 'restamped' | 'skipped' | 'failed';

export async function mergePeerAddrs(
  node: Libp2p,
  peerId: PeerId,
  addrs: Multiaddr[]
): Promise<MergeAddrsResult>;
```

Semantics:

- `addrs` empty → `'skipped'`, no write. **Never write on an empty resolve** — that is how a
  revoked / stale / untrusted peer's entry is allowed to age out on its own.
- Otherwise `await node.peerStore.merge(peerId, { multiaddrs: addrs })` → `'merged'`.
- Any throw (unparsable id, datastore failure, a test double without `merge`) is logged via
  the module's `debug` logger and folded to `'failed'`. Callers are best-effort loops; a
  peerStore failure must never abort a reconcile pass.

**The expiry trap this helper exists to work around.** `@libp2p/peer-store@12.0.10` stamps
each stored address with an `observed` timestamp and filters out addresses older than
`MAX_ADDRESS_AGE` (1 hour) on every read. On `merge`/`patch` it re-uses the *existing*
entry's timestamp instead of stamping `Date.now()` — `to-peer-pb.js:126` shadows its own
loop variable (`…addresses?.find(addr => uint8ArrayEquals(addr.multiaddr, addr.multiaddr))`,
always true, so it returns the first stored address). Consequence: once an entry is an hour
old, **no amount of re-merging revives it** — not even merging a brand-new address.
Measured against the installed package (`persistentPeerStore` over `MemoryDatastore`, with
`Date.now` advanced):

```
t+0m   merge → get: ['/ip4/1.2.3.4/tcp/1234']
t+50m  merge new addr → get: ['/ip4/1.2.3.4/tcp/1234', '/ip4/5.6.7.8/tcp/5678']
t+70m  merge → get: []            ← both addresses read as expired
t+71m  merge a *fresh* addr → get: []   ← still dead
```

`save()` is the one write path that omits `existingPeer` (`store.js:132`) and therefore
stamps `observed = Date.now()` — but it also *overwrites* protocols, metadata, tags and the
peer-record envelope with whatever the caller passes. Optimystic classifies peers by their
peerStore protocol list (`libp2p-key-network.ts` `membershipOf`), so blindly `save`-ing
would break cluster/repo routing.

So the helper does **merge, verify, then a field-preserving restamp**:

1. `const peer = await node.peerStore.merge(peerId, { multiaddrs: addrs })` — the returned
   `Peer` is already expiry-filtered, so it says whether the merge is actually visible.
2. If every address in `addrs` appears in `peer.addresses` → `'merged'`, done.
3. Otherwise the frozen-timestamp path bit: re-issue as
   `node.peerStore.save(peerId, { multiaddrs: union(peer.addresses, addrs), protocols,
   metadata, tags, peerRecordEnvelope })`, carrying every field forward from `peer`
   (`tags` need `Map<string, {value}>`, dropping the unreadable remaining TTL) → `'restamped'`.

Verified working against the installed package across a simulated 200 minutes: addresses
stay visible and `protocols`/`tags` survive.

Requirements for the implementer:

- Tag the workaround with a greppable tripwire at the call site, e.g.
  `// NOTE: peerStore.merge cannot refresh an address's observed timestamp in @libp2p/peer-store 12.0.10
  // (shadowed variable in to-peer-pb.js), so an entry silently dies at MAX_ADDRESS_AGE (1h). The save()
  // restamp below is the workaround; drop it once upstream stamps Date.now() on merge.`
- The restamp is a read-modify-write and is **not** atomic against a concurrent `identify`
  write to the same entry. The loss window is milliseconds and costs at most one identify
  update, recovered by the next identify push. Say so in a comment; do not add a lock.
- `save` with `multiaddrs` marks addresses uncertified (`isCertified: false`); a certified
  address that goes through the restamp path loses that flag. Acceptable — the addresses we
  merge were never certified to begin with.

### 2. Wire it into the control-cohort reconcile pass — `cadre-node.ts`

In `runReconcileControlCohort` (`cadre-node.ts:1758`), between the sibling enumeration and
the dial loop, resolve **every** sibling once and feed the address book:

- Loop over all `siblings` (not the `selectControlCohortDials` subset, and **not** skipping
  already-connected peers — a live connection is exactly the case where the address book
  needs to be warm before the connection drops).
- `const verified = await this.resolvePeerAddrs(sibling.peerId)`; on non-empty, call
  `mergePeerAddrs(this.controlNode, peerIdFromString(sibling.peerId), verified)`.
- Keep the resolved list in a `Map<string, Multiaddr[]>` and hand it to the dial loop so the
  pass does **one** `queryPeerRecord` per sibling, not two. `resolveControlDialAddrs`
  (`cadre-node.ts:1923`) keeps its cold-start `peerStoreAddrs` fallback but takes the
  already-resolved list instead of re-resolving; `dialControlSibling` takes the addresses.
- Re-guard `if (!this._running || !this.controlNode) return;` inside the loop, like the
  existing dial loop.
- Merge only `resolvePeerAddrs` output. Do **not** merge the `peerStoreAddrs` cold-start
  fallback back into the peerStore — those addresses came from there, and echoing them would
  restamp unverified seed addresses indefinitely.
- Log a pass summary line (siblings resolved / merged / restamped) alongside the existing
  `reconcileControlCohort: pass complete` line.

**Cost.** Today the pass issues one `queryPeerRecord` per *selected, disconnected* sibling
(≤ `targetDegree`); after this it issues one per sibling, every
`DEFAULT_CONTROL_COHORT_RECONCILE_MS` (15 s). A cadre is a handful of devices, so this is a
few extra local reads per 15 s. Leave a `NOTE:` tripwire at the loop: if cadres ever grow
large, batch the records into one query or merge only on record change.

## Edge cases & interactions

- **Revoked / stale / untrusted peer.** `resolvePeerAddrs` returns `[]` → no merge, no
  restamp → the existing entry ages out at `MAX_ADDRESS_AGE` on its own. Assert this: a
  sibling whose record fails the gates must produce **zero** peerStore writes. Do not add an
  active `peerStore.delete` on revocation — an address book entry grants no authority (the
  handshake authenticates the peer id, and `createMembershipConnectionGater` still denies).
- **Unparsable `peerId` in a `CadrePeer` row.** `peerIdFromString` throws → caught per
  sibling, pass continues.
- **peerStore write failure / test double without `merge`.** Folded to `'failed'` and
  logged; the pass still dials. Existing specs' fake control nodes
  (`cadre-node-control-cohort.spec.ts:41`, `control-db-node-helpers.ts`) expose only
  `peerStore.get` — they must keep passing, and should gain merge doubles where the new
  behaviour is asserted.
- **stop() racing the pass.** The merge loop awaits per sibling; re-guard `_running` and
  `controlNode` each iteration so a torn-down node is never written to.
- **Concurrent reconcile passes.** Already collapsed by `reconcileControlCohortInFlight`;
  the merge loop inherits that. Two nodes merging the same sibling concurrently is fine —
  different processes, different stores.
- **Address ordering.** `resolvePeerAddrs` returns signaling-first, but the peerStore sorts
  addresses alphabetically internally, so the relay-first preference does **not** survive
  into the address book. libp2p's own dial ranking takes over. Note it; do not fight it.
- **Multiaddr type duplication.** `cadre-node.ts:1943` already documents that the peerStore
  bundles its own `@multiformats/multiaddr` copy. `seed-bootstrap.ts:736` passes top-level
  `multiaddr()` values into `peerStore.merge` and compiles today, so the same should hold —
  if it does not, re-parse rather than reaching for `any`.
- **Cold start.** A node with no `CadrePeer` rows takes the `dialColdStartBootstrap` branch
  and never reaches the merge loop. Unchanged, and correct: nothing is verified yet.

## Tests

`packages/cadre-core/test/peer-addr-book.spec.ts` (new) — against a real
`persistentPeerStore` over `MemoryDatastore` (deps already resolvable at the repo root:
`@libp2p/peer-store`, `datastore-core`, `@libp2p/logger`, `main-event`), with `Date.now`
stubbed to advance time:

- fresh peer → `'merged'`, address readable via `peerStore.get`.
- advance past 1 h with periodic merges → helper reports `'restamped'` and the address is
  **still readable**; a plain `merge` in the same scenario reads back empty (lock the
  upstream behaviour the workaround exists for, so a future libp2p bump shows up as a
  failing test rather than as dead addresses in production).
- restamp preserves `protocols`, `tags`, `metadata`, `peerRecordEnvelope`.
- empty `addrs` → `'skipped'`, no write (assert via a spy or an untouched store).
- peerStore that throws → `'failed'`, no exception escapes.

`packages/cadre-core/test/cadre-node-control-cohort.spec.ts` (extend its existing stub
harness):

- every sibling's verified addresses are merged, **including already-connected siblings and
  siblings past the `targetDegree` dial cap**.
- a sibling whose record fails resolution (`resolvePeerAddrs` → `[]`) is never merged, even
  when the cold-start `peerStore.get` fallback yields a dialable address for it.
- the pass performs one record resolution per sibling (not two) — assert the resolve-call
  count, which the harness already tracks via `resolvedFor`.
- a peerStore whose `merge` rejects still lets the pass dial its selected siblings.

## TODO

- Add `packages/cadre-core/src/peer-addr-book.ts` with `mergePeerAddrs` + `MergeAddrsResult`,
  the merge → verify → field-preserving `save` restamp, best-effort error handling, and the
  `NOTE:` tripwire about the upstream `observed`-timestamp bug.
- Export it from `packages/cadre-core/src/index.ts` only if the strand arm needs it
  cross-package; otherwise keep it internal.
- Refactor `runReconcileControlCohort` to resolve each sibling once into a map, merge every
  non-empty result into the control peerStore, and pass the resolved addresses down to
  `resolveControlDialAddrs` / `dialControlSibling`.
- Add the per-pass log line and the cost `NOTE:` tripwire on the resolve loop.
- Write `peer-addr-book.spec.ts`; extend `cadre-node-control-cohort.spec.ts` (add `merge`
  doubles to the fake control node there and in `control-db-node-helpers.ts` as needed).
- Update `docs/architecture.md` (Control Network) with one line: verified `CadrePeer`
  addresses are merged into the libp2p address book each reconcile pass, so dial-by-peer-id
  works between live connections.
- `yarn lint` + `yarn test` in `packages/cadre-core`, plus a typecheck of the package.
