description: Two Sereus apps on the same phone exchange the join request and the invitation automatically by opening each other through a deep link, so the user confirms once in the owner app instead of copying and pasting twice.
prereq: reference-apps-join-existing-cadre
files: packages/cadre-rn/src/, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/app.json, docs/reference-app-rn.md, docs/architecture.md
difficulty: medium
----

# Same-phone join by deep link

## Flow

1. In app B, "Join my existing cadre" → "Choose the app that holds your cadre". B opens an owner app with a request link carrying `{ v, peerId, appName, returnUrl }`.
2. Owner app A shows a confirmation: "‹appName› wants to join your cadre and be able to manage it. Allow?" The owner checkbox from `app-joins-existing-cadre-by-invitation` defaults on, and the peer id fingerprint is visible.
3. On Allow, A issues an invitation targeted at B's peer id (`app-joins-existing-cadre-by-invitation`) and opens `returnUrl` with it. On Deny, it opens `returnUrl` with a refusal.
4. B redeems the invitation and continues the reference-apps flow (join → move strands → dissolve).

Copy/paste from `reference-apps-join-existing-cadre` stays as the fallback: for a second device, for an owner app that does not support the link, and when the round trip fails.

## Security

- The confirmation in A is the authorization. A link is a request, never a grant.
- An invitation that reaches the wrong app is useless: it is targeted at B's peer id, and only the holder of B's key can redeem it. So a hijacked `returnUrl` leaks the cadre's machine addresses (the same as an invitation does), not access.
- The requester's name cannot be verified on iOS, because the opening app is not reported reliably. The confirmation must therefore describe what is granted and show the peer id fingerprint; it must not rely on the requester's name. On Android, when the request arrives as an activity-for-result intent, A can verify the calling package; show it when available.
- Rate-limit or collapse repeated requests, so a malicious app cannot flood A with prompts.

## Platform design (settle in planning)

- **Discovery.**
  - Android: every Sereus app registers one shared intent action (e.g. `org.sereus.cadre.ADD_DEVICE`). The system chooser then lists all installed owner apps, and the result can return through the activity result instead of a second link.
- **Pending handoffs** (`app-recommends-another-app-and-enrolls-it`) use the same request path: a request from an app with a pending handoff gets the stored invitation without a second prompt.
  - iOS: no chooser exists, and if two apps register the same custom scheme, which one opens is undefined. Options are per-app universal links (B must know A's domain), or B lists known Sereus apps' schemes in `LSApplicationQueriesSchemes` and offers those `canOpenURL` reports as installed. Pick one, and document how a new Sereus app gets onto that list.
- **Return link.** B's own scheme or universal link. B accepts a result only for a request it started (match a request nonce it issued), so an unsolicited link cannot inject an invitation.
- **Shared kit.** Put the request/response encoding, the confirmation data and the intent/link handling in `@serfab/cadre-rn` (a subpath export), so any Sereus app supports both sides without copying code. The reference app is the first user.
- Web (`reference-app-web`) is out of scope; it keeps copy/paste.

## Edge cases & interactions

- A is installed but has no cadre (or holds no owner key): it answers with a refusal saying so, not an invitation.
- The user leaves A without answering: B shows "waiting for ‹app›" with a cancel, and falls back to paste.
- B is killed while A is open: B receives the return link on a cold start and must resume from the persisted request nonce.
- Several owner apps exist for different cadres: the user picks one; nothing joins automatically.
- Link payload size: the invitation may be large. Check it against platform URL limits and use the activity result on Android.

## TODO

- Planning: settle iOS discovery and the return path; record the decisions here.
- Implement the kit pieces in cadre-rn and wire both sides in reference-app-rn.
- Document in docs/reference-app-rn.md and in docs/architecture.md beside the invitation flows.
- File a blocked device-run ticket covering both platforms (two installed apps).
