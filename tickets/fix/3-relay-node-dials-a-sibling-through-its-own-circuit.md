description: A machine that relays for a phone keeps trying to reach that phone through itself, every reconcile pass. Each attempt fails harmlessly, but it fills the log (about 250 errors a run) right where real relay problems would show up. Reported as gotchoices/sereus#20.
files: packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/cadre-node.ts (dialControlSibling, dialBootstrapPeer), packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/peer-dial.spec.ts
repro: static
severity: noise
likelihood: common
----

# Relay-hosting node dials a sibling through its own circuit address

Filed 2026-09-28 by risavian (same run as #19/#21/#22). Verified still present in 1.7.0.

`dialPeerAddrs` in `peer-dial.ts` filters nothing, and `AddrDialer` carries no peer id. A node that is the relay for a sibling holds that sibling's `<self>/p2p-circuit/<sibling>` address and dials it; libp2p refuses with `Can not dial self`. Callers: `dialControlSibling` and `dialBootstrapPeer` in `cadre-node.ts`, and two sites in `seed-bootstrap.ts`. The direct self-target case is already filtered in `cadre-node.ts`.

## Fix

- Give `dialPeerAddrs` (or `AddrDialer`) the local peer id, and drop addresses whose relay hop is this node, as db-p2p's `routesThroughRelay` does. Compare peer ids parsed with `peerIdFromString`, not raw strings.
- When every address routes through this node, fail with a distinct error the callers log at debug level, not as a dial failure.
- Tests in `peer-dial.spec.ts`: a self-relayed address is skipped and the next one tried; all-self-relayed yields the distinct error with no dial attempted.

Reply on #20 after release (maintainer approves the post).
