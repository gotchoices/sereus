description: A draft reply to the reporter on gotchoices/sereus#13, answering their CPU-cost reproduction and their offer of two PRs. Posting it is a human's call.
files:
  - tickets/backlog/bug-slow-peer-crypto-cost-diverges-into-retry-amplification.md (the ticket this reply points to)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (the round-trip numbers quoted)
----

# Human action: reply on #13 to the CPU-cost follow-up

Posting to a public tracker is the maintainer's call. Before posting, decide the second point (the crypto option). The draft says yes in principle; change that if the answer differs. It also assumes the `^1.2.0` floor patch (`8c94537d`) has been released. If it hasn't, change "sereus 1.2.1" to "sereus 1.2.0, with optimystic 1.2.0 installed".

## Draft

> Thanks, this is a much more useful reproduction than the one we had, and the diverging rather than degrading result is the part we most want to fix.
>
> **Round trips.** Sereus 1.2.1 requires optimystic 1.2.0, which cuts a commit's consensus rounds. In the two-party relay topology, an insert now opens 4 cluster-protocol streams instead of 9. With 150 ms added each way on one party's link, an insert takes about 5 s, down from 9–10 s. The loopback frame count dropped from about 12k to about 9k. If you re-run your CPU-cost sweep on these versions, we'd like to know where the failure point moves. We expect it to move, but not to go away.
>
> **The divergence.** We agree it's the real bug, and that raising timeouts isn't the fix. We've opened a ticket to find which layer re-issues work once its deadline passes. Suspects are the fixed-budget maintenance RPCs in the ring layer, the storage layer's cluster retries, and our own first-sync and formation retries. We'd gladly take the CPU-cost fixture as a PR, next to `packages/integration-tests/src/harness/ws-latency.ts`, in the same shape: opt-in by environment variable, off by default.
>
> **Supplying native crypto.** Yes, and we'd welcome your PR. The design we agreed with optimystic:
>
> - In `@optimystic/db-p2p`, add an optional `noiseCrypto?: ICryptoInterface` on `NodeOptions`, used as `noise(options.noiseCrypto ? { crypto: options.noiseCrypto } : undefined)` in `libp2p-node-base.ts`. We don't expose `connectionEncrypters` in general. Noise stays mandatory; the option only swaps local primitives, so the wire protocol and interop with nodes that don't set it are unchanged.
> - Re-export `ICryptoInterface` (as a type, named `NoiseCryptoInterface`) and `pureJsCrypto` (as a value) from db-p2p's entry points, including the React Native one. Then apps don't need their own direct dependency on noise, and can spread `pureJsCrypto` and override the hot functions with native ones.
> - Doc comment: the implementation must be complete (hashing, ChaCha20-Poly1305, X25519 keygen and DH), and nothing changes when the option is unset.
> - Tests: a two-node spec where one node's crypto wraps `pureJsCrypto` with call counters. It should assert the nodes connect, the counters are hit during the handshake, and the node without the option still interoperates. Also a check that the option is optional in the types.
> - Docs: a line in db-p2p's React Native checklist saying RN gets pure-JS Noise through noise's `browser` field, and how to plug in native crypto.
>
> That PR goes to the optimystic repo. Once it's released, we'll pass the option through cadre-core's node options on our side.
>
> **`strandFirstSync.timeoutMs`.** Thanks for noting that. It is node config, as you found.
