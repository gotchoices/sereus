description: The browser reference app should also be able to rent a node from a hosting provider, as the phone app will: sign in on the provider's page, rent, add the node to the cadre, and show its status and subscription dates.
prereq: reference-app-rn-rents-a-provider-node
architecture: docs/architecture.md#provider-integration
files: packages/reference-app-web/src/Cadre.svelte, packages/reference-app-web/src/lib/machines.svelte.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/README.md
tradeoffs: The web app is a demonstration surface; a browser tab is rarely the owner device that pays for always-on nodes, and the OAuth redirect in a browser needs a return route the single-page app does not have today, so a maintainer may leave this to the phone app alone.
----

# The web reference app rents a provider node

`reference-app-rn-rents-a-provider-node` gives the phone app a store screen over cadre-core's `rentNode`, provider client and OAuth helpers (`cadre-core-provider-client-and-rent-node`). The same library runs in a browser, so the web app can offer the same on its Cadre page.

## What differs in a browser

- The sign-in redirect comes back to the app's own URL (`?code=…&state=…` on the page URL) rather than through an auth session; the app must carry the PKCE verifier and state across that navigation (session storage) and clean the URL afterwards.
- Tokens have no secure store; they live in the browser's storage for the origin, which the README should state plainly.
- A browser tab can hold a relay reservation, so `invitationReach` may read `anywhere` from the tab itself only when another machine is reachable; the path choice rule is unchanged.

## Expected behaviour

The Cadre page gains a "Rent an always-on node" card with the same rows and wording as the phone app's section (`docs/reference-app-rn.md` → Renting a Provider Node), and Devices and nodes marks a rented machine.
