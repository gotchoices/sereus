description: Someone with two Android devices (or a device and an emulator) and an always-on machine needs to try the phone app's "join my existing cadre" flows by hand, because adding an app to a cadre, joining one, moving chats into it and the new first-launch question were all written and tested without a phone.
architecture: docs/architecture.md#an-app-joins-an-existing-cadre
files: packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/join-cadre-section.tsx, packages/reference-app-rn/src/add-device-section.tsx, packages/reference-app-rn/src/machines-section.tsx, packages/reference-app-rn/src/use-join-flow.ts, packages/reference-app-rn/src/join-flow.ts, packages/reference-app-rn/src/join-failure.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/maestro/_setup.yaml, docs/reference-app-rn.md
repro: none
----

# Joining an existing cadre on the phone app: nobody has tried it on a device

**Blocked on hardware and a person outside this repository:** two Android devices (or one device and an emulator) running the `reference-app-rn` dev client, plus a cadre-host node or the e2e drone as the cadre's always-on machine. Unblock by running the session below and recording what it shows.

## Why this needs a person

Four tickets landed with no device: `phone-kit-identity-peer-id-and-join-phases` (the kit's join progress and identity peer id), `reference-app-rn-owner-adds-device-or-app` (Settings → Add a device or app), `reference-app-rn-joins-existing-cadre` (Settings → Join my existing cadre, with chats moved and the old cadre removed) and `reference-app-rn-first-launch-asks-before-founding` (the "Do you already use Sereus apps?" question). `reference-app-rn-devices-and-nodes` (Settings → Devices and nodes, and the card a removed app shows) landed the same way. Their headless coverage runs in Node; nothing has exercised the screens, the QR codes, the camera or a join across a real network.

## Setup

Follow `docs/reference-app-rn.md` → "Adding a Device or App", "Devices and Nodes" and "Joining an Existing Cadre". Call the device that holds the cadre the **owner app** and the one joining it the **new app**. Where the doc turns out to be wrong, correcting it is part of this ticket.

## What to run

| Case | How | Expected |
|---|---|---|
| First launch, request and response | Fresh install of the new app → **Yes, join my cadre** → Copy the request; on the owner app, Add a device or app → Paste request, approve as owner; paste the response in the new app → Join | The new app shows the joining steps, then "This app is now part of your cadre" as an owner. It never founded a cadre of its own. Relaunch: it resumes the owner's party and does not ask again |
| QR both ways | As above, but scan the request on the owner app and the response on the new app | Same as above |
| Open invitation | Owner app → Copy invitation with **Also an owner** on (the bearer warning shows) → paste in the new app → Join | Done step, as an owner |
| Back and No | Fresh install → Yes → Back → No, start fresh | The question, then the Connect form; Connect founds a cadre, and the next launch does not ask |
| App that founded first | New app: No, start fresh → Connect → create a chat → Join my existing cadre with an owner invitation | Chats moved (the count shows), old cadre removed. Disconnect → Connect resumes the owner's party |
| Cancel while waiting | Stop the always-on machine, then join from an app with its own cadre | "waiting for an always-on machine" with the next try's time; **Cancel** puts the app back in its own cadre unchanged |
| Reach warnings | Make invitations on an owner app whose cadre's only dialable address is the issuer, and one that is local-network only | The `issuer-only` and `local-network` warnings show on the owner app |
| Withdrawn invitation | Make an invitation, Withdraw it under Outstanding invitations, then paste it in the new app | Refused with the `invite-spent` alert; the new app stays where it was |
| Devices and nodes, and removing the new app | After a join, on the owner app: Settings → Devices and nodes; then Remove on the new app's row (with a device it added as an owner, if any) → Remove | Both apps listed, the owner app's own row marked "(this device)", last seen within minutes; an invitation made for an app not joined shows "Invited, not joined yet". After Remove the row is gone, and the new app, if it was running, shows "This device was removed from cadre …" with Go back to your own cadre (when it founded one), Join a cadre and OK; leaving it in the background and returning does not start the removed cadre again |
| Maestro | `yarn workspace @serfab/reference-app-rn test:e2e` (emulator, dev client, Maestro, adb) | `_setup.yaml` answers the question with Yes, joins the drone's cadre and flows 1–4 pass |

Also note how long each joining step runs, whether the wording fits the screen, and how the modals behave when a scanner closes and an alert opens at once.

## If the run finds bugs

File each as its own ticket. Update the doc sections in place with whatever the run teaches.
