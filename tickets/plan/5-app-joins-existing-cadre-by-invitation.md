description: A second app on the same phone (or any new device) joins an existing cadre with an invitation from an owner app, either a targeted one (the new app copies a request with its peer id, the owner app returns an invitation for that peer id) or an open one (the owner app copies an invitation and the new app pastes it), and redeems it at any reachable machine of the cadre.
prereq: cadre-invitations-redeemable-by-any-member, owner-anchor-follows-owner-key-changes, control-approvals-bound-to-party
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/reference-app-rn/, docs/architecture.md
difficulty: medium
----

# Join an existing cadre by invitation

## Product decisions (settled with the project owner)

- Owner authority stays on user devices. cadre-host nodes are not owners.
- An invitation is the owner's signature; nothing is signed again at redemption (`cadre-invitations-redeemable-by-any-member`). It may name a peer id, or leave it to whoever redeems it.
- An app that joins usually becomes an owner too (default **yes**: any Sereus app on your phone should be able to do admin work).

## Two flows

**Targeted (request / response).** For owner grants, this is the safer default, because the invitation is useless to anyone else.
1. B: "Copy request" → `{ v, peerId, appName }`.
2. A: "Paste request", choose "also an owner", approve → A writes an invitation targeted at B's peer id and copies it.
3. B: "Paste response" → redeems at whichever cadre machine it can reach.

**Open (one paste).** A: "Copy invitation" (choose owner or not; single use; short expiry) → B: "Paste invitation". Whoever redeems it first designates the peer id, so the UI warns that an open owner invitation is equivalent to handing over admin rights until it is used or expires.

In both flows B pins the owner keys the invitation carries (the existing invite-pin trust path), so no separate operator anchoring is needed.

## What to build

- The app-facing calls on top of `createCadreInvitation` / `redeemCadreInvitation` (landed by `cadre-invite-redemption-protocol`; the apps' thin "Paste cadre invitation" / "Join cadre" wiring by `cadre-invitations-redeemable-by-any-member`): request encoding, invitation encoding (versioned, e.g. `sereus-invite:`, short enough to paste and to fit in a QR code; the member address list capped as `INVITATION_SIBLING_MACHINES` caps it), and B's progress states.
- **No always-on machine.** Two apps on one phone cannot connect to each other: phone nodes accept no connections, and iOS does not run two apps at once. Redemption needs a reachable member. A checks whether the cadre has a member with a public or relayed address and, if not, says so before handing over the invitation. B shows "waiting for an always-on node" rather than failing silently.
- B is still a member of its own one-node cadre at this point. Moving its strands and dissolving that cadre is `move-strand-between-cadres` and `dissolve-empty-cadre`. Decide, based on how the cadre-rn node handles party ids, whether one node joins a second party or B's app starts a second node for party A, and document it.

## Edge cases & interactions

- A goes offline right after issuing: B still redeems at the basement node once the invitation row has replicated there. If it has not arrived yet, the member answers retryably and B keeps trying. (Integration test: A issues, syncs to the basement, stops; B redeems.)
- A request pasted wrong: the peer id fails to parse and is rejected up front. A targeted invitation naming a key B does not hold is never redeemable; it expires.
- The same invitation pasted twice: the second redemption is idempotent for the same peer id, or refused as used.
- `grantsOwner: false`: B joins as a plain member and cannot publish strand joins (`JoinedStrand` is owner-signed). The UI says so.
- A lists its outstanding invitations and can withdraw them (owner-signed delete of the invitation row).

## TODO

- Request and invitation encodings and the app-facing calls.
- Document the flows in docs/architecture.md beside the invitation mechanism.
- Integration test: two phone-shaped nodes plus one reachable node; B joins A's cadre as an owner through each flow and can publish a `JoinedStrand`.

## Note from planning `cadre-invitations-redeemable-by-any-member`

Final names in cadre-core: `createCadreInvitation({ peerId?, grantsOwner, expiresInMs?, uses? })`, `redeemCadreInvitation(invitation)`, `listCadreInvitations()`, `withdrawCadreInvitation(key)`, and standalone `encodeCadreInvitation`/`decodeCadreInvitation`. The invitation is a keypair (the bundle carries the private half and the owner-signed row), so the bundle is larger than a token; it already carries the issuer's anchored owner keys and up to four members' addresses. The reference apps get a thin "Paste cadre invitation → Join" input in that chain; this ticket owns the request/response flows.
