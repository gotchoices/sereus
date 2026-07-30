description: Add a real-network test proving that two nodes of the same party actually join the same strand together when the second node asks the first for its address — the core scenario the recent seeding fix enables but only checks with stubs.
prereq:
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/integration-tests/src/scenarios
----

## Why this exists

`strand-seed-from-strand-addr-rpc` (commit `aafaea9`) rewired strand seeding so a
node resolves a strand's bootstrap addresses on demand over the control mesh
(`/sereus/strand-addr/1.0.0`) instead of mis-using each sibling's *control*
multiaddr. The fix is proven only by **unit loopbacks**: every test stubs
`controlNode.dialProtocol` and feeds a hand-built `StrandAddrService` over an
in-memory `duplexPair`. No test stands up two real `CadreNode`s with real strand
libp2p instances and verifies the asymmetric-bootstrap convergence end to end.

That convergence is the entire point of the change, and it exercises seams the
unit tests cannot:

- **Mode/address interaction.** Node A comes up first → solo → `bootstrap` mode,
  empty seed, live strand node. Node A must *answer* the RPC for that strand even
  though it is in `bootstrap` mode (`getStrandMultiaddrs` checks for a live node,
  not the mode). A later Node B, connected to A on control, resolves a non-empty
  seed (A's live **strand** addr), starts `networked`, and must actually dial into
  A's strand mesh. Whether a `networked` node successfully meshes with a
  `bootstrap`-mode node over a real strand libp2p network is unverified.
- **`getStrandMultiaddrs` returns raw `node.getMultiaddrs()`.** Unlike control
  self-records (which go through `collectSelfAddrs` → invite/relay resolution),
  the responder hands back the strand node's raw listen addrs. On a single host
  these are dialable; the per-strand NAT/relay case is deliberately deferred to
  `strand-network-nat-relay-reachability`. This test should cover the
  same-host/direct-dial happy path and leave NAT to that ticket.

## What to build

A scenario parallel to `push-wake-e2e.integration.ts` (same harness helpers):

- Two `CadreNode`s in **one party**, connected on the control network, both able
  to answer each other's `CadrePeer` membership (`isMember`).
- A launches a strand first (solo `bootstrap`). Assert A's strand node is live and
  that A answers a `collectStrandAddrs` / `/sereus/strand-addr/1.0.0` request with
  a non-empty **strand** multiaddr.
- B launches/resumes the same strand. Assert B's resolved seed is A's strand addr
  (NOT A's control addr), B comes up `networked`, and B's strand node forms a
  connection to A's strand node (e.g. B's strand `getPeers()`/connection list
  includes A, or a strand-level read/write replicates across the two).
- A negative assertion that A's `CadrePeer.Multiaddr` (control addr) never appears
  in B's strand peer set — the regression the fix exists to prevent.

## Notes

- Cross-package, real-network: runs out-of-band / in CI, **not** inside an agent
  ticket (>10 min wall-clock risk, real libp2p transports). Spec it so a human or
  CI runs it.
- Reuse `integration-tests` harness helpers; see the consolidation tracked in
  `integration-test-harness-helper-consolidation`.
- NAT/relay reachability and cross-party discovery are explicitly **out of scope**
  here — they live in `strand-network-nat-relay-reachability`.
