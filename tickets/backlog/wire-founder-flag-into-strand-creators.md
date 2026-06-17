description: The code that seats a private group's first owner only runs when the creating node is told it is the creator, but no real app screen tells it that yet — so creating a private group currently leaves it with no owner. Wire the "I am the creator" signal into the real create-a-group flows.
prereq: strand-membership-invite-join
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-ns/src/chat-strand.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts
difficulty: medium
----

## Problem

`strand-membership-founder-bootstrap` landed the founder bootstrap that writes a strand's
`Strand.Header` and — for a closed strand — the founding `Member` + `Authority`. It only runs
when the caller passes `founder: true` down through `addStrand` → `launchStrand` →
`startStrand` → `StrandDatabase`. The flag is explicitly **caller-supplied**: the implement
ticket threaded and tested it but deliberately wired no production caller, flagging this as the
required follow-up.

**No production caller sets `founder: true` today.** Every real closed-strand creator pairs
`publishStrand(strandId, 'c', memberPrivateKey)` with an `addStrand` that omits the flag:

- `reference-app-web/src/lib/cadre-web.ts` → `createClosedChatStrand` (`addStrand` at ~line 476)
- `reference-app-rn/src/chat-strand.ts` → `createClosedChatStrand` (`addStrand` at ~line 156)
- `reference-app-ns/src/chat-strand.ts` → the equivalent creator helper

Consequence: in every real bring-up, the founder bootstrap never fires. A freshly-created
closed strand has **no** `Strand.Header`, no founding `Member`, and no founding `Authority`, so
it can never admit anyone via the invite/authority flows that tickets 2–4 build on. The feature
is effectively dead in production until a real caller opts in.

The matching join paths (`joinClosedChatStrandFromFormation`, `joinClosedChatStrand`) correctly
omit the flag — joiners must write nothing and receive rows via sync. Only the **creator/owner**
side needs `founder: true`.

> Note: the e2e ticket `strand-membership-closed-strand-e2e` (ticket 4) passes `founder:true`,
> but only inside its own test harness via a directly-constructed `StrandRow`. It does not wire
> the production reference-app creator flows, so this gap is not covered by it.

## What to do

- Pass `founder: true` from each closed-strand **creator** path (web/RN/NS, and any
  host/formation responder path that provisions+publishes a strand it founds), alongside the
  existing `mode: 'networked'`.
- Decide and document the founder predicate for the **formation responder/host** path
  specifically: the responder that provisions and publishes the strand is the founder; a
  redeeming initiator that joins is not. Confirm there is exactly one founder per strand.
- Open strands: confirm whether the open-strand creator paths should also found (they would seat
  a `Header(o)` only). Decide intentionally — currently open strands get no `Header` either.
- Add/extend a test at the reference-app or `CadreNode` seam asserting a created closed strand
  ends up with its founding `Header`/`Member`/`Authority` (today it silently has none).

## Out of scope

The bootstrap mechanism itself (landed + tested) and the invite/peer/rotation writers
(tickets 2–3). This ticket is purely about flipping the `founder` flag on in the real callers.
