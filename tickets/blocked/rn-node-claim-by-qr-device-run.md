description: Someone with an Android phone and a PC on the same Wi-Fi needs to try adding the PC's always-on node to the phone's cadre by scanning the code the PC shows, because the app's scan-and-claim screen was written and tested without any phone involved.
architecture: docs/architecture.md#which-side-dials-the-add-a-node-flows-compared
files: packages/reference-app-rn/src/add-node-section.tsx, packages/reference-app-rn/app/+native-intent.tsx, packages/reference-app-rn/src/node-code-scanner.tsx, packages/reference-app-rn/src/node-claim.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app.json, packages/cadre-rn/src/phone-node/config.ts, docs/reference-app-rn.md
repro: none
----

# Adding a home machine's node by scanning its code: nobody has tried it on a phone

**Blocked on hardware outside this repository:** a physical Android phone with a dev client rebuilt after `expo-camera` was added, on the same Wi-Fi as a PC that runs cadre-host. Unblock by running the session below and recording what it shows.

## Why this needs a person

The scan-and-claim flow (`rn-app-joins-host-node-by-qr`) landed with no device or emulator, so everything about it on a phone is read off the code. The headless coverage runs in Node: `test/node-claim.spec.ts` pins the words for each failure, and `integration-tests/src/scenarios/cadre-host-join-by-qr.integration.ts` claims a real cadre-host node with a phone-shaped `CadreNode` on the same machine. Nothing has exercised the camera, the permission prompts, the modals, or a dial from a phone across Wi-Fi.

## Setup

Follow `docs/reference-app-rn.md` → "Adding a Home Machine's Node (cadre-host)". Rebuild the dev client first: one built before `expo-camera` throws "Cannot find native module 'ExpoCamera'" when Settings loads. Where the doc turns out to be wrong, correcting it is part of this ticket.

**The PC's firewall, from the 2026-09-17 run of the earlier version of this flow** (Windows 11, Wi-Fi classified **Public**): `node.exe` had two inbound **Block** rules on the Public profile ("Node.js JavaScript Runtime", TCP and UDP) and no Allow rule on any profile, so Windows never prompted and every dial from the phone to the node's LAN address timed out (`adb shell nc` to the node's port timed out too, while the router answered). The doc's "The PC's firewall" lists the checks and both fixes. Fix the firewall before the run, or the first claim fails with the home-network message for a reason that is not the app's. Changing firewall settings on the user's machine is the person's call, not an agent's.

## What to run

| Case | How | Expected |
|---|---|---|
| Scan | `cadre-host join` (or the Join page), phone connected solo, Settings → Add an always-on node → Scan code | The approval prompt names this phone's Party ID and owner fingerprint, the node's peer id, and "Reachable only on the machine's home network…" (with `--no-upnp`). **Add to this cadre** → progress line → "Node added". The host's node page reads "Claimed by owner `<fingerprint>` into cadre `<party>`", matching the prompt, then shows the node connected within about 15 s of the node's restart |
| Paste | A fresh `join`; copy the text to the phone; paste → **Use code** | Same as Scan |
| Wrong code | Reset the node on the host (`cadre-host node reset <id>`), then use a screenshot or copied text of the old code | "The node did not accept this code…" (`claim-proof-invalid`), no Try again |
| Claimed node | Claim a node, then scan the same code from a second phone | "This node already belongs to another cadre…" (`already-claimed`), no Try again |
| Phone on cellular | Wi-Fi off, scan a code with LAN addresses only | The prompt already says home network only; the claim fails after about 21.5 s per address with "…can only be reached on the machine's home network so far…", and **Try again** is offered |
| Relaunch | After a successful claim, force-stop the app (`adb shell am force-stop org.gotchoices.sereus.chat`) and open it | Reconnects by itself with the same Party ID, and the node's peer id reappears among the phone's control connections without a new scan |
| System camera, cold start | Force-stop the app, point the phone's stock camera app (and Google Lens) at a fresh code, open the offered link | The app opens on Settings; once auto-start connects, the approval prompt shows. With no saved start, the Node card says a code is waiting; Connect, and the prompt shows |
| System camera, warm start | App open in the background; same as above | The approval prompt shows on Settings; leaving Settings and returning does not prompt again |
| Camera denied | Deny the camera permission on the first Scan code | The scanner says the camera is not allowed, offers Allow camera or Open system settings, and points to the paste field; paste still works |

Record which camera apps on the test phone offer to open a custom-scheme (`sereus-join:`) code at all. Also note how the modals behave when the scanner closes and the approval prompt opens in the same moment, how long the progress line runs on the LAN, and whether the wording fits the screen.

## If the run finds bugs

File each as its own ticket. Update the doc section in place with whatever the run teaches.
