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
