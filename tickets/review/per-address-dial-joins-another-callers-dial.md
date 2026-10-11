description: When a node tries a peer's addresses one at a time, another part of the node dialing the same peer at the same moment could capture that attempt, so the next address was never actually tried and a phone claiming or reaching a node could fail even though the node's working address was in its list. The fix stage took each address around libp2p's dial queue; this pass finished it: every address is now bound to the peer expected, an already-open connection is reused, the wake and invitation dialers use the same queue-free dial, and the shutdown tests observe a dial the queue can no longer show.
architecture: docs/architecture.md#cohort-auto-connect
files: packages/cadre-core/src/peer-dial.ts (dialAddr, dialPeerAddrs, boundTo, reusableConnection, boundPeer, trailingPeerId, withTrailingPeerId, AddrDialer, ReusableConnection), packages/cadre-core/src/peer-record.ts (re-exports the two address helpers), packages/cadre-core/src/strand-wake-protocol.ts (sendWake), packages/cadre-core/src/cadre-invite-protocol.ts (exchangeRedemption), packages/cadre-core/src/seed-bootstrap.ts (dialSeedOwners, connectForDelivery), packages/cadre-core/src/cadre-node.ts (dialControlSibling, dialBootstrapPeer, resolveControlDialAddrs and normalizeDialAddrs comments), packages/cadre-core/src/strand-peer-redial.ts (dialAny), packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-dial.spec.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts (mintSilentPeer, the stop-mid-dial case), packages/cadre-core/test/cadre-node-dial-past-dead-addresses.spec.ts (PER_ADDRESS_MS comment), packages/cadre-core/test/cadre-node-control-cohort.spec.ts (real sibling ids), packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/cadre-invite-protocol.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, docs/architecture.md (Cohort auto-connect)
difficulty: hard
repro: verified
----
# Finish the queue-free per-address dial — review handoff

## What was wrong, in one paragraph

libp2p's dial queue joins any new dial of a peer to a job already queued for that peer id, whatever address the new dial names, and a joined job ends only when every caller has aborted. So while anything else dialed the same peer (FRET's membership probe, an Optimystic cluster client, a strand redial), each per-address attempt of `dialPeerAddrs` waited on whichever address the other job was on, never its own, and the working address was skipped. The fix stage made `dialAddr` dial one address through libp2p's transport manager instead, which never joins anything. This pass closed the gaps that left open.

## What this pass changed

**Identity binding.** `dialPeerAddrs` now takes the expected peer id as its second argument. Every address is bound to it with `withTrailingPeerId` before dialing, so the Noise handshake verifies who answered; an address naming another peer is dropped and logged, and when nothing binds (every address names someone else, or the id does not parse) it throws without dialing. All five callers pass the id they already held. `applySeed`'s owner dial, the one caller whose addresses carried no id, is now bound like the rest, and the seed-bootstrap spec pins the bound form it dials.

**Where the two address helpers live.** `trailingPeerId` and `withTrailingPeerId` moved from `peer-record.ts` into `peer-dial.ts` so the dial module stays importable from anywhere without a cycle (`peer-record.ts` pulls in the crypto plugin). `peer-record.ts` re-exports both, so every existing import path, including the package's public export, still works.

**Open-connection reuse.** `dialAddr` hands back an open connection to the address's peer without relay limits instead of dialing, the rule libp2p's queue applied through `findExistingConnection` (direct preferred; a relayed connection is not reused for a direct address, so the dial can upgrade the link). The shape chosen: an optional `getConnections?(peerId?)` on `AddrDialer`, typed by what is read of each connection (`ReusableConnection`: `remotePeer`, optional `status`, `limits`, `direct`). That keeps `RedialNode`'s narrower slice (bare `remotePeer`s, which never count as open) assignable without a cast, keeps every existing double valid (one without the method never reuses), and puts the check at the one site every caller shares, so an attempt made after a concurrent dial has finished reuses that connection rather than opening a duplicate. The reason is written on the interface member. `connectForDelivery`'s own `openUnlimitedConnection` check was removed as a duplicate.

**The wake and invitation dialers.** `sendWake` and `exchangeRedemption` now call `dialAddr` and then `connection.newStream(protocolId, { runOnLimitedConnection: true, signal })` instead of `dialProtocol(addr, …)`. Each keeps its own address order (signalling first for a wake; the invitation's member order) and the macrotask wait between attempts. Their specs' doubles changed from a `dialProtocol` stub to a `dial` that returns a connection with `newStream`; the cases themselves are unchanged.

**Stop semantics.** `dialAddr` now rethrows the abort reason when its own controller aborted the transport dial, because a transport reports an aborted connect as its own failure (`Could not connect to …`). A deadline still surfaces `withDeadline`'s timeout error as before; a stop now surfaces `<label>: the node stopped`.

**Docs and comments.** `dialAddr`'s doc lists the queue bookkeeping now skipped (last-dial stamps in the peer store, the parallel-dial and queue-length caps, the pre-network self-dial refusal) and why each is not missed. A `NOTE:` tripwire sits at the transport-manager dial: the relay leg of a relayed address still goes through the queue and can be joined by another dial of the relay. `docs/architecture.md` → "Cohort auto-connect" describes binding, reuse, and the two other dialers; two comments in `cadre-node.ts` that still credited the dial queue with filtering were corrected. The only other `docs/` mention of the dial queue (`reference-app-rn.md`, the `AbortSignal.timeout` polyfill table) describes libp2p itself and is still right.

## Tests

Added, in `test/peer-dial.spec.ts`:

- "binds a bare address and drops one naming another peer": `dialPeerAddrs` dials the bare address with `/p2p/<peer>` appended and never dials the one naming another peer.
- "rejects without dialing when no address binds to the peer": the explicit error, with nothing dialed.
- "hands back the open connection without dialing": with a connection already open to the target and a silent address first in the list, the open connection comes back and the silent server is never contacted. This is the queue's `findExistingConnection` behaviour, pinned on the transport-manager path.
- "rejects the attempt promptly, naming the stop": an attempt in flight to a silent server (its accept observed) rejects with `the node stopped` within a second of `libp2p.stop()`. The `stop` event path had no test.

Restated:

- `control-database-offline-peers.spec.ts` → "stop() resolves inside its budget with a dial in flight to an address that never answers" (was the blackhole case): the sibling now lives at a loopback silent server, the case waits for the server's accept, asserts the pass has not settled, then stops. The old wait on the dial queue could never see a queue-free dial and tested `stop()` after the pass. The WebRTC case keeps its relay-hop wait, which is the one thing still in the queue; `dialQueuePeerIds`'s doc says so.
- `cadre-node-control-cohort.spec.ts`: the siblings its fakes dial have real Ed25519 peer ids (module-level `await`), because binding needs an id that encapsulates; one expectation now reads the bound address. `cadre-node.spec.ts`'s two wake doubles and `seed-bootstrap.spec.ts`'s owner-dial expectation changed the same way.
- `cadre-node-dial-past-dead-addresses.spec.ts` prints each case's elapsed time (`dial-past-dead:` lines, visible with the verbose reporter) and `PER_ADDRESS_MS`'s comment carries the measurement below.

## Validation

- `tsc -p tsconfig.typecheck.json` and `eslint packages/cadre-core docs`: clean.
- `yarn workspace @serfab/cadre-core test` with the verbose reporter, three times: run 1 was 161 of 162 files green (the `cadre-node.spec.ts` wake double, fixed after), runs 2 and 3 were 162 of 162. Logs: `tickets/.logs/per-address-dial-joins-another-callers-dial.suite{1,2,3}.log`.
- Integration, one file at a time after `yarn workspace @serfab/cadre-core build`: `control-cohort-edge-carries-data` (1 of 1), `control-cohort-three-node-isolation` (2 of 2), `blind-relay-phone-to-phone-e2e` (3 of 3, including the relayed arms). `@serfab/cadre-host`'s dist was stale from an earlier edit, not this ticket's, and was rebuilt to get past the guard.

**Timing.** The dead-address spec, whole pass past two silent addresses at 500 ms each: isolated 1120 ms (reconcile) and 1154 ms (claim); under full-suite load across the three runs 1204–1357 ms (reconcile) and 1274–1513 ms (claim). So the live dial plus the pass's remaining work used at most 357 ms of the 500 ms limit under load (the claim figure also includes the seed exchange after the dial). `PER_ADDRESS_MS` stays at 500; the comment says to raise it only on a measurement showing the live attempt itself timing out.

## For the reviewer: known gaps and judgement calls

- Three dials still go through the queue and can be joined: `SeedBootstrapService.deliverSeed` given a bare address string (its `dialProtocol(addr, …)` form; one address, so nothing is skipped, but it waits on the other job's address), `strand-addr-protocol.ts`'s `dialProtocol(target)` by peer id, and `strand-formation-protocol.ts`'s `dialProtocol(addrs, …)` over a list. The ticket scoped the two per-address dialers only; decide whether the single-address seed form wants a tripwire or a ticket.
- `reusableConnection` casts the structural `ReusableConnection` to `Connection` for the return. On a real node it is one; a double that reports `status: 'open'` must supply `newStream`. No current double does, which is why none needed changing.
- A limited (relayed) open connection is never reused, as with the queue, so a wake to a peer with only a limited connection open dials a second relayed connection. Unchanged behaviour, noted for completeness.
- `boundPeer` throws when an address's trailing id does not parse, where the fix stage's `assertDialAllowed` threw the raw parse error. The upgrader rejects such an address after connecting anyway; the error now names the address.
- The `stop` case in `peer-dial.spec.ts` allows one second for the rejection after `stop()`, the spec's shared `SLACK_MS`; on this machine it took a few milliseconds.
