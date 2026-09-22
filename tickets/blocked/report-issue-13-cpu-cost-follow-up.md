description: A draft reply to the reporter on gotchoices/sereus#13, answering their CPU-cost reproduction and their offer of two PRs. Posting it is a human's call.
files:
  - tickets/backlog/bug-slow-peer-crypto-cost-diverges-into-retry-amplification.md (the ticket this reply points to)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (the round-trip numbers quoted)
----

# Human action: reply on #13 to the CPU-cost follow-up

Posting to a public tracker is the maintainer's call. Optimystic implemented the crypto option itself (4739b170, 23929726), so the draft tells the reporter their PR isn't needed. It also assumes the `^1.2.0` floor patch (`8c94537d`) has been released. If it hasn't, change "sereus 1.2.1" to "sereus 1.2.0, with optimystic 1.2.0 installed".

## Draft

> Thanks, this is a much more useful reproduction than the one we had, and the diverging rather than degrading result is the part we most want to fix.
>
> **Round trips.** Sereus 1.2.1 requires optimystic 1.2.0, which cuts a commit's consensus rounds. In the two-party relay topology, an insert now opens 4 cluster-protocol streams instead of 9. With 150 ms added each way on one party's link, an insert takes about 5 s, down from 9–10 s. The loopback frame count dropped from about 12k to about 9k. If you re-run your CPU-cost sweep on these versions, we'd like to know where the failure point moves. We expect it to move, but not to go away.
>
> **The divergence.** We agree it's the real bug, and that raising timeouts isn't the fix. We've opened a ticket to find which layer re-issues work once its deadline passes. Suspects are the fixed-budget maintenance RPCs in the ring layer, the storage layer's cluster retries, and our own first-sync and formation retries. We'd gladly take the CPU-cost fixture as a PR, next to `packages/integration-tests/src/harness/ws-latency.ts`, in the same shape: opt-in by environment variable, off by default.
>
> **Supplying native crypto.** Done upstream, so you don't need to write that PR (thank you for offering). Optimystic main, after 1.2.0 and not yet published, adds `NodeOptions.noiseCrypto?: NoiseCryptoInterface` to `@optimystic/db-p2p`. When it is set, it goes to `noise({ crypto })`; when it isn't, nothing changes. Noise stays mandatory, so the wire protocol and interop are unchanged. The type `NoiseCryptoInterface` and the value `noisePureJsCrypto` are exported from both `@optimystic/db-p2p` and its `/rn` entry. The intended pattern is to spread `noisePureJsCrypto` and override hashing and ChaCha20-Poly1305 with native functions. We'll pass it through cadre-core's node options once it's released.
>
> **`strandFirstSync.timeoutMs`.** Thanks for noting that. It is node config, as you found.
