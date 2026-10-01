description: The sample phone and web apps join through an invitation once and show an error if the inviter is offline; switch them to the new "keep trying" join and show its status, so the samples demonstrate joins that finish later.
prereq: pending-join-retry-loop
files: packages/reference-app-rn/src/use-cadre.ts (joinViaInvite ~623), packages/reference-app-rn/src (invite/join screens), packages/reference-app-web/src/lib/cadre-web.ts (initiator formStrand path), packages/reference-app-rn/test/react/use-cadre.spec.ts
tradeoffs: The reference apps exist to show the API, and embedders (such as the Sereus Chat author who reported #25) build their own join screens, so the samples can lag without blocking anyone; it is UI work with device runs, not library work.
----
# Reference apps: join through `requestJoin` and show its status

`pending-join-retry-loop` adds `CadreNode.requestJoin`, `listPendingJoins`, `dismissPendingJoin` and the `pendingJoin:changed` event. The reference apps still call `formStrand` once (`joinViaInvite` in `use-cadre.ts`) and surface a failure when the inviter is unreachable.

## Wanted

- **Joining.** `joinViaInvite` calls `requestJoin`. When the result is `joined`, the app attaches the strand as it does today. When it is `waiting` or `pending`, the app shows the join in a "pending" list instead of an error.
- **The pending list.** It shows each pending join's state:
  - "Waiting for the inviter", with the last reason and the next attempt time;
  - "Joined";
  - "Failed", with the reason.

  It offers dismiss (cancel while pending). It updates from `pendingJoin:changed`.
- **A join that finishes later** (on this device after a restart, or on another owner machine of the party) arrives as `strand:discovered`, which the React Native app already claims. Verify that the closed-strand claim path picks it up with no extra handshake.
- **The web app** gets the same initiator-side change where it calls `formStrand`, or a note in its README explaining why not (a browser tab is not a long-lived machine).
