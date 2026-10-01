description: Should someone with no account be able to read an open workspace, for example a public view of an election? Today the only way to find a workspace's machines is members-only, and strangers are turned away before they can ask. The maintainer needs to decide whether to allow this at all yet, and which approach to take. Requested as gotchoices/sereus#23.
files: packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/membership-connection-gater.ts (STRANGER_OPEN_PROTOCOLS)
----

# Decide: public read-only access to open strands

## Blocked on

A maintainer decision. Unblock by recording the choice below and moving this to `plan/`.

## The request (risavian, #23, for VoteTorrent's public view)

A browser without an account wants to read an open strand. The only route to a strand's addresses is strand-addr, which refuses non-members (`strand-addr-protocol.ts`), and the membership gater drops strangers before that anyway.

## Facts found at triage (1.7.0)

- `STRANGER_OPEN_PROTOCOLS` in `membership-connection-gater.ts` is declared, exported and pinned by a test, but the gater never reads it. That is dead code whatever is decided here, and the reporter's question 1 is right about it.
- In 1.7.0 the peer-book swap answered any connected peer on an open strand, since open strands have no gate, so an observer holding one strand address could learn the rest through it. The swap has since been removed (`remove-strand-peer-book`); members' signed address records now travel between strand nodes in the ring library's (FRET's) neighbour snapshots. Whether those answer any connected peer on an open strand was not re-checked when the swap was removed, and needs checking before this fact is relied on.
- An "observer" on an open strand is not read-only: nothing stops it writing. `backlog/feat-open-strand-witness-policy` is where open strands' write protection is meant to be settled.

## Decisions

1. Allow non-member reads of open strands before the witness policy is settled?
2. If yes, which route:
   - **(a) The reporter's:** a `/sereus/public-observer` protocol with a node-local allowlist of strand ids, plus a per-stream stranger exception (`STRANGER_OPEN_PROTOCOLS` actually enforced) and a rate limit. Effort L.
   - **(b) No control-network change:** publish an open strand's address in the link or a signed record and let the swap supply the rest. Works today if the serving node has a stable public address. Effort S–M.
   - **(c)** FRET's signed address hints (`../Fret/tickets/plan/10-feat-address-hints-in-neighbor-exchange`) as the long-term form of (b).

Recommendation at triage: (b) now, documented, with (c) replacing it when FRET ships; revisit (a) with the witness policy. Either way, remove or wire `STRANGER_OPEN_PROTOCOLS`.

## Related

`backlog/feat-open-strand-witness-policy`, `backlog/feat-scenario-public-open-strand-network`, `remove-strand-peer-book`.

## Status (2026-09-28)

Not decided yet. Triage facts and the lighter route were posted on #23 (issuecomment-5878780666) without committing to a route.
