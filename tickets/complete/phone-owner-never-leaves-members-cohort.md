description: The any-member invitation scenario now runs with a phone-shaped owner (no listen address), the household shape the feature is for, and the architecture doc states when a member stops waiting on an owner that went offline.
prereq: fret-evicts-an-address-less-peer-that-disconnects
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, docs/architecture.md, docs/testing.md, packages/integration-tests/src/scenarios/strand-relay-only-restart-reconverges.integration.ts, tickets/blocked/stranger-joins-the-control-cohort-by-advertising-protocols.md
----

# Phone-shaped owner in the any-member invitation scenario

## What landed

- `cadre-invite-any-member.integration.ts`: owner A is built with `listenAddrs: []`. Its control storage and bootstrap peer store carry across the restart, and the restarted A reconnects by dialing M. Because A listens nowhere, the invitation names only M's addresses, and the test asserts every address ends in `/p2p/<M>`. The header explains the eviction timings: a leave notice evicts A in about 1 s; without one, the dead verdict comes in about 5 s.
- `docs/architecture.md` (any-member enrollment section): new paragraph "The member writes without the absent owner only once the owner has left its cohort". It says a stopped owner leaves the cohort on its leave notice, or after three probe ticks in which it cannot be contacted, whether or not it has a listen address. A member write made inside that window fails retryably.
- Depends on FRET 1.0.2 (`address-less-peer-never-marked-dead`), linked through optimystic.

## Review findings

Read `ticket(implement): phone-owner-never-leaves-members-cohort` before the handoff.

- **Correctness of the scenario change**: checked. `resolveInviteAddresses` falls back to libp2p's own multiaddrs, which are empty with no listen address. So "every address is M's" plus "at least one address" is the right assertion. The rest of the test is unchanged and still passes.
- **The doc says the write "fails retryably"** (left open by the implementer): checked. The redemption handler maps a transient write failure to `conflict` and anything else to `internal`. Both are in `CADRE_INVITE_REJECTION_RETRYABLE`, and the existing note in `cadre-invite-protocol.ts` already covers that pairing. The claim is accurate.
- **FRET claims**: checked in the linked `dist`. The libp2p facade runs its shutdown in `beforeStop`. `handleLeave` → `markDeparted` sets the leaver's state to `dead` and does not remove the entry. `exportTable` exports every entry, dead ones included.
- **Stale docs the change should have touched (fixed inline)**. FRET 1.0.2 changed two facts that other docs still relied on: a leave notice now arrives, and the receiver marks the leaver dead instead of removing it.
  - `docs/architecture.md` → "One side remembering is enough" (strand network state) said a receiver drops the leaver from its table, and that the notice never took effect in any measured run. It now says the receiver marks the leaver dead and keeps its entry and record, so after a graceful stop both saved tables normally still name each other. The one-sided state happens only when a record ages out or an entry is evicted.
  - The same reasoning was fixed in the header of `strand-relay-only-restart-reconverges.integration.ts` (the one-sided arm) and in its `docs/testing.md` entry.
  - `cadre-invite-any-member.integration.ts` header: "removes A at once" is now "marks A dead at once".
  - `tickets/blocked/stranger-joins-the-control-cohort-by-advertising-protocols.md` said a disconnected address-less peer stays a live FRET member forever. It now says the peer is marked dead after about 5 s, which is how long a stranger stays in the cohort after it leaves.
- **Coverage gap: a phone that vanishes without a leave notice is not exercised in sereus**. The implementer flagged it, and I confirmed it. A graceful stop always sends the notice first. The case is pinned in FRET's own suite (`address-less-departure.spec.ts`). Covering it here would need a way to kill a CadreNode without running libp2p's `beforeStop`. No such hook exists, and I did not judge it worth adding for a behaviour that FRET already owns and tests. No ticket filed.
- **FRET leave handler logs `StreamStateError` on M** (seen in the implementer's debug run): this is FRET-side noise from replying on a stream the leaver already closed. The leave itself is processed. It belongs to the FRET repo, so nothing was done in sereus.
- **Tests**: no tests added or cut. The changed scenario is the reproduction of this ticket's behaviour. The edits to the strand scenario are comment-only.
- **Tripwires**: none found.
- **Validation**: `yarn lint` passes. The integration-tests `typecheck` passes. `vitest run cadre-invite-any-member strand-relay-only-restart-reconverges` passed: 3 passed, 2 opt-in arms skipped.
