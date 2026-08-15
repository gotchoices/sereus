----
description: A node now keeps its teammates' addresses for a shared workspace fresh — refreshing them every ten minutes instead of only once when it joins — so dials to a teammate that dropped off keep working.
files: packages/cadre-core/src/peer-addr-book.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts (new), packages/cadre-core/test/peer-addr-book.spec.ts, docs/strands.md
----

Strand-network arm of `plan/feat-merge-cadre-peer-addrs-into-libp2p-peerstore`. The control arm
(`complete/merge-verified-peer-addrs-into-control-peerstore`) shipped `mergePeerAddrs`, which this
reuses unchanged.

## What shipped

**`peer-addr-book.ts` — new export `groupAddrsByPeerId(addrs: string[]): Map<string, Multiaddr[]>`.**
Attribution step in front of `mergePeerAddrs`. Parses each string with the top-level `multiaddr()`,
walks `getComponents()` backwards and takes the **last** `CODE_P2P` value as the addressed peer.
That is the load-bearing detail: a relayed address `…/p2p/<relay>/p2p-circuit/p2p/<strand>` names
the relay first and the destination last, so taking the first would file every sibling's addresses
under the relay. Unparsable strings and addresses with no `/p2p/` component are logged and dropped
(they cannot be attributed, so they cannot enter any book); duplicates collapse; insertion order is
preserved both between and inside groups. Pure — no libp2p node needed.

**`cadre-node.ts`:**

- `STRAND_PEER_ADDR_REFRESH_MS = 10 * 60 * 1000`, exported, with the rationale in its doc comment
  (inside the peerStore's 1 h expiry with headroom, far above the 15 s reconcile cadence).
  Overridable per node via `network.controlCohort.strandAddrRefreshMs` (new optional field in
  `types.ts`, one line + doc) — the ticket allowed either, and it was a one-liner.
- `connectedSiblingTargets()` — the `queryCadrePeers` → `deriveCohortMembers` → filter-by-connected
  chain, lifted out of `resolveCohortSeed` and now shared with the refresh pass. The long
  unbounded-read NOTE moved with it.
- `mergeStrandPeerAddrs(strandNode, addrs, strandId)` — group, skip self, `mergePeerAddrs` each
  group into **that strand node's** peerStore, log a one-line count per pass including the number of
  dropped/unattributable addresses. Carries the "a member could poison this book" reasoning as a
  comment at the merge site, per the ticket (bounded: addresses grant no authority, the dialed peer
  authenticates by peer id, a bad entry costs one failed dial that ages out in an hour).
- Launch (`launchStrand`) and resume (`resumeStrandRuntime`) now merge the resolved cohort seed
  directly into the started/resumed strand node, in addition to passing it as `bootstrapNodes`.
- `refreshStrandPeerAddrs(now = Date.now())` + `refreshOneStrandPeerAddrs`, wired into
  `runReconcileControlCohort` immediately after `refreshDelegateGrants()` with the same
  `_running`/`controlNode` re-guard on both sides. Per pass: build the running set from
  `strandManager.getInstances()` keeping only instances with a live `libp2pNode`; prune throttle
  entries for strands no longer running; compute due strands; if none, return without any control-DB
  read; otherwise resolve the sibling target list **once** for all due strands and RPC each strand
  concurrently (`Promise.all`), stamping the throttle on the RPC having happened, then re-reading the
  instance after the await before merging.

**`docs/strands.md`** — new paragraph after the "Within-party answer (implemented)" block: seed goes
into the address book, siblings re-resolve on a ~10-minute cadence, why it matters (everything below
cadre-core dials strand peers by bare peer id), and that it stays single-party.

## Use cases to exercise when reviewing

- **A sibling restarts its strand node.** Its strand transport peerId is stable (derived), its
  addresses are not. Before: this node's strand book kept the dead addresses until it restarted or
  resumed the strand. After: within 10 minutes the new addresses are merged under the same peerId.
- **A strand running longer than an hour.** Every seed address falls off the peerStore's
  `MAX_ADDRESS_AGE`, so before this the book was empty for any sibling not currently connected. The
  refresh both re-supplies addresses and, via `mergePeerAddrs`' restamp, defeats the upstream
  frozen-timestamp bug.
- **A hibernating strand that wakes.** Instance tracked, `libp2pNode` undefined → skipped and its
  throttle entry pruned, so the resume refreshes on the very next tick rather than inheriting a stale
  stamp.
- **A solo node / a node whose siblings are all offline.** No connected sibling ⇒ nothing RPC'd and
  **nothing stamped**, so the next 15 s tick retries instead of sitting out 10 minutes.
- **Relayed vs direct addresses.** The single most likely place to introduce a silent bug: verify a
  `…/p2p/<relay>/p2p-circuit/p2p/<strand>` address is filed under `<strand>`.

## Tests

`yarn lint` (repo root) clean. `yarn typecheck` in `packages/cadre-core` clean. Full `yarn test` in
`packages/cadre-core`: **1545 passed, 1 skipped, 2 failed** — both failures pre-existing (below).

New/extended:

- `test/peer-addr-book.spec.ts` (+5) — `groupAddrsByPeerId`: relayed groups under the destination not
  the relay; direct groups under its trailing id; several peers split with duplicates collapsed; a
  bare listen addr, a malformed `/ip4/999.999.999.999/…`, and a free-form string are all dropped
  without throwing; empty input.
- `test/cadre-node-strand-addr-refresh.spec.ts` (new, 12) — control node / DB / strand manager stubbed
  in the style of `cadre-node-strand-seed.spec.ts`, with a loopback `StrandAddrService` per sibling
  and a recording strand-node peerStore double. Covers: both siblings RPC'd and merged under their
  **strand** peer ids (asserted *not* their control ids); throttle holds at `T`, at
  `T + REFRESH_MS - 1`, releases at `T + REFRESH_MS`; no-connected-sibling leaves the throttle
  unstamped and the next pass retries; hibernating strand skipped + pruned + immediate refresh on
  resume; strand deleted mid-RPC produces no peerStore write; a strand whose node throws and one
  whose peerStore rejects both leave the pass resolving and the third strand refreshed;
  unattributable address dropped; self-address never written; stopped node does nothing;
  `strandAddrRefreshMs` override honoured. Plus launch and resume both merging the resolved seed.

### Known gaps — treat the above as a floor

- **No live-network proof, same as the control arm.** Nothing in `packages/integration-tests` asserts
  that an Optimystic cluster/repo dial by bare peer id succeeds on the strand network *because* the
  book stayed warm. That is the actual user-visible claim. Not attempted here: the integration suite
  is red for unrelated tracked causes and exceeds the agent wall-clock budget.
- **The strand-node double is a double.** Unlike `peer-addr-book.spec.ts`, which runs against a real
  `@libp2p/peer-store`, the refresh spec's `peerStore.merge` echoes its input back. So the refresh
  tests prove *which* addresses reach *which* peer's book, not that the write survives expiry — that
  half is pinned separately by the 200-simulated-minute test in `peer-addr-book.spec.ts`. A reviewer
  wanting belt-and-braces could wire one refresh test to a real peer store.
- **`refreshStrandPeerAddrs` is never exercised through `runReconcileControlCohort`** — the tests call
  it directly. The wiring (placement after `refreshDelegateGrants`, the surrounding re-guards) is
  read-not-run.
- **Concurrency between the refresh RPC and a `resolveCohortSeed` announce is untested.** Both can be
  in flight for the same strand (a resume racing a reconcile tick); both are read-only against the
  control node and idempotent at the peerStore, so I believe it is benign, but it is reasoning, not a
  test.
- **The unattributable-address count is logged once per pass, as specified, but it also counts
  duplicates collapsed by `groupAddrsByPeerId`.** `collectStrandAddrs` already dedupes its union, so
  in practice the two cannot both be nonzero — worth a glance if that ever changes.
- **`launchStrand`'s merge happens before `hibernationManager.trackStrand`.** Deliberate (the address
  book should be warm before anything can hibernate the strand out from under it) but it does put an
  `await` on the launch path that was not there before. Bounded by the number of sibling groups; no
  network I/O — the RPC already completed in `resolveCohortSeed`.

### Tripwire parked

`cadre-node.ts`, on `refreshStrandPeerAddrs` — `NOTE:` about RPC fan-out: one strand-addr RPC per
(due strand × connected sibling) per refresh interval. Fine now; if a node ever runs many strands at
once, batch the RPC to carry several strand ids per request instead of one fan-out per strand. Also
extended the existing per-pass CadrePeer-read NOTE in `runReconcileControlCohort` from "two reads per
pass" to note the third read this pass adds on the passes where a strand is actually due.

### Pre-existing failures — not this ticket's

`test/control-start-storage-op-budget.spec.ts` (1983 ops vs a 1700 budget) and
`test/strand-solo-write-budget.spec.ts` (1979 vs 1780). Both already listed in
`tickets/.pre-existing-known.md` under
`optimystic-schema-catalog-reread-per-write-blows-storage-budgets` (blocked), so not re-reported and
`tickets/.pre-existing-error.md` was not written. Identical numbers to the control arm's run, i.e.
unmoved by this work.
