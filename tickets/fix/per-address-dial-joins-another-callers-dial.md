description: When a node tries a peer's addresses one at a time, another part of the node dialing the same peer at the same moment can capture that attempt, so the next address is never actually tried and a phone claiming or reaching a node can fail even though the node's working address was in its list.
architecture: docs/architecture.md#cohort-auto-connect
files: packages/cadre-core/src/peer-dial.ts (dialPeerAddrs, tryAddrsInTurn, nextMacrotask), packages/cadre-core/src/seed-bootstrap.ts (seedStreamOpener → mergeSeedPeers before connectForDelivery ~1125–1162; applySeed owner dials ~1004), packages/cadre-core/src/cadre-node.ts (dialControlSibling ~3788, dialBootstrapPeer ~4054), packages/cadre-core/src/strand-peer-redial.ts (dialAny ~273), packages/cadre-core/src/strand-wake-protocol.ts (~354, tryAddrsInTurn with dialProtocol), packages/cadre-core/test/peer-dial.spec.ts, packages/cadre-core/test/cadre-node-dial-past-dead-addresses.spec.ts, ../optimystic/packages/db-p2p/node_modules/libp2p/dist/src/connection-manager/dial-queue.js (3.3.11, join at ~100–122), ../Fret/packages/fret/dist/src/service/fret-service.js (probeMembership ~2748)
difficulty: hard
repro: verified
----
# A per-address dial joins another caller's dial job for the same peer

## Failing test

`packages/cadre-core/test/cadre-node-dial-past-dead-addresses.spec.ts` → "CadreNode — claiming a node whose first addresses never answer" → "reaches the node past two silent addresses and the claim is accepted". Intermittent under `yarn workspace @serfab/cadre-core test` (failed 1 of 2 full-suite runs on 2026-10-11; passed 3 of 3 full-suite runs and every isolated run during triage):

```
PeerUnreachableError: Could not reach 12D3KooW…: Seed delivery dial of 12D3KooW… failed for all 3 candidate addresses:
  /ip4/127.0.0.1/tcp/53176/ws/p2p/12D3KooW… — … timed out after 500ms;
  /ip4/127.0.0.1/tcp/53177/ws/p2p/12D3KooW… — … timed out after 500ms;
  /ip4/127.0.0.1/tcp/53180/ws/p2p/12D3KooW… — … timed out after 500ms
```

The third address is the claimable node's own listener. In isolation, the live dial plus the claim exchange finishes 110–190 ms after the two silent limits; under full-suite load it measured 168–345 ms. So a 500 ms limit on the live address is tight, but the timeout above is not that: the third attempt never dialed its own address.

## Deterministic reproduction

Set the spec's `PER_ADDRESS_MS` to `2_000` and `PER_PEER_MS` to `4 * PER_ADDRESS_MS`, then run `npx vitest run test/cadre-node-dial-past-dead-addresses.spec.ts` in `packages/cadre-core`. Both claim tests fail every time with `expected [ true, false ] to deeply equal [ true, true ]`: the second silent server never receives a connection. The drone test, which goes through `reconcileControlCohort` to a plain libp2p node, still passes.

With `DEBUG='sereus:cadre:peer-dial,libp2p:connection-manager:dial-queue*'` on the "rejects with PeerUnreachableError" case:

```
+0     dial-queue creating dial target for <peer>        ← our attempt 1, silent address 1
+1.1s  dial-queue joining existing dial target for <peer> ← FRET's ping
+2.0s  peer-dial … via <silent 1> failed: … timed out     ← our attempt 1 aborted
+2.0s  dial-queue joining existing dial target for <peer> ← our attempt 2 (silent 2) joins the job still on silent 1
+4.0s  peer-dial … via <silent 2> failed: … timed out     ← silent 2 never contacted
```

A temporary probe that wrapped the owner's `connectionManager.openConnection` and logged a stack trace showed who joined at +1.1 s: `FretService.probeMembership` → `sendPing` → `rpcRequest` → `openRpcStream` → `libp2p.dialProtocol(peerId)`. FRET learns the peer because `SeedBootstrapService.seedStreamOpener` calls `mergeSeedPeers` with the target's addresses before `connectForDelivery` dials.

## Root cause

libp2p 3.3.11's `DialQueue.dial` joins any queued job whose `peerId` equals the new dial's peer id (`dial-queue.js` ~100–122), whatever address the new dial names. The new address is only added to the job's address set, which `dialPeer` reaches after the address it is currently on finishes, and that address is subject to libp2p's own `addressDialTimeout`. A joined job aborts only once every caller that joined it has aborted.

`tryAddrsInTurn` assumes that once an attempt is aborted and one macrotask has passed, the next one-address `dial()` creates a fresh job (see its doc comment and `docs/architecture.md` → "The wait between attempts"). That holds only while no other caller has joined. When any other dial to the same peer id joins (FRET's membership probe here; any Optimystic, reconcile, or strand dial could do the same), the job outlives our abort. Each later attempt then joins it and times out on the address that job is still dialing. With a short per-address limit, the join can land on the working address's attempt, which is the reported failure. With a longer limit, it lands on the second silent address every time.

Every `dialPeerAddrs` caller is exposed: the control-cohort sibling and cold-start dials, the seed-bootstrap owner dial and seed delivery (`claimNode`), strand redial, and `dialWake` through `tryAddrsInTurn`. In production this is the phone-claims-host case the per-address dial exists for. The LAN addresses come first in the list, and once FRET probes the peer, the forwarded address that works may never be dialed.

## Expected behaviour

Each attempt in `tryAddrsInTurn` / `dialPeerAddrs` reaches the network at the address it names, for its own limit, whether or not other callers are dialing the same peer at the same time. The two claim tests, the drone test and `peer-dial.spec.ts` pass at any per-address limit, including 2000 ms.

## Design constraints

- `../optimystic` and `../Fret` (and the libp2p copy they carry) are read-only here (`tickets/rules/sibling-repos.md`). The fix lives in cadre-core. If it needs an upstream change after all, file a report ticket to `blocked/` instead.
- The peer's identity must still be checked. One candidate: dial a direct address without its trailing `/p2p/<id>`, so libp2p keys the job by address rather than peer id, then close the connection and fail the attempt when `connection.remotePeer` is not the expected peer. Note that libp2p skips `findExistingConnection` for an address-only dial. `dialControlSibling` and `dialBootstrapPeer` do not check for an open connection themselves (they rely on `reconcileControlCohort` skipping connected peers), so the helper should return an open unlimited connection before dialing, as `connectForDelivery` already does.
- A circuit address cannot drop its target id (`/p2p-circuit/p2p/<target>` needs it), so relayed attempts can still be joined. Either solve that too, for example by detecting the join through `onProgress`'s `dial-queue:already-in-dial-queue`, or leave an accepted-tradeoff `NOTE:` at the site saying why relayed attempts are exempt.
- Whatever replaces the "one macrotask between attempts" rule, keep its reason stated where the code is, and keep `nextMacrotask`'s other caller (`cadre-invite-protocol.ts`) correct.
- `dialWake` passes its own attempt to `tryAddrsInTurn` (`dialProtocol(addr)`), so a fix inside `dialPeerAddrs` alone leaves it exposed. Decide whether the address-keyed dial belongs in `tryAddrsInTurn`'s callers or in a shared helper.

## Cross-cutting obligations

- `test/peer-dial.spec.ts` pins libp2p's join behaviour against real nodes. Add a case with a concurrent peer-id dial (e.g. a second `dialer.dial(peerId)` or `dialProtocol(peerId)` started while attempt 1 is in flight) that fails today and passes after the fix. Update the header comment's claim that the next dial "does not join the aborted dial".
- `docs/architecture.md` → "Cohort auto-connect" → "The wait between attempts" states the same assumption. Rewrite it to describe the new rule.
- After the fix, re-measure the dead-address spec under full-suite load and decide whether `PER_ADDRESS_MS = 500` leaves the live address enough room (it measured up to 345 ms of live dial plus claim). Raise it only with that measurement.
- No determinism edition, byte format, golden fixture or migration is involved.
