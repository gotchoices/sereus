description: A machine that relays for a phone kept trying to reach that phone through itself on every reconcile pass, logging about 250 errors a run. It now skips those addresses before dialing and logs one plain line saying the phone has to reconnect. Reported as gotchoices/sereus#20.
architecture: docs/architecture.md#control-network
files: packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/cadre-node.ts (dialControlSibling ~3293, dialBootstrapPeer ~3560), packages/cadre-core/src/seed-bootstrap.ts (applySeed owner loop ~826), packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-dial.spec.ts, docs/architecture.md (control-cohort bullet ~224)
repro: static
----

# Relay-hosting node no longer dials a sibling through its own circuit

## Problem

A phone (or any node that cannot listen) that holds a relay reservation on a cadre sibling publishes `/<relay transport>/p2p/<relay id>/p2p-circuit/p2p/<phone id>`. The relay learns that address like any other sibling address. Once the phone's connection drops, the relay's reconcile pass (every 15 s) dialed it and libp2p refused with `Can not dial self`. One failed dial, with its stack trace, was logged per such sibling per pass, and only the phone can fix it by reconnecting.

## What changed

The fix is at one site, `dialPeerAddrs` in `peer-dial.ts`, which all four owner, sibling, bootstrap and invite dials go through:

- `AddrDialer` now carries `readonly peerId: PeerId`. A libp2p node already satisfies it, so no caller signature changed.
- Before ordering, `withoutSelfRelayed` drops every address where a `p2p-circuit` component is immediately preceded by a `p2p` component naming this node (`relaysThrough` → `namesPeer`), at any hop of a multi-hop chain. The comparison is canonical strings (`peerIdFromString(value).toString() === peerId.toString()`), so a CIDv1-form id matches too. An unparseable value is logged and treated as "not this node". `PeerId.equals` is deliberately not used, because test doubles supply `peerId` as `{ toString }` only. Only the component in front of a circuit marker is parsed.
- Each dropped address logs `'<label>: skipping <addr> — it relays through this node'`.
- If the input was non-empty and every address was dropped, it throws the new exported `SelfRelayOnlyError` without calling `dial`. An empty input still gives the old `no candidate addresses` error.
- `dialPeerAddrs` is now `async`, so that throw becomes a rejected promise rather than a synchronous throw.
- `SelfRelayOnlyError` is exported from `index.ts`.

Callers:

- `dialControlSibling` and `dialBootstrapPeer` (`cadre-node.ts`): on `SelfRelayOnlyError` they log one line (`… is reachable only by relaying through this node; waiting for it to reconnect`) instead of `dial … failed (continuing): %o`. Both still return `false`.
- `applySeed` owner loop (`seed-bootstrap.ts`): logs the same kind of line, and still counts the owner in `ownerDialsFailed`. A comment explains why: the node really is unconnected to that owner.
- `dialInvite`: unchanged. The clearer error reaches the user as is.
- `docs/architecture.md`, in the control-cohort bullet after the macrotask explanation: one sentence on the skip and `SelfRelayOnlyError`.

## Tests added (`test/peer-dial.spec.ts`, describe "addresses that relay through the dialer itself")

These use a fake `AddrDialer` that records what it dials, with real Ed25519 peer ids.

- **skips a self-relayed address and dials the others.** The input is `[circuit via self, circuit via another relay]`. It checks that only the second address is dialed and its connection is returned. Both addresses are relayed, so `directBeforeRelayed` keeps them in order and the self-relayed one would be dialed first without the filter.
- **rejects with SelfRelayOnlyError, dialing nothing, when every address relays through the dialer.**

Both were confirmed to fail with the filter temporarily bypassed, and to pass with it.

## Validation run

- `yarn workspace @serfab/cadre-core build`: clean.
- `yarn workspace @serfab/cadre-core typecheck` (includes tests): clean.
- `yarn workspace @serfab/cadre-core test`: 144 files, 2340 passed, 1 skipped.
- `yarn lint`: exit 0.

## Known gaps / for the reviewer

- **Not reproduced on a live network.** The fix is verified at unit level only, with no relay plus phone setup run.
- **Still some log lines per pass.** A self-relay-only sibling now produces the skip line and the caller's one-line message on every pass, with no error object or stack. The ticket accepted this. If it is still too noisy in practice, the next step would be to log only on a state change.
- **`dialWake` (`strand-wake-protocol.ts` ~306) is not covered.** It calls `tryAddrsInTurn` directly, not `dialPeerAddrs`, to keep its signalling-first order. A relay waking a strand peer that holds a reservation on it could still dial a self-relayed address. That is a one-off, event-driven dial rather than a 15 s loop, so it was left out of scope. The reviewer can decide whether it needs a ticket or a `NOTE:`.
- **Stale numbers in the doc.** The same `architecture.md` bullet still quotes the old fixed 8 s and 30 s dial limits, which are now derived from the link round trip (`link-budget.ts`). That text predates this ticket and was not changed.
- A test double that has no `peerId` and passes a circuit address would now hit `undefined.toString()` inside `namesPeer`. That call sits outside the try, so it fails loudly rather than being silently ignored. No existing test reaches it: the full suite passes and no double needed a `peerId` added.

## After release

- Reply on gotchoices/sereus#20. The maintainer approves the post.
