description: Someone with a phone, a cadre-provider running on a machine the phone can reach, and Docker needs to try the phone app's "Rent an always-on node" screen by hand, because signing in through the system browser, renting a node and the rows for a stopped node were all written without a device or a live provider.
architecture: docs/architecture.md#renting-a-node-from-an-app
files: packages/reference-app-rn/src/provider-store-section.tsx, packages/reference-app-rn/src/provider-session.ts, packages/reference-app-rn/src/providers.ts, packages/reference-app-rn/src/rentals.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/+native-intent.tsx, packages/cadre-rn/src/provider/sign-in.ts, packages/cadre-rn/src/provider/rental-store.ts, docs/reference-app-rn.md
repro: none
----

# Renting a provider node from the phone app: nobody has tried it on a device

**Blocked on hardware and a person outside this repository:** an Android or iOS device running the `reference-app-rn` dev client built after `expo-web-browser` was added (a native rebuild), a machine the phone can reach running `@serfab/cadre-provider` with Docker, and a second device or install for the second rental. Unblock by running the session below and recording what it shows.

## Why this needs a person

`reference-app-rn-rents-a-provider-node` landed Settings → Rent an always-on node with no device and no live provider: the kit's sign-in and rental store, the app's session, rows and words are covered in Node, and cadre-core's `rentNode` and `finishRental` are covered against hand-written fakes. Nothing has opened the system browser, come back through the redirect URI, claimed a container over a real network, or watched a provider stop a node for non-payment. `cadre-core-provider-client-and-rent-node`'s handoff said the same: the wire shapes were checked against the provider's code, not against a running provider.

## Setup

Follow `docs/reference-app-rn.md` → "Renting a Provider Node" → "Dev setup": cadre-provider with `docker.publicHost` set to the address the phone reaches the machine at, the dev consent page on, a `provider` block, and the `sereus-chat` client with both redirect URIs; the dev client started with `EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL`. Where the doc turns out to be wrong, correcting it is part of this ticket.

## What to run

| Case | How | Expected |
|---|---|---|
| Browser hand-off, Android | Connect the phone solo → Settings → Rent an always-on node → Subscribe and add node → approve | The system browser (a Custom Tab) opens the consent page; after Approve it closes by itself and the progress line runs on. If the browser stays open or the progress line never moves, the auth session did not take the redirect: read the `code` and `state` off `/settings`'s query the way `nodeCode` is read and hand them to the pending sign-in (`provider-store-section.tsx`), and say so here |
| Browser hand-off, iOS | Same on an iPhone | Same, through `ASWebAuthenticationSession`; the first time, the OS asks whether the app may sign in through the provider's site |
| Cancel in the browser | Close the browser before approving | The section goes back to idle with no alert, no container at the provider, no row |
| Claim over the phone's network | After the browser closes, on a phone that is its cadre's only member | "Asking ‹name› for a node…", "Waiting for the node to start…" (up to two minutes while the image pulls), "Reaching the node and adding it to this cadre…", then the alert "Node added" with the peer id. The row reads Running · Joined within a minute; Devices and nodes lists an always-on node "Rented from ‹name›" |
| Killed mid-claim | Kill the app while "Waiting for the node to start…" shows; reopen | The row reads "Waiting for this phone to claim it" with Finish adding and Cancel; Finish adding ends in "Node added" |
| Second rental, invitation path | With the first rented node running, Subscribe and add node again | No claim: "Node requested" at once, the row reads "Joining through a machine of this cadre", then "Joined through ‹first node›" once the container redeemed the invitation at the first node. Note how long it took |
| Non-payment | Lapse the subscription on the provider (cadre-provider README → Subscription state) and wait for the next poll | The rows read Stopped with "‹name› stopped this node for non-payment." and the subscription line "Unpaid, stops ‹date›", then "Subscription lapsed"; Remove from cadre opens the Devices and nodes confirmation and removes the node with it unreachable; the row then goes |
| Cancel a node | Cancel on a running row → Cancel the node | The container is gone at the provider and the row with it; the subscription is unchanged |
| Sign out and back in | Sign out under the section; then Finish adding or Subscribe and add node | The rows read "Sign in to see its status"; the action opens the browser first and then runs |
| Expired tokens | Set a short access-token lifetime on the provider, leave the app open past it | The next poll refreshes without the browser; a refresh token the provider refuses (restart the provider with its token store cleared) makes the rows read "Sign in to see its status", and the next action signs in once and runs |
| Provider off | Stop cadre-provider, open Settings | "Could not read the provider: …" with Retry under Rent an always-on node; everything else in Settings works |

Also note whether the wording fits the screen, how the approval prompt and the browser behave when the keyboard is up, and whether the Terms and site links open.

## If the run finds bugs

File each as its own ticket. Update the doc section in place with whatever the run teaches.
