description: A node now seeds a strand's peer-to-peer mesh by asking its own sibling nodes for their live strand-network addresses on demand, instead of mistakenly handing the strand the wrong (control-network) addresses, so a party's own nodes actually join the strand together.
prereq:
files: packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/test/strand-cohort.spec.ts, packages/cadre-core/test/cadre-node-strand-seed.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/architecture.md, docs/strands.md
----

## Summary

Wired the strand-address RPC primitive from `strand-addr-control-protocol` into
the node's seed-derivation path, and **stopped conflating control addresses with
strand seeding**. Before this change, `deriveCohortSeed` built a strand's
`bootstrapNodes` from `CadrePeer.Multiaddr` — each sibling's *control*-network
address — and fed them to the *strand* libp2p node (a separate instance on a
different port). Dialing those reached the control instance, never the strand
mesh, so a party's own co-cadre nodes never actually joined each other's strands.

Now a strand's bootstrap addresses are resolved **on demand** over the control
mesh: `CadreNode.resolveCohortSeed(strandId)` reads `CadrePeer` membership for
mode selection, then RPCs the connected siblings via `/sereus/strand-addr/1.0.0`
(`collectStrandAddrs`) and seeds from the deduplicated, signaling-first union of
their live strand-`strandId` multiaddrs. Single-party only (this party's own
nodes); cross-party strand discovery remains future work.

## What changed

- **`strand-cohort.ts`** — replaced `deriveCohortSeed` (which read `Multiaddr`)
  with **`deriveCohortMembers(peers, selfPeerId?)`** returning
  `{ otherPeerIds, hasOtherPeers }`. It is membership-only: self-excluded,
  peerId-deduplicated, and **never touches the `Multiaddr` field**. `CohortSeed`
  is unchanged (still `{ bootstrapNodes, hasOtherPeers }`), but `bootstrapNodes`
  is now populated from the RPC. `selectStrandMode` / `CohortPeerRow` unchanged.
- **`cadre-node.ts`**
  - New field `strandAddrService` + `StrandAddrService` create/`initialize` in
    `start()` (alongside the wake service) and `shutdown()` in `cleanup()` (so a
    restart doesn't hit `DuplicateProtocolHandlerError`).
  - New private `getStrandMultiaddrs(strandId)`: the strand instance's live
    `libp2pNode.getMultiaddrs()` ordered signaling-first, or `[]` when no live
    node. Injected as the responder's address source.
  - `resolveCohortSeed(strandId)` rewritten: membership via
    `deriveCohortMembers`, then RPC **only the siblings already holding an open
    control connection** (filtered against `controlNode.getConnections()`) via
    `collectStrandAddrs(controlNode, targets.map(peerId => ({ peerId })), strandId)`.
    Empty seed when control DB/node absent, no connected sibling, or nobody runs
    the strand yet. Both callers updated to thread the strand id: `launchStrand`
    → `resolveCohortSeed(strand.Id)`, `resumeStrandRuntime(strandId)` →
    `resolveCohortSeed(strandId)`.
- **Docs** — `docs/architecture.md` gained a **Strand-Address Resolution**
  subsection and the strand-mode seed paragraph + protocol list were rewritten;
  the `docs/strands.md` open-question block now records the within-party answer
  and scopes cross-party discovery as future.

## Use cases for testing / validation

These are the behaviors a reviewer should confirm — and the cases worth probing
harder, since the unit tests below are a **floor**, not a ceiling:

1. **Two co-cadre nodes, asymmetric bootstrap.** Node A launches a strand first
   (solo → `bootstrap` mode, empty seed) and *answers* the strand-addr RPC for
   it. Node B, connected to A on control, launches/resumes the same strand: its
   `resolveCohortSeed` RPCs A, gets A's live **strand** addr, and seeds with it.
   Verify B dials into A's strand mesh — the core fix. (Unit-covered via loopback
   in `cadre-node.spec.ts` wake test + `cadre-node-strand-seed.spec.ts`; **no
   real-network/integration test exists yet** — see gaps.)
2. **Control addr never leaks into the strand seed.** A sibling's
   `CadrePeer.Multiaddr` (control addr) must not appear in `bootstrapNodes`. The
   seed comes only from the RPC answer (a *strand* addr).
   (`cadre-node-strand-seed.spec.ts`, `strand-cohort.spec.ts`.)
3. **Mode follows membership, independent of addr availability.** A node with
   other members but no reachable/running strand peer starts `networked` with an
   empty seed and waits — consistent with the documented "membership presence,
   not dialability" semantics. Self-heals on the next resume/check-in.
4. **Connected-only fan-out.** A member with no open control connection is **not**
   RPC'd (still counts for membership/mode). A member connected but not running
   the strand answers `[]` and is skipped.
5. **Self-exclusion** in both `deriveCohortMembers` and the RPC fan-out.
6. **Teardown.** `stop()` → `strandAddrService.shutdown()` unhandles the protocol.
7. **Best-effort.** A sibling whose dial throws/times out is skipped; the rest
   still seed. Control DB/node absent → empty seed, no throw.

## Test coverage (the floor)

- **`strand-cohort.spec.ts`** — rewritten for `deriveCohortMembers`:
  self-exclusion, `hasOtherPeers`, `otherPeerIds`, peerId dedup, and an explicit
  "ignores `Multiaddr` entirely" case. Old `bootstrapNodes`-from-`Multiaddr`
  assertions dropped.
- **`cadre-node-strand-seed.spec.ts`** (new) — `resolveCohortSeed`: empty with no
  DB/node, empty when alone, signaling-first union from connected running
  siblings (asserting control addrs do **not** leak), mode-from-membership with
  empty seed, no-RPC of an unconnected member, never-RPC-self, and dial-failure
  tolerance. Uses the same loopback `StrandAddrService` harness as the protocol
  spec (real Ed25519 peerIds so `peerIdFromString` round-trips).
- **`cadre-node.spec.ts`** — the hibernation/serviceWake fakes now provide
  `getConnections()`; the "freshly re-resolved cohort seed" wake test was
  upgraded to a real loopback so it asserts the seed is the sibling's **strand**
  addr (not its control addr). All other lifecycle tests assert
  resume/window/re-hibernate machinery, not seed contents.

**Validation run:** `yarn workspace @serfab/cadre-core build` clean;
full suite **46 files, 618 passed, 1 skipped** (the skip is pre-existing,
unrelated); `eslint` on changed files exit 0; `typecheck` exit 0.

## Known gaps / deferred (honest floor, not a finish line)

- **No real-network / integration coverage of the asymmetric bootstrap.** The
  end-to-end "two own-party nodes converge on a strand via the RPC seed" path is
  proven only by unit loopbacks. A live integration test (parallel to the wake
  e2e) belongs here and does not exist yet — highest-value thing for review to
  scrutinize or file.
- **`runOnLimitedConnection` / relay reachability is unverified end-to-end.** The
  RPC sets it (inherited from the protocol), but the returned strand multiaddr
  must itself be dialable on the strand network. Deep per-strand NAT relay
  reachability is tracked separately (`strand-network-nat-relay-reachability`).
- **Self-heal is resume/check-in only.** When no connected sibling runs the
  strand at launch, the seed is empty and re-resolves on the next resume/check-in
  — the ticket's optional "re-resolve on the control-connection-growth edge that
  drives `drainPendingControlReplication`" was **deferred** (note it as a future
  optimization, not a correctness gap).
- **No push-wake-then-seed.** A sibling connected on control but hibernating the
  strand answers `[]`; the caller does not first push-wake it to bring the strand
  up. Deliberately left OUT of v1 (noted in the ticket as future).
- **Integration-test comment updated, not executed.** The stale rationale in
  `push-wake-e2e.integration.ts` (which referenced the removed `deriveCohortSeed`
  and the now-closed `control-network-cohort-discovery` gap) was rewritten for
  accuracy; that cross-package real-network suite was **not** run in this ticket
  (out-of-band/CI). Reviewer should confirm the comment matches intent.

## Review findings

_(none yet — this is the implement→review handoff; the reviewer fills this in.)_
