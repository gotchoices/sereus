description: A node now seeds a strand's peer-to-peer mesh by asking its own sibling nodes for their live strand-network addresses on demand, instead of mistakenly handing the strand the wrong (control-network) addresses, so a party's own nodes actually join the strand together.
prereq:
files: packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/test/strand-cohort.spec.ts, packages/cadre-core/test/cadre-node-strand-seed.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/architecture.md, docs/strands.md
----

## Summary

Wired the strand-address RPC primitive (`/sereus/strand-addr/1.0.0`) into the
node's seed-derivation path and **stopped conflating control addresses with
strand seeding**. Previously `deriveCohortSeed` built a strand's `bootstrapNodes`
from each sibling's *control*-network `CadrePeer.Multiaddr` and fed them to the
*strand* libp2p node (a separate instance on a different port), so dialing reached
the control instance and a party's own co-cadre nodes never joined each other's
strands.

Now `CadreNode.resolveCohortSeed(strandId)` derives membership/mode from
`CadrePeer` rows (`deriveCohortMembers`, addr-blind), then RPCs the **connected**
siblings via `collectStrandAddrs` and seeds from the deduplicated, signaling-first
union of their live strand-`strandId` multiaddrs. A `StrandAddrService` responder
answers siblings with `getStrandMultiaddrs(strandId)`. Single-party only;
cross-party strand discovery remains future work.

## What changed

See the implement commit `aafaea9` for the full diff. Briefly:

- **`strand-cohort.ts`** — `deriveCohortSeed` → `deriveCohortMembers(peers,
  selfPeerId?)` returning `{ otherPeerIds, hasOtherPeers }`; membership-only,
  self-excluded, peerId-deduped, never reads `Multiaddr`.
- **`cadre-node.ts`** — new `strandAddrService` (create + `initialize` in `start()`
  alongside the wake service, `shutdown()` in `cleanup()`); new
  `getStrandMultiaddrs(strandId)` (live strand node addrs, signaling-first, or
  `[]`); `resolveCohortSeed(strandId)` rewritten to RPC connected siblings; both
  callers (`launchStrand`, `resumeStrandRuntime`) thread the strand id.
- **Docs** — `architecture.md` Strand-Address Resolution subsection + rewritten
  seed paragraph/protocol list; `strands.md` within-party answer recorded,
  cross-party scoped as future. `push-wake-e2e.integration.ts` rationale comment
  rewritten for the new seed path.

## Review findings

Reviewed the implement diff (`aafaea9`) with fresh eyes before the handoff, then
read every touched source/test/doc file plus the protocol primitive
(`strand-addr-protocol.ts`) and the call sites (`launchStrand`,
`resumeStrandRuntime`, `start`, `cleanup`).

### Verification run (all green)
- `yarn workspace @serfab/cadre-core build` — clean.
- Full `@serfab/cadre-core` suite — **46 files, 618 passed, 1 skipped** (the skip
  is pre-existing and unrelated to this change).
- `eslint` on the five changed source/test files — exit 0.

### Correctness / architecture — checked, no defects
- **Control addr never leaks into the strand seed.** Confirmed end to end:
  `deriveCohortMembers` surfaces only peerIds; the seed comes solely from the RPC
  answer. Asserted by `strand-cohort.spec.ts`, `cadre-node-strand-seed.spec.ts`,
  and the upgraded `cadre-node.spec.ts` wake test (control addr `…/other-control`
  is present in the `CadrePeer` row yet absent from the resulting seed).
- **Mode follows membership, not dialability.** `hasOtherPeers` is membership-only,
  so a cohort with no resolvable strand addr still comes up `networked` with an
  empty seed and self-heals on resume/check-in. Consistent with the documented
  semantics.
- **Connected-only fan-out + self-exclusion.** `resolveCohortSeed` filters
  `otherPeerIds` against `getConnections()`; `collectStrandAddrs` additionally
  drops `node.peerId`. Both exclusions covered.
- **Best-effort dials.** A throwing/timed-out sibling folds to `[]` and the rest
  still seed; absent control DB/node → empty seed, no throw. Covered.
- **Resource cleanup.** `strandAddrService.shutdown()` unregisters the protocol
  handler (guards against `DuplicateProtocolHandlerError` on restart), mirroring
  the wake service in both `start()` and `cleanup()`. Verified ordering.
- **No stale references.** No source/doc reference to the removed `deriveCohortSeed`
  remains (the only hit is a prebuilt `reference-app-ns` webpack `bundle.js`
  artifact, not source). Docs (`architecture.md`, `strands.md`, the integration
  comment) accurately reflect the new reality.

### Findings

**Minor — none requiring inline change.** The code is DRY, single-purpose,
type-safe (no `any` leakage in source; the test-only `as unknown as` casts are the
established private-method-probing idiom), and consistent with the wake/seed
protocol patterns it parallels. No inline fixes were needed.

**Major — filed, not fixed inline:**
- **Missing integration coverage of the asymmetric-bootstrap convergence** — the
  core scenario (two own-party nodes converge on a strand via the RPC seed, a
  `networked` node dialing into a `bootstrap`-mode node's live strand mesh) is
  proven only by in-memory loopbacks that stub `dialProtocol`. No real-network
  test stands up two `CadreNode`s with real strand libp2p instances. This needs
  real transports / multi-process and is **not agent-runnable inside the idle
  window**, so it is filed rather than written here:
  `tickets/backlog/strand-addr-seed-convergence-integration-test.md`.

### Gaps confirmed already tracked (no new ticket)
- **Per-strand NAT/relay reachability** of the returned strand multiaddr (the
  responder hands back raw `getStrandMultiaddrs` without invite/relay resolution,
  unlike control self-records) and **cross-party strand discovery** are both
  deliberately deferred and tracked by
  `tickets/backlog/strand-network-nat-relay-reachability.md`.
- **Self-heal is resume/check-in only** (the control-connection-growth re-resolve
  edge was deferred) and **no push-wake-then-seed** — both documented as future
  optimizations, not correctness gaps. Confirmed acceptable for v1.
