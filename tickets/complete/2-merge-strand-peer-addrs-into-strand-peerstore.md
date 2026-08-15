----
description: A node now keeps its teammates' addresses for a shared workspace fresh — refreshing them every ten minutes instead of only once when it joins — so dials to a teammate that dropped off keep working.
files: packages/cadre-core/src/peer-addr-book.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/cadre-core/test/peer-addr-book.spec.ts, docs/strands.md, docs/architecture.md
----

Strand-network arm of `feat-merge-cadre-peer-addrs-into-libp2p-peerstore`. The control arm
(`complete/merge-verified-peer-addrs-into-control-peerstore`) shipped `mergePeerAddrs`, which this
reuses unchanged.

## What shipped

**`peer-addr-book.ts` — new export `groupAddrsByPeerId(addrs: string[]): Map<string, Multiaddr[]>`.**
The attribution step in front of `mergePeerAddrs`. Parses each string with the top-level
`multiaddr()` and takes the **last** `/p2p/` value as the addressed peer — load-bearing, because a
relayed address `…/p2p/<relay>/p2p-circuit/p2p/<strand>` names the relay first and the destination
last, so taking the first would file every sibling's addresses under the relay. Addresses that name
no destination are dropped rather than mis-attributed: unparsable, no `/p2p/` at all, and (added in
review) a relay hop with nothing behind it. Duplicates collapse; insertion order is preserved. Pure —
no libp2p node needed.

**`cadre-node.ts`:**

- `STRAND_PEER_ADDR_REFRESH_MS = 10 * 60 * 1000`, exported, sitting inside the peerStore's one-hour
  address expiry with headroom and far above the 15 s reconcile cadence. Overridable per node via
  `network.controlCohort.strandAddrRefreshMs` (new optional field in `types.ts`).
- `connectedSiblingTargets()` — the `queryCadrePeers` → `deriveCohortMembers` → filter-by-connected
  chain, lifted out of `resolveCohortSeed` and shared with the refresh pass.
- `mergeStrandPeerAddrs(strandNode, addrs, strandId)` — group, skip self, `mergePeerAddrs` each group
  into **that strand node's** peerStore, log one count line per pass. Carries the accepted-exposure
  reasoning (a member could answer with poisoned addresses; bounded because addresses grant no
  authority, the dialed peer authenticates by peer id, and a bad entry costs one failed dial that
  ages out in an hour) as a `NOTE:` at the merge site.
- Launch (`launchStrand`) and resume (`resumeStrandRuntime`) merge the resolved cohort seed directly
  into the started/resumed strand node, in addition to passing it as `bootstrapNodes` — which only
  reaches the address book through `@libp2p/bootstrap` discovery.
- `refreshStrandPeerAddrs(now = Date.now())` + `refreshOneStrandPeerAddrs`, wired into
  `runReconcileControlCohort` right after `refreshDelegateGrants()`. Per pass: build the running set
  from `strandManager.getInstances()` keeping only instances with a live `libp2pNode`; prune throttle
  entries for strands no longer running; compute due strands; resolve the sibling target list once
  for all of them; RPC each strand concurrently, stamping the throttle on the RPC having happened,
  re-reading the instance after the await before merging.

**Docs** — `strands.md` gained a paragraph on the seed-into-address-book step and the ~10-minute
re-resolution; `architecture.md` gained the same (see review findings — it was missed during
implement).

## Review findings

Reviewed the implement diff (`19fca2c`) fresh before reading the handoff, then read every file it
touched plus the ones it should have touched. `yarn lint` (root) clean, `yarn typecheck`
(`packages/cadre-core`) clean, full `yarn test` in `packages/cadre-core`: **1548 passed, 1 skipped,
2 failed** — both failures pre-existing and already tracked (see the last section).

### Fixed in this pass

- **`groupAddrsByPeerId` mis-attributed a destination-less relay hop to the relay.**
  `peer-addr-book.ts` took "the last `/p2p/` component" unconditionally, so
  `…/p2p/<relay>/p2p-circuit` — a circuit hop with the destination missing — was filed under the
  **relay's** peer id, claiming the relay is reachable at a circuit that leads through itself to
  nowhere. Not reachable from a well-behaved sibling (libp2p's `getMultiaddrs()` always appends
  `/p2p/<self>`), but it is exactly the shape a buggy or hostile member can send, and it made the
  "last `/p2p/` is the destination" rule partial. Extracted `lastAddressedPeerId`, which walks the
  components backwards and returns null on meeting a `p2p-circuit` first. Covered by a new case in
  `peer-addr-book.spec.ts`.

- **The refresh paid an unbounded control-DB read on every 15 s reconcile tick whenever the node was
  alone.** By design, a pass that finds no connected sibling asks nobody and leaves its throttle
  **unstamped**, so the next tick retries — correct behaviour, but it meant `connectedSiblingTargets`'
  unbounded `queryCadrePeers()` ran once a tick, forever, for the steady state of a solo node running
  a strand. Guarded in `refreshStrandPeerAddrs` on `getConnections().length === 0`: with no
  connection the answer is empty by construction, so the read buys nothing.
  **Deliberately guarded in the caller, not inside `connectedSiblingTargets`** — the obvious-looking
  place. `control-database-solo-warm-start.spec.ts` exists specifically to prove that read does not
  stall as an embedder's *first* awaited control operation on a warm cohort no one can reach, and
  short-circuiting it there would have made every case in that suite vacuous on the `addStrand` path
  while still passing. Recorded the reason at both sites. Covered by a new test asserting zero
  `queryCadrePeers` calls across two disconnected passes.

- **The reconcile pass's read-count `NOTE:` was wrong.** It claimed the third read happens "on the
  passes where a strand is actually due (at most one per strand per 10 min)" — neither clause held:
  the read is once per *pass*, not per strand, and it recurred every tick in the case above.
  Corrected to what the code now does.

- **`refreshStrandPeerAddrs` was never exercised through `runReconcileControlCohort`** — the
  implementer flagged the wiring (placement after `refreshDelegateGrants`, the surrounding
  `_running`/`controlNode` re-guards) as read-not-run. Added a test that drives the public
  `reconcileControlCohort()` end-to-end and asserts the sibling was RPC'd, the merge landed on the
  strand node, and the throttle was stamped.

- **`docs/architecture.md` was stale.** The implement pass updated `strands.md` and left the entry-point
  doc untouched, so its Strand-Address Resolution section still described a one-shot resolution.
  Three corrections: a new bullet covering attribution → merge → the periodic refresh (with the
  no-sibling and hibernation behaviours); the "Asymmetric bootstrap" bullet, which said the empty-seed
  case self-heals only on the resume/check-in path, when it now also self-heals with no resume at all;
  and the "Delegate announce" bullet, whose stated refresh cadence was the relay throttle alone, when
  the address refresh now carries the same `delegatePeerId` to siblings on its own schedule. The
  `bootstrapNodes` paragraph above the section got the same treatment.

### Found, recorded as evidence against an existing ticket

- **`cadre-node.ts` is 5,073 lines** (`wc -l`), up from the 4,770 recorded on 2026-08-13 — this
  feature added four methods, a constant and a map to the class. The site is already claimed by
  `backlog/debt-cadre-node-single-file-size`, so per the "Nth instance is evidence" rule this was
  appended there as an arm (with the measurement, the command, and which of that ticket's existing
  groupings the new methods belong to) rather than filed fresh.

### Checked and deliberately left alone

- **The accepted-exposure `NOTE:` at the merge site** (a member can answer with poisoned addresses).
  Its stated bound still holds — an address grants no authority, the peer authenticates by peer id at
  the handshake, a bad entry costs one failed dial that ages out in an hour — so it was not re-opened.
  The relay-hop fix above is inside that bound and was taken only because it was three lines and made
  the attribution rule total, not because the exposure changed.
- **`mergeStrandPeerAddrs` does not re-check `_running` between per-peer merges**, where the control
  arm's `warmSiblingAddrBook` does. The asymmetry is real but costs at most a few logged `'failed'`
  writes into a torn-down store (`mergePeerAddrs` folds its own throws), and the helper is shared with
  the launch path where the check is meaningless. Not worth the branch.
- **The `dropped=` log count folds duplicates collapsed by `groupAddrsByPeerId`**, as the implementer
  noted. Confirmed it cannot bite today: every caller's input comes from `collectStrandAddrs`, which
  dedupes its union, so the two terms cannot both be nonzero.
- **The refresh re-announces `delegatePeerId` to siblings every ~10 min**, a side effect of reusing
  the strand-addr RPC. Traced through `delegate-admission.ts`: grants are replace-per-(announcer,
  strand) with per-member and global caps, so this keeps existing grants alive rather than
  accumulating anything. Documented in `architecture.md` instead of changed.

### No new tickets, no new tripwires

Nothing found in this pass was major enough to file — the two real defects were both small enough to
fix here, and the one class-level concern (file size) already has a ticket. No new tripwires either:
the implementer parked two (RPC fan-out per due strand × sibling at `refreshStrandPeerAddrs`, and the
extended per-pass `CadrePeer`-read note in `runReconcileControlCohort`), and both are at the right
sites and still accurate — the second was corrected rather than duplicated.

### Gaps that remain open

Carried forward from the implement handoff, re-confirmed rather than closed:

- **No live-network proof.** Nothing in `packages/integration-tests` asserts that an Optimystic
  cluster/repo dial by bare peer id succeeds on the strand network *because* the book stayed warm —
  the actual user-visible claim. Same gap as the control arm. Not attempted: that suite is red for
  unrelated tracked causes and exceeds the agent wall-clock budget.
- **The strand-node double is a double.** The refresh spec's `peerStore.merge` echoes its input back,
  so those tests prove which addresses reach which peer's book, not that the write survives expiry —
  that half is pinned separately by the 200-simulated-minute test in `peer-addr-book.spec.ts` against
  a real `@libp2p/peer-store`.
- **Concurrency between a refresh RPC and a `resolveCohortSeed` announce is untested.** Both can be in
  flight for the same strand (a resume racing a reconcile tick). Read-only against the control node and
  idempotent at the peerStore, so it should be benign — but that is still reasoning, not a test.

### Pre-existing failures — not this ticket's

`test/control-start-storage-op-budget.spec.ts` (1983 ops vs a 1700 budget) and
`test/strand-solo-write-budget.spec.ts` (1979 vs 1780). Both already listed in
`tickets/.pre-existing-known.md` under `optimystic-schema-catalog-reread-per-write-blows-storage-budgets`
(blocked), so not re-reported and `tickets/.pre-existing-error.md` was not written. Numbers identical
to the implement run and to the control arm's run — unmoved by this work or by this review.
