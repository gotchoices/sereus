description: The reference apps get a "Join my existing cadre" flow: show this app's peer id, accept an invitation from the owner app, then move this app's strands over and remove the now-empty cadre; and on the owner side, "Add a device or app": targeted or open invitation, owner or not.
prereq: app-joins-existing-cadre-by-invitation, move-strand-between-cadres, dissolve-empty-cadre
files: packages/reference-app-rn/app/settings.tsx, packages/reference-app-web/, docs/reference-app-rn.md
difficulty: medium
----

# Reference apps: join an existing cadre

## What to build

- **New app (B):** Settings → "Join my existing cadre" offers "Copy request" (peer id, copy plus QR) and a field to paste an invitation (targeted response or open invitation). After the code is applied: progress through joining → moving strands → removing the old cadre, in plain language.
- **Owner app (A):** Settings → "Add a device or app": either "Paste request" (targeted) or "Copy invitation" (open); choose "also an owner" (default on, with a one-line explanation, and a bearer warning on open owner invitations), then show the invitation (copy plus QR). Warn when the cadre has no reachable always-on machine.
- A list of outstanding invitations in A, with a withdraw action.
- Copy/paste and QR are the paths this ticket builds. On a phone, a deep link between the two apps becomes the main path (`same-phone-apps-exchange-join-by-deep-link`), and copy/paste stays as its fallback. Structure the screens so that ticket only adds an entry point and a return handler.
- **First launch asks first.** Before founding a cadre, a new app asks "Do you already use Sereus apps?" Yes leads into this join flow (or the ticket-10 enrollment), so the app never founds a cadre it then has to dissolve. No founds one as today. Moving strands (tickets 6 and 7) remains for apps that started on their own.
- Terminology in the UI: "Copy request" (B), "Paste request" then approve with the owner choice (A), "Paste response" (B); and for the open flow, "Copy invitation" (A) and "Paste invitation" (B).

## Edge cases & interactions

- The user cancels between the steps: B stays in its own cadre, unchanged.
- The move fails partway: show what moved and let the user retry (the move is resumable).

## TODO

- Implement in reference-app-rn and reference-app-web.
- Update docs/reference-app-rn.md.
- File a device-run blocked ticket for the RN flow once it lands.

## Note from planning `app-joins-existing-cadre-by-invitation`

Building blocks this ticket uses: `encodeCadreJoinRequest` / `decodeCadreJoinRequest` and the `sereus-invite:1.` invitation prefix (both decoders refuse the other kind by name); `CreateCadreInvitationResult.reach` (`anywhere` / `local-network` / `issuer-only`) for the warning before handing an invitation over; `redeemCadreInvitation(…, { waitForMember, signal, onProgress })` with `waiting` progress (`no-member-answered` → "waiting for an always-on machine", `member-not-ready` → "the cadre is catching up") and a cancel; `CadreNode.wireOwnKeyIfOwner`. On the phone, `PhoneNode.joinCadre` does the party switch and rollback, and the status has a `joining` state. Invitations are capped at 6 member addresses, which with 3 owner keys measured 1,972 characters: it fits a QR code. The web app has no kit: it must follow the same rules itself — one node, switch party by stopping it and building one for party A, never run its owner genesis (`ensureOwnerKey`, `cadre-web.ts`) for a joined party, call `wireOwnKeyIfOwner` instead, and restore party B on failure.

## Note from reviewing `app-joins-existing-cadre-by-invitation`

What the RN app's thin wiring left for these screens:

- **The Connect form keeps the party id it showed before the join.** Settings fills Party ID once at launch, so after a join without a relaunch, Disconnect → Connect starts the party the app left (as founded, which is safe) and reads as the join being undone. Refill the form from the running options after a join (`getRunningOptions()` in `cadre-phone.ts`).
- **Nothing shows the wait or offers a cancel.** `use-cadre.ts` `joinCadre` passes neither `onProgress` nor `signal` to `joinCadreByInvitation`, and Settings hides the connected sections (the Join section included) while the hook's status is `connecting`, so a join waiting for an always-on machine shows nothing until it ends. Disconnect cancels a join in the kit, but it is hidden too.
- **The hook holds the stopped node during the join.** Until `adoptRunningNode` runs at the end, `node` and `strands` in the hook are the node the join stopped; a screen that writes through them in that window gets the stopped node's error.
