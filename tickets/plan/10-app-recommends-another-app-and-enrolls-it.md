description: One Sereus app links to another. The user approves the new app's enrollment before leaving, which issues an invitation; after installing, the new app redeems that invitation on first launch and joins the user's cadre with no copy and paste.
prereq: same-phone-apps-exchange-join-by-deep-link
files: packages/cadre-rn/src/, packages/reference-app-rn/app/settings.tsx, docs/reference-app-rn.md, docs/architecture.md
difficulty: medium
----

# Recommend an app and enroll it on first launch

## Use case

App A shows a link to app B. The user taps it and is asked "Allow ‹B› to join your cadre (and manage it)?" before leaving A. They install B. On first launch, B joins A's cadre automatically.

## Design

B does not exist yet, so the invitation cannot name its peer id. Approving in A issues an **open** invitation (`cadre-invitations-redeemable-by-any-member`): single use, owner grant per the user's choice, short expiry (e.g. 1 hour), and annotated in A with the app it was meant for. A keeps the encoded invitation locally as a **pending handoff** for B, then opens the store page.

The invitation reaches B on first launch:
- **Android:** the Play Install Referrer carries it (or a handoff id that B exchanges with A through the ticket-9 intent, if the invitation is too large for the referrer).
- **iOS:** there is no install referrer. On first launch B asks "Join an existing cadre?" (the first-launch prompt in `reference-apps-join-existing-cadre`) and opens owner apps through the ticket-9 discovery. A finds the pending handoff for B and returns the invitation without asking again; the user already approved it.

B redeems the invitation at a reachable cadre machine (ticket 5). It has no strands yet, so nothing needs moving.

## Security

- This is an open owner invitation in transit, which makes it a bearer credential until it is redeemed or expires. Keep it single use and short-lived. Never put it in a URL that leaves the device (store links, web pages): only the install referrer or the on-device handoff carries it.
- On iOS the handoff goes to whichever app asks, because the caller cannot be verified. Hand it over only to a request that names the app it was issued for, and show a one-line notice in A ("Handed your invitation to ‹B›") so a misdirected handoff is visible. The user can withdraw the invitation from A's list.
- A handed-over invitation that is never redeemed expires on its own.

## Edge cases & interactions

- B is never installed: the invitation expires and the pending handoff is dropped.
- B launches after expiry: A offers to issue a fresh one (ticket 9 flow).
- Two recommended apps pending at once: one handoff each, matched by app id.
- B launched after A was uninstalled: B falls back to "Join an existing cadre" (paste) or founds its own cadre.

## TODO

- Pending-handoff store and matching in the cadre-rn kit; the link-out UI in reference-app-rn.
- Android install-referrer handling.
- Document in docs/reference-app-rn.md and docs/architecture.md.
