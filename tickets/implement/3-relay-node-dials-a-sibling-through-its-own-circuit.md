description: A machine that relays for a phone keeps trying to reach that phone through itself on every reconcile pass. Each attempt fails harmlessly, but it fills the log (about 250 errors a run) right where real relay problems would show up. Skip those addresses before dialing and say plainly why. Reported as gotchoices/sereus#20.
architecture: docs/architecture.md#control-network
files: packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/cadre-node.ts (dialControlSibling ~3293, dialBootstrapPeer ~3552), packages/cadre-core/src/seed-bootstrap.ts (applySeed owner loop ~826, dialInvite ~1388), packages/cadre-core/src/index.ts (peer-dial exports ~508), packages/cadre-core/test/peer-dial.spec.ts
repro: static
----

# Relay-hosting node dials a sibling through its own circuit address

Filed 2026-09-28 by risavian (same run as #19/#21/#22). Verified still present in 1.7.0 by reading the code; not reproduced in a running network here.

## What happens

When a phone (or any node that cannot listen) holds a relay reservation on one of its cadre siblings, the address it publishes is `/<relay transport>/p2p/<relay id>/p2p-circuit/p2p/<phone id>`. The relay node learns that address like any other sibling address (control-database record, address book, identify). Once the phone's connection drops, the relay's reconcile pass (`CadreNode.dialControlSibling`, every 15 s by default) hands it to `dialPeerAddrs`, which dials it. libp2p refuses: `Can not dial self`. Nothing on the relay's side can repair this — only the phone can re-initiate — so every pass logs one failed dial per such sibling.

`dialPeerAddrs` (`peer-dial.ts`) filters nothing, and its `AddrDialer` interface carries only `dial()`, so it has no way to know which relay hop is "this node". The four callers — `dialControlSibling` and `dialBootstrapPeer` in `cadre-node.ts`, `applySeed`'s owner loop and `dialInvite` in `seed-bootstrap.ts` — all pass a real libp2p node, which has `peerId`. The case where the TARGET is this node is already skipped by the callers (e.g. `applySeed` skips `peer.peerId === selfPeerId`); the case where the RELAY HOP is this node is not.

Optimystic's db-p2p solved the same problem as `routesThroughRelay` / `classifySelfDialability` in `../optimystic/packages/db-p2p/src/peer-address-book.ts` (read it for reference — sibling repo, read-only). They are not exported from db-p2p's public index, so cadre-core needs its own copy of the check; keep it small and in `peer-dial.ts`.

## Fix (single site: `dialPeerAddrs`)

- Add `peerId` to `AddrDialer`: `readonly peerId: PeerId` (type from `@libp2p/interface`). A libp2p node already satisfies it; no caller signature changes.
- Before `directBeforeRelayed`, drop every address that relays through this node. An address relays through us when some `p2p-circuit` component is immediately preceded by a `p2p` component naming our peer id (walk `getComponents()`, as db-p2p does; any hop in a multi-hop chain counts). Compare canonical strings: `peerIdFromString(component.value).toString() === dialer.peerId.toString()`, with the parse in a try/catch that treats an unparseable value as "not ours". Do NOT call `PeerId.equals` — several test doubles (`cadre-node-control-cohort.spec.ts:56`) supply `peerId` as `{ toString }` only. Only parse the component that sits in front of a circuit marker, so plain addresses cost nothing.
- Log each dropped address once at the `peer-dial` logger (`'%s: skipping %s — it relays through this node'`).
- If the input was non-empty and every address was dropped, throw a new exported error class `SelfRelayOnlyError` (message along the lines of `<label>: every candidate address relays through this node; only the peer can reconnect`) without calling `dial` at all. An empty input keeps today's `no candidate addresses` error from `tryAddrsInTurn`.
- Export `SelfRelayOnlyError` from `index.ts` next to `dialPeerAddrs`.

## Callers

- `dialControlSibling` and `dialBootstrapPeer` (`cadre-node.ts`): in the catch, when `error instanceof SelfRelayOnlyError`, log a distinct message (e.g. `reconcileControlCohort: sibling %s is reachable only through this node's relay; waiting for it to reconnect`) instead of the `dial ... failed (continuing): %o` line with its stack. Still return `false`. All logging here is the `debug` library, so "debug level" means: a one-line message, not the error object.
- `applySeed` owner loop (`seed-bootstrap.ts`): same distinct log line. Keep counting it in `ownerDialsFailed` — this node really is not connected to that owner, and `ownerDialsFailed` is how the caller learns it is seeded but unconnected. Say so in a one-line comment.
- `dialInvite`: no change; the error propagates to the user with its clearer message.
- `resolveControlDialAddrs` returning only self-relayed addresses is fine — the filter in `dialPeerAddrs` covers it; do not duplicate the check there.

## Tests (`peer-dial.spec.ts`)

Unit level, with a fake `AddrDialer` (`{ peerId, dial }`) that records the addresses it was asked to dial — no libp2p nodes needed. Use real peer ids (`peerIdFromPrivateKey(await generateKeyPair('Ed25519'))`, or fixed valid `12D3KooW…` strings parsed with `peerIdFromString`) because the check parses them.

- A list of `[self-relayed circuit address, other address]`: the self-relayed one is never passed to `dial`, the other is, and its connection is returned. Put the self-relayed address first so the test would fail if it were dialed.
- A list of only self-relayed addresses: rejects with `SelfRelayOnlyError`, and `dial` was never called.

One test each; don't add separate tests for the CIDv1 form or multi-hop chains unless the implementation grows a branch for them.

## TODO

- Add `peerId` to `AddrDialer`, the self-relay filter, and `SelfRelayOnlyError` in `peer-dial.ts`; update the `dialPeerAddrs` doc comment (it currently says nothing is filtered beforehand — that remains true for transports only).
- Export `SelfRelayOnlyError` from `packages/cadre-core/src/index.ts`.
- Distinct log lines in `dialControlSibling`, `dialBootstrapPeer`, and `applySeed`'s owner loop.
- The two tests above in `peer-dial.spec.ts`.
- Check test doubles passed to `dialPeerAddrs` indirectly (`seed-bootstrap.spec.ts` `createMockLibp2p` ~500 has no `peerId`): the filter only reads `dialer.peerId` when an address has a circuit hop, so doubles with direct addresses keep working; add a `peerId` only where a test actually reaches the check.
- `yarn workspace @serfab/cadre-core build`, `yarn workspace @serfab/cadre-core test`, `yarn lint`.
- After release: reply on gotchoices/sereus#20 (maintainer approves the post).
