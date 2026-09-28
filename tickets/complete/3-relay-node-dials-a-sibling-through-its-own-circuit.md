description: A machine that relays for a phone kept trying to reach that phone through itself on every reconcile pass, logging about 250 errors a run. It now skips those addresses before dialing and logs one plain line saying the phone has to reconnect. Reported as gotchoices/sereus#20.
architecture: docs/architecture.md#control-network
files: packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/test/peer-dial.spec.ts, docs/architecture.md
repro: static
----

# Relay-hosting node no longer dials a sibling through its own circuit

## Problem

A phone (or any node that cannot listen) holding a relay reservation on a cadre sibling publishes `/<relay transport>/p2p/<relay id>/p2p-circuit/p2p/<phone id>`. Once the phone's connection dropped, the relay's 15 s reconcile pass dialed that address and libp2p refused (the circuit transport opens a connection to the relay, which is itself: `Can not dial self`), logging a failure with a stack trace per such sibling per pass.

## What landed

- `dialPeerAddrs` (`peer-dial.ts`), which the sibling, bootstrap, seed-owner and invite dials all use, drops every address where a `p2p-circuit` component is immediately preceded by a `p2p` component naming this node, at any hop. Peer ids are compared as canonical strings so base58 and CIDv1 forms match. Each dropped address is logged. If a non-empty list is emptied, it throws the new exported `SelfRelayOnlyError` without dialing.
- `AddrDialer` gained `readonly peerId: PeerId`; a libp2p node already satisfies it.
- `dialControlSibling`, `dialBootstrapPeer` (`cadre-node.ts`) and the `applySeed` owner loop (`seed-bootstrap.ts`) log a one-line "reachable only by relaying through this node; waiting for it to reconnect" for that error instead of the dial-failure dump. The owner loop still counts it in `ownerDialsFailed`, since the node really is unconnected. `dialInvite` passes the error through unchanged.
- Two unit tests in `test/peer-dial.spec.ts`: a self-relayed address is skipped while another relayed address is dialed; an all-self-relayed list rejects with `SelfRelayOnlyError` and dials nothing.
- `docs/architecture.md` control-cohort bullet describes the skip.

Implemented in `ticket(implement): relay-node-dials-a-sibling-through-its-own-circuit`.

## Review findings

Read the implement diff first, then the handoff.

- **Correctness of the filter:** checked against libp2p 3.1.3 source — `Can not dial self` comes from `connectionManager.openConnection` when the circuit transport opens the relay leg to itself, so the address is undialable from the relay in every case; dropping it changes no outcome except the log. Walking components (not text) correctly ignores the target id after the marker and a bare `/p2p-circuit`. An unparseable id is logged, not swallowed. No issue found.
- **Callers / error paths:** all four `dialPeerAddrs` callers checked. `dialPeerAddrs` becoming `async` changes nothing observable (the old body already returned a promise from an async helper). Empty input still yields the old `no candidate addresses` error. No issue found.
- **Test doubles:** many specs stub a node's `peerId` as `{ toString }`; the string comparison works with them, and the full suite passes. The case where a double lacks `peerId` and passes a circuit address fails loudly rather than silently — acceptable.
- **Tests:** the two new tests pin the specified behaviour on real branching (skip versus throw) with a recording fake dialer; kept both. No tests cut, none added.
- **`dialWake` (`strand-wake-protocol.ts`)** keeps its own signalling-first loop and does not filter self-relayed addresses. A relay waking its own reservation holder gets a fast `Can not dial self` and moves to the next candidate — same outcome, one line of noise, event-driven not per-pass. Conditional, so parked as a `NOTE:` tripwire on `dialWake`.
- **Peer-id-only dials below cadre-core** (FRET, Optimystic `dialProtocol(peerId)`) can still load the self-relayed address from libp2p's peer store and fail on it inside libp2p's own multi-address dial. libp2p's identify stores that address regardless of what `peer-addr-book.ts` merges, so filtering our merge would not remove it; those dials live in other projects. Considered and not filed.
- **Log volume:** a self-relay-only sibling still produces the skip line plus the caller's one line per pass, without stack traces. Accepted by the ticket; no change.
- **Docs:** the `architecture.md` control-cohort bullet still quoted fixed 8 s / 30 s dial limits that are now derived from `NetworkConfig.linkRoundTripMs` (`link-budget.ts`: four round trips per address, four addresses per sibling — 14 s / 56 s at the declared 3.5 s). Fixed inline. `types.ts` and `peer-dial.ts` doc comments were already current.
- **Hygiene / types / resource cleanup:** helpers are small and single-purpose; no `any`; nothing to clean up (no dial is started for dropped addresses). No issue found.
- **Validation:** `yarn workspace @serfab/cadre-core typecheck` clean; `yarn lint` exit 0; `yarn workspace @serfab/cadre-core test` 144 files, 2340 passed, 1 skipped.
- **Not done:** no live relay-plus-phone reproduction; verified at unit level only.

## After release

- Reply on gotchoices/sereus#20. The maintainer approves the post.
