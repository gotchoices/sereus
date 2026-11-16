# @serfab/reference-app-web

A Svelte 5 and Vite single-page app that runs a cadre node in a browser tab. It is the browser counterpart of the React Native and NativeScript reference apps, and the one that exercises signed app schemas, strand formation and the cadre-management screens in a browser.

The reusable part, for a developer embedding a node in their own page, is documented in [Running a node in a browser](../../docs/platforms/browser.md). [The reference apps](../../docs/platforms/reference-apps.md) compares the three apps and describes the screens they share.

## What it demonstrates

- cadre-core's edge node (`createEdgeNode`) over IndexedDB: `src/lib/web-edge-platform.ts`, `src/lib/strand-storage.ts`, `src/lib/node-local-slots.ts`.
- A tab that founds a cadre on its own, seats its own owner key, and runs an open chat strand whose schema is signed. cadre-core verifies the signature when the strand starts.
- Strand formation between two parties: one creates a formation invitation bound to a closed strand, the other redeems it.
- Reachability through a circuit relay, with an upgrade to WebRTC.
- The cadre-management screens: adding a device, listing and removing machines, owner keys and owner grants, joining another cadre.
- Offline mode for the chat strand.
- A diagnostics page over the node, libp2p, storage and the control database's authorization rules.

## Prerequisites

- The repository installed and built: `yarn install` then `yarn build` at the root. The root `package.json` links `@optimystic/*` and `@quereus/quereus` to the sibling checkouts `../optimystic` and `../quereus`, which must be present and built.
- A Chromium-based browser. Firefox and Safari are untested.
- For the Playwright suite: `yarn workspace @serfab/reference-app-web test:e2e:install`, once, to install Chromium.

## Run

```bash
yarn workspace @serfab/reference-app-web dev      # development server on http://localhost:5173
yarn workspace @serfab/reference-app-web build    # type-check, then a static bundle in dist/
yarn workspace @serfab/reference-app-web preview  # serve the built bundle
```

On the first load the tab generates an Ed25519 identity and a party id, stores both in IndexedDB and starts the node. To check that it works:

1. **Home** shows Status `running`, Control `connected` and Owner `enrolled`.
2. On **Messages**, send a message. It appears in the list.
3. Reload the page. Home shows the same Party ID and Peer ID, and the message is still listed.

To start again as a new node, clear the site's data in the browser (DevTools → Application → Storage). [Which database holds what](../../docs/platforms/browser.md#which-database-holds-what) lists the IndexedDB databases the app creates.

## Routes

- `#/` **Home.** Node status, party id, peer id, control connection, chat-strand status, owner standing and relay state, a **Restart node** button, and the [strand formation](#strand-formation) panel.
- `#/cadre` **Cadre.** Four cards, each described in [The reference apps](../../docs/platforms/reference-apps.md):
  - **Join my existing cadre**: [Joining an existing cadre](../../docs/platforms/reference-apps.md#joining-an-existing-cadre)
  - **Add a device or app**: [Adding a device or app](../../docs/platforms/reference-apps.md#adding-a-device-or-app)
  - **Devices and nodes**: [Devices and nodes](../../docs/platforms/reference-apps.md#devices-and-nodes)
  - **Owner keys**: [Owner keys](../../docs/platforms/reference-apps.md#owner-keys)
- `#/messages` **Messages.** Send and list messages in the tab's chat strand, with an **Offline mode** checkbox and a mark on each message that is not yet delivered ([Messages not yet delivered](../../docs/platforms/reference-apps.md#messages-not-yet-delivered)). The list refreshes every 4 seconds.
- `#/log` **Activity.** The last 50 node events (`control:*`, `strand:*`, `seed:*`, `cadre:removed`) and the app's own records of relay, owner, join and dissolve steps, newest first.
- `#/diag` **Diagnostics.** See [Diagnostics](#diagnostics).

Where the web app's cadre screens differ from the phone apps', [Differences between the apps](../../docs/platforms/reference-apps.md#differences-between-the-apps) says how.

## The chat strand

The tab adds one open strand with the fixed id `sereus-web-chat` (`src/lib/chat-strand.ts`, `addChatStrand` in `src/lib/cadre-web.ts`). The id is constant so that its IndexedDB database, and so its messages, survive a reload. The strand is added with `founder: true` and no row in the control database, so it is local to the tab: a join to another cadre does not move it.

The schema is `CHAT_SCHEMA`; `test/chat-schema-drift.spec.ts` holds it equal to `schemas/chat-simple.qsql`. The app signs it at run time with a demonstration author key bundled in the source, which is not a real author identity. Two rules apply when changing it:

- **Raise `CHAT_SCHEMA_VERSION` with every change.** The version is covered by the signature, and a strand refuses an app whose schema version is below the highest it has seen ([App schema versions across a strand's members](../../docs/strands/app-schema.md#app-schema-versions-across-a-strands-members)).
- **A changed table may not open over stored data.** A build opens a database an earlier build left only when the change needs no rewrite of stored rows, such as adding a nullable column with no default. Otherwise adding the chat strand fails and Home's status reads `error`. Nothing migrates the data; clear the site's data.

## Strand formation

The Home panel runs cadre-core's formation calls between two parties ([Inviting and joining](../../docs/strands/formation.md)). The invitation text is moved by copy and paste.

1. **Create invitation** (`createInvitation` in `src/lib/cadre-web.ts`). The tab calls `createOpenInvitation` for the chat sApp, then `foundStrand` with `type: 'c'`, a new member key and the invitation bound to the strand, and shows the text from `encodeInvitation`. It refuses unless the relay state is `reserved`, because the invitation carries the tab's addresses.
2. **Form strand** (`joinViaInvitation`). The other party calls `decodeInvitation` and `formStrand`, then `addStrand` with the strand id and the member key the reply carried. If the first party's strand is still starting, `formStrand` fails with a retryable refusal and the invitation is not spent; press **Form strand** again.

The party that creates the invitation must be dialable, so in a demonstration between two tabs that tab needs a relay ([Environment variables](#environment-variables)). The joining tab only dials out and needs none.

## Scripts

Run each as `yarn workspace @serfab/reference-app-web <script>`.

| Script | What it does |
|---|---|
| `dev` | Vite development server |
| `build` | `typecheck`, `typecheck:e2e`, then `vite build` |
| `preview` | serves `dist/` |
| `typecheck` | `tsc --noEmit` over the app |
| `typecheck:e2e` | `tsc --noEmit` over the Playwright specs (`tsconfig.e2e.json`) |
| `check:svelte` | `svelte-check` |
| `test` | the Vitest unit suite |
| `dev:test` | Vitest in watch mode |
| `test:e2e` | the Playwright suite |
| `test:e2e:install` | installs Chromium for Playwright |
| `test:e2e:ui` | Playwright's interactive runner |

## Environment variables

| Variable | Read | Meaning |
|---|---|---|
| `VITE_RELAY_ADDR` | when the bundle is built or the dev server starts | comma-separated relay multiaddrs the tab reserves on |
| `VITE_STUN_URLS` | same | comma-separated `stun:` URLs that replace the default of one STUN server per relay host |
| `FORMATION_E2E_DISABLED` | by `test:e2e` | any non-empty value skips the Playwright specs under `e2e/distributed/` |
| `CI` | by `test:e2e` | two retries per test, and the suite starts its own preview server instead of reusing one |

When `VITE_RELAY_ADDR` is unset, the tab reads the browser setting `localStorage["relay-addr"]`, in the same format. `src/lib/relay-config.ts` reads the addresses at each start and at **Restart node**. With neither set the tab starts with no relay.

```bash
VITE_RELAY_ADDR=/dns4/relay.example.com/tcp/443/wss/p2p/<relay peer id> \
  yarn workspace @serfab/reference-app-web dev
```

```js
// In the browser console, for a build with no VITE_RELAY_ADDR; then press Restart node.
localStorage.setItem('relay-addr', '/ip4/127.0.0.1/tcp/4003/ws/p2p/<relay peer id>');
```

`ops/README.md` describes running a relay. [Transport and reachability](../../docs/platforms/browser.md#transport-and-reachability) explains what the reservation does.

## Tests

**Unit** (`test`). Vitest under Node over `test/**/*.spec.ts`: the key store and node-local store over a hand-built IndexedDB handle, the storage bridge, and the chat schema's match with `schemas/chat-simple.qsql`. The run starts with the [stale-build guard](../../docs/contributing/gates.md#stale-build-guard), because the specs execute compiled output of cadre-core and the linked sibling packages.

**Playwright** (`test:e2e`). Chromium only, one worker. The suite builds the app and serves it on `http://127.0.0.1:4173`. The root `yarn test` does not run it.

- `e2e/solo/` runs one tab alone: start and reload persistence, routing, the message round trip, the schema-signature check, the Diagnostics page, the formation panel's refusals, the owner-gate probe and an owner-key export.
- `e2e/distributed/` runs one tab against a cadre node started inside the test process (`e2e/fixtures/`). The tab redeems a formation invitation and a message written on each side reaches the other; it joins the node's cadre with a machine invitation; and it joins as an owner with an owner grant. These specs skip themselves when the in-process node cannot start.

Not covered by any spec: two tabs reaching each other through a relay, the Devices and nodes card, a tab's own removal, importing an owner key, redeeming an owner grant on the Owner keys card, and removing an owner key.

## Diagnostics

- **`#/diag`** refreshes every 2 seconds while the tab is visible. Its sections are Cadre, Control authorization, Identity, Connectivity, Transports, FRET, Storage, Crypto sanity and Recent errors.
- **Control authorization** shows the control database's owner and validation key counts, its `FormationInvite` and `FormationUsage` rows, and each `Strand` row's type and whether it has a member key. **Verify owner gate** attempts a `Strand` insert signed by a key that is not an owner, with no formation usage behind it, and reports whether the control schema rejected it.
- **Transports** should list four entries: WebSockets, circuit relay and two WebRTC transports. A TCP entry means a Node transport was instantiated in the browser.
- **Connectivity** lists each connection with its remote address and direction, and counts relayed and direct paths.
- **Home → Relay** reads `none`, `dialing`, `reserved`, `retrying` or `error`, refreshed every 4 seconds.
- **`window.__cadre`** exists while the node runs. It exposes read-only getters (party id, the running start options, relay state, owner standing) and the formation and formed-strand calls the Playwright specs use; `exposeDebugHook` in `src/lib/cadre-web.ts` lists them.

## Troubleshooting

- **Create invitation says the tab is not dialable.** No relay reservation is held. Set a relay address, press **Restart node**, and wait for Home → Relay to read `reserved`.
- **Relay stays at `retrying`.** The relay cannot be reached or refused the reservation; the reason is shown beside the state and on Activity. The node keeps trying. `error` means nothing is trying, because no node is running or it was stopped.
- **A relay or bootstrap address is never dialled from a deployed page.** A page served over HTTPS can open only `wss://` connections to other hosts.
- **The start fails with "The saved start … cannot be read".** The `start-options` record exists and cannot be parsed. The app will not found a new party over it; clear the site's data.
- **Home's status is `error` after a schema change.** See [The chat strand](#the-chat-strand).
- **Removing the cadre the tab left reports that a database is open in another tab.** Another tab of this origin still runs that party (`StoreDeleteBlockedError`). Close it; the browser then completes the deletion.
- **`check:svelte` reports a `PrivateKey` type mismatch in `src/lib/cadre-web.ts`.** Two copies of `@libp2p/interface` are resolved. (ticket `reference-app-web-libp2p-interface-dedup`)
- **`test` stops before running any spec.** The stale-build guard found a `dist` older than its `src`. Rebuild the package it names.

## Limits

- **Messages shows only the tab's own chat strand.** A strand formed through the Home panel is not shown there; it can be read and written only through `window.__cadre`.
- **Formed strands are not reopened after a reload.** cadre-core keeps the record of each strand joined from another party, but the app registers no handler that opens them again.
- **Two tabs of one origin run the same node identity.** Nothing stops a second tab from starting the party the first runs ([Limits and accepted tradeoffs](../../docs/platforms/browser.md#limits-and-accepted-tradeoffs)).
- **Lists are polled.** Messages and Home refresh on timers, not on change notifications.
- **No provider rental.** The Cadre page cannot rent an always-on node. (ticket `feat-reference-app-web-rents-a-provider-node`)
- **`allowPrivateDial` is on.** The app dials loopback, private and plain `ws://` addresses, which a development setup needs.

## Layout

```
src/
  main.ts, polyfills.ts     entry; Buffer global and timer handles
  App.svelte                navigation and the hash router's switch
  Home.svelte               node status and the strand formation panel
  Cadre.svelte              the Cadre page; JoinCadre, AddDevice, Machines, OwnerKeys are its cards
  Messages.svelte           chat strand: send, list, offline mode
  Activity.svelte           event log
  Diagnostics.svelte        diagnostics page
  lib/
    web-edge-platform.ts    the edge node's platform: key store, storage, transports
    strand-storage.ts       one IndexedDB database per storage scope
    node-local-slots.ts     key store and node-local records
    relay-config.ts         relay addresses from VITE_RELAY_ADDR or localStorage
    cadre-web.ts            the tab's edge node; chat strand, formation, invitations, debug hook
    store.svelte.ts         reactive node state; start, restart, join, dissolve
    chat-strand.ts          chat schema and its signed sApp configuration
    messages.svelte.ts      message list, marks, offline mode (send-marks.ts, queued-messages.ts)
    *.svelte.ts             state for each Cadre card and for diagnostics
  shims/empty.ts            alias target for os, net and tls
e2e/                        Playwright specs and fixtures
test/                       Vitest specs
vite.config.ts              aliases (see the platform document)
```

## Links

- [Running a node in a browser](../../docs/platforms/browser.md)
- [The reference apps](../../docs/platforms/reference-apps.md)
- [The cadre node](../../docs/cadre/node.md)
- [Relays](../../docs/network/relay.md)
- [Inviting and joining](../../docs/strands/formation.md)
- [Owner keys](../../docs/cadre/owner-keys.md)
