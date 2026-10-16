description: Decide whether an app that asks another app on the same phone to let it join the cadre (or that the owner app recommends) can be made an owner in the same step, now that machine invitations no longer grant ownership; without it, an app that has its own conversations to bring has to be given a separately pasted owner grant.
files: packages/cadre-core/src/cadre-join-request.ts, packages/cadre-rn/src/app-link/recommendation-store.ts, packages/reference-app-rn/src/add-device-section.tsx, packages/reference-app-rn/src/recommend-app-section.tsx, docs/architecture.md
----

# Can a join answered by link also make the app an owner?

**Blocked category:** the specification is silent on a product and security decision. **Unblocks with:** the project owner choosing one option below (or editing the recommendation), after which it becomes a `plan/` ticket.

## Background

The project owner decided that admitting a machine and granting ownership are two separate credentials: a **machine invitation** admits a device and grants nothing else, and an **owner grant** lets whoever holds it seat an owner key of their own (`owner-grant-separate-from-machine-invitation`, implemented by tickets `owner-grant-tables` … `cli-owner-grants`). "Add a device" no longer has an "also an owner" choice.

Two app-to-app flows used that choice:

- **Between apps on one phone.** App B (asking to join) opens owner app A with a join request; the user confirms in A; A opens B back with a response link carrying an invitation targeted at B's peer id (`docs/architecture.md` → "Between apps on one phone").
- **Recommending an app.** A records the user's pre-approval for B, including whether B is an owner; when B asks, A answers without a prompt ("Recommending another app").

An app that founded its own small cadre and has conversations in it can bring them only if it joins as an owner: every row the move writes is owner-signed (`StrandsNeedOwnerJoinError`). In the reference apps that is the common case for these flows.

After `machine-invitation-grants-no-ownership` both flows admit a machine only. B, refused with `StrandsNeedOwnerJoinError`, tells the user to make an owner grant in A (Owner keys → Add an owner key) and paste it into B, which then joins as machine and owner. That works, but it is the copy-and-paste step the link flow exists to avoid.

## Options

**A. The request carries B's owner key; approving as an owner adds it (recommended).** B's join request gains its owner slot's public key. A's prompt offers "Allow as an owner" beside "Allow"; choosing it, A adds that key with an ordinary owner-signed add (`CadreNode.addOwner`, labelled with B's app name) and answers with the machine invitation, as now. The recommendation's pre-approval keeps its owner choice and does the same when B asks.
- Nothing that grants ownership crosses the link: a hijacked reply scheme receives a machine invitation targeted at B, which is useless to it, which is today's security argument ("An invitation that reaches the wrong app is useless").
- The key is B's owner key, never its machine identity, so it keeps "an owner key is independent of machines".
- It reintroduces an owner choice in the approval prompt, which the decided UI removed from "Add a device"; the difference is that ownership goes to a key the app presented, not to the device.
- A must be connected to add the key (`addOwner` is refused when alone and the party has other members); A already has to be connected to answer a link.

**B. The response carries a machine invitation and an owner grant.** A's response link gains an optional owner grant (single use, 15 minutes) beside the invitation; B redeems both.
- Follows "one flow that does both is two invitations" literally.
- The grant is a bearer credential sent to whatever app answers to B's reply scheme. Today an app hijacking that scheme gets an invitation targeted at someone else's peer id; under this option it becomes an owner. That turns the accepted impostor-app tradeoff (`docs/architecture.md` → "Between apps on one phone", Security) into an ownership leak.

**C. Machine only (what ships after `machine-invitation-grants-no-ownership`).** The link flows admit a machine; ownership is a separately pasted owner grant.
- Simplest, nothing new to secure.
- The one-phone flow loses its no-copy property for any app with conversations, which is most of the reference apps' joins.

## If nothing is decided

Option C stays: apps with conversations to bring need a second paste, and the recommendation flow cannot make the recommended app an owner.

## Reversibility

Any option can be changed later. A and B each add one optional field to the join request or response (`v: 1` texts; the decoders would need to accept the new field), so moving between them is a code change with no stored state to migrate beyond the recommendation store's entry shape.
