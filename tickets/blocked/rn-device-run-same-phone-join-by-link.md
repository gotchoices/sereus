description: Someone with an Android phone and an iPhone (or emulator and simulator), each with two copies of the phone app installed, needs to try joining one app's cadre from the other app on the same phone by tapping a button instead of copying and pasting, because both halves were written and checked without a phone.
architecture: docs/architecture.md#between-apps-on-one-phone
files: packages/reference-app-rn/src/use-link-request.ts, packages/reference-app-rn/src/join-cadre-section.tsx, packages/reference-app-rn/src/join-link.ts, packages/reference-app-rn/src/add-device-section.tsx, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/app/+native-intent.tsx, packages/reference-app-rn/app.config.ts, packages/reference-app-rn/README.md, docs/reference-app-rn.md, docs/architecture.md
repro: none
----

# Joining by link between two apps on one phone: nobody has tried it on a device

**Blocked on hardware and a person outside this repository:** an Android device or emulator and an iOS device or simulator, each with both installs of `reference-app-rn` (the main one and the `APP_VARIANT=second` one), plus a cadre-host node or the e2e drone as the cadre's always-on machine. Unblock by running the table below and recording what it shows.

## Why this needs a person

Three tickets landed with no device: `phone-kit-same-phone-join-links` (the kit's link formats, the open-request record and the config plugin's `appLinks`), `reference-app-rn-answers-join-requests-by-link` (the owner app's Allow / Deny prompt and its answer by link) and `reference-app-rn-asks-owner-app-by-link` (the asking app's **Choose the app that holds your cadre**, the waiting line, taking the answer, and the second install). Their codecs and the open-request check have Node tests; nothing has delivered a link between two installed apps, shown Android's chooser, or cold-started an app from a link.

## Setup

Follow `docs/reference-app-rn.md` → "Joining an Existing Cadre" and "Adding a Device or App", and `packages/reference-app-rn/README.md` → "A second install on one phone". Each install of a development build needs its own dev server started with its own `APP_VARIANT` (the second on another port); a preview build of each avoids that. Call the app holding the cadre **A** and the app asking to join **B**; run each case with B as the second install and A as the main one, and at least once the other way round. Where the doc turns out to be wrong, correcting it is part of this ticket.

## What to run

| Case | How | Expected |
|---|---|---|
| First launch, each platform | Fresh B → **Yes, join my cadre** → **Choose the app that holds your cadre** → (iOS: pick A in the list; Android: pick A in the chooser) → **Allow** in A | B comes to the front by itself, shows the joining steps, then the done step as an owner. B never founded a cadre of its own |
| App with its own cadre and chats | B: No, start fresh → Connect → create a chat → Choose → Allow | Chats moved (the count shows), B's old cadre removed |
| Deny, then ask again | Choose → **Deny** in A; within 30 s, Choose again | First: "Not joined", A did not allow it. Second: answered `denied` by A with no prompt |
| A has no cadre | A fresh (first-launch question showing) → B: Choose → A | B: "Not joined", A has no cadre yet |
| A is a member only | A joined its cadre as a member → B: Choose → A | B: "Not joined", A is a member, not an owner |
| A disconnected | A: Disconnect → B: Choose → A | A's Node card says a join request from B is waiting; Connect, then the prompt opens; Allow answers B |
| B killed while A's prompt is open | B: Choose → A's prompt shows → kill B from the app switcher → Allow | B cold-starts from the answer and joins (after its auto-start, when it had a saved start) |
| Cancel in B, then Allow | B: Choose → switch back to B → **Cancel** → switch to A → Allow | B: "Cannot use this answer", not for a request this app has open; B stays where it was. A's invitation stays outstanding until it expires or is withdrawn |
| Relaunch while waiting | B: Choose → kill B → open B from its icon | B shows "Waiting for … to answer…" again, with Cancel |
| Android chooser lists B | Android: B: Choose → note the chooser's entries → pick B itself | The chooser lists both installs; picking B shows "That opened this app again…" and no waiting line |
| Android "Always" | Pick A with **Always**, then Choose again from B | No chooser; A opens directly. Clearing A's "Open by default" brings the chooser back |
| Android system camera | Show B's request QR code on another screen; point A's phone's system camera at it | The chooser opens; the request reaches A's Add a device or app as a pasted one (no reply), and the invitation shows for copying |
| iOS list empty | iOS with only one install: Choose | "No other Sereus app is installed on this phone. Copy this app's request …" |
| Response link length | After an Allow, read the length of the answer link from a temporary log line (the length only, never the link) | Recorded against the kit's estimate of about 4 KB (`CADRE_LINK_MAX_LENGTH` is 32 KB) |

Also note whether `app/+native-intent.tsx` receives the full URL for the iOS `<scheme>://cadre-join-request/…` and `…/cadre-join-response/…` forms, how long the hand-over takes each way, and whether the wording fits the screen.

## If the run finds bugs

File each as its own ticket. Update the doc sections in place with whatever the run teaches.
