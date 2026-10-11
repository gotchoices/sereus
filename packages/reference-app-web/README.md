# @serfab/reference-app-web

Svelte 5 + Vite SPA that runs a real **Sereus cadre node in the browser**. It is
the browser counterpart to `@serfab/reference-app-rn` (which targets phones via
React Native), and the validation surface for "the Sereus cadre/strand stack
actually works in a browser."

The app boots a `CadreNode` from `@serfab/cadre-core`:

```
CadreNode → control network (CadreControl) → signed open chat strand (chat sApp)
```

- **Control network** — an Optimystic network named `control-<partyId>` carrying
  the `CadreControl` schema (owner keys, cadre peers, strands).
- **Owner self-genesis** — a solo node seeds itself as its own owner,
  mirroring `cadre-cli start --owner` (bridge the libp2p identity into a
  base64url owner key, idempotent genesis `OwnerKey` insert, then
  `initializeSeedBootstrap`).
- **Signed chat strand** — an open strand whose chat sApp schema is **signed**;
  `StrandInstanceManager` verifies the signature on start
  (`assertSchemaSignature`), so the browser exercises the schema-signature gate
  the RN reference currently skips.
- **Strand database** — the chat `Participant`/`Message` tables backed by Quereus over
  Optimystic. A solo node coordinates its own writes, so DML lands on the
  strand's IndexedDB-backed storage with no peers needed.

Identity (Ed25519 peer key) and the start record (the party, and whether the tab
founded or joined it) persist in IndexedDB across reloads.

It also drives the **consent/invitation strand-formation flow** (Phase 2): a tab
can mint an `OpenInvitation` for the chat sApp (responder) or join via a pasted
invitation (initiator), forming a **closed** strand keyed by a minted member key.
The `CadreControl` authorization gates ("RBAC") — owner keys, formation
invites/usage, strand membership type + member-key presence, and a live
owner-gate probe — are observable on the Diagnostics page.

> **Live convergence is covered.** Two-party **cross-cohort convergence** (a
> message written by one party replicating to another through a shared closed
> strand) is exercised end-to-end by the formation→convergence e2e tier, with an
> in-process headless cadre **responder** as the dialable second party (the browser
> is the initiator and needs no relay) — see
> [Automated end-to-end tests](#automated-end-to-end-tests).

## Run

```bash
yarn workspace @serfab/reference-app-web dev      # dev server on :5173
yarn workspace @serfab/reference-app-web build    # static SPA bundle in dist/
yarn workspace @serfab/reference-app-web preview  # serve the built bundle
```

On first page load the app generates a fresh Ed25519 keypair and a party id,
stores both in IndexedDB (in the `sereus-strand-control` database's `kv` store),
and starts the cadre node. Reload preserves the peer ID and party ID. Each
control/strand network gets its own IndexedDB database:

- `sereus-strand-control` — the node-local records: identity, the start record
  (`party-start`), the per-party records (`<record>.<partyId>`) and any strand move record.
- `sereus-strand-control-<encoded party id>` — one party's control network blocks.
- `sereus-strand-sereus-web-chat` — the chat strand's blocks (participants/messages).

Delete those databases from DevTools → Application → Storage to reset identity
and stored messages.

## Routes

- `#/` — **Home** — node status, party id, peer id, control-network connection,
  chat-strand status, owner state, relay (dialability) status, Restart, and
  the **strand-formation panel**: create an invitation (responder) / join via a
  pasted invitation (initiator), showing the resulting strand id + membership type.
- `#/cadre` — **Cadre** — cadre membership: **Join my existing cadre** (see
  [Joining an existing cadre](#joining-an-existing-cadre)) and **Add a device or app** (see
  [Adding a device or app](#adding-a-device-or-app)).
- `#/messages` — compose / list chat messages backed by the strand's
  `App.Participant` / `App.Message` tables (Quereus SQL). The chat sApp is
  append-only — there is no edit/delete (that belonged to the old demo app).
- `#/log` — **Activity** — a CadreNode lifecycle event log
  (`control:*`, `strand:*`, `seed:*`, owner genesis), newest first.
- `#/diag` — diagnostics surface (see below).

## Storage bridge (`lib/strand-storage.ts`)

`CadreNodeConfig.storage.provider` is a **synchronous** factory
`(scope) => IRawStorage`, and cadre-core partitions data by scope key: the strand
id for each strand, and `controlStorageScope(partyId)` — `control-<hex party id>` —
for the control database. `IndexedDBRawStorage` wraps an **already-open**
handle (the opener is async) with no per-scope namespacing. The bridge pre-opens one
IndexedDB database per key (`sereus-strand-<key>`) **before** the synchronous
provider is hit — the app drives control bring-up and `addStrand` explicitly, so
every key is known ahead of time — and the provider returns a cached
`IndexedDBRawStorage` per key.

### Two databases, not one

The tab's **node-local** `kv` records — its Ed25519 identity, its start record, the
trusted-owner anchor, the bootstrap peers, the enrolled-machine count, the strand network
state — stay in the database historically named `sereus-strand-control`
(`NODE_LOCAL_STORE_KEY`). They cannot move into the party-scoped control database, because
the party id that names it is one of the records read out of them. So `startCadre` opens
the node-local database first, reads the start record, and only then opens
`sereus-strand-control-<encoded party id>` for the control **blocks**.

**The start record** (`lib/party-start.ts`, `kv` key `party-start`) is one JSON record per
tab: `{ v: 1, partyId, origin: 'founded' | 'joined', formerPartyId? }`, written in one put.
A tab with none mints a party and writes `origin: 'founded'`; a join rewrites it once a
member admitted the tab ([Joining an existing cadre](#joining-an-existing-cadre)). A record
that is present but unreadable fails the start with a clear message rather than starting a
fresh party over it; clear the site's data to start over. The old `party-id` key is not
read: a tab upgraded across this change starts a fresh party.

**Per-party records.** The four durable records are filed under `<record>.<partyId>`
(`partyKvKey` in `lib/node-local-slots.ts`), as the phone kit files its records, because a
tab that joins another cadre switches party, and comes back to the one it founded when the
join fails: one key per tab would have the joined party's first save overwrite the founded
party's records. Records under the old party-less keys are orphaned, unread.

A tab upgraded across this change keeps its identity, party id and trust anchor, and
comes up with an **empty control block store** — strands it founded before the upgrade
are not carried over. `runOwnerGenesis` re-anchors on every start, so the tab still
boots. The old unscoped blocks are left in place, unread and undeleted: they belong to
a party that was never recorded alongside them, which is the defect the scoping fixed.

## Solo cadre (Phase 1)

No control bootstrap, no listen addresses. The node self-seeds as its own
owner and hosts a single signed chat strand with no peers. Send →
list round-trips and the data survives reload (DML persists to the strand's
IndexedDB database). This is the single-node analogue of the RN reference's
current coverage, plus the schema-signature gate.

Owner genesis is **fail-soft**: the chat round-trip runs on the solo node
and does not depend on owner, so a genesis failure is surfaced on Home /
Diagnostics rather than aborting startup.

The chat strand's database can only be opened with the chat schema that
created it. A build whose `CHAT_SCHEMA` changes an existing table (a column
added, say) cannot open a database an earlier build left in the browser: the
schema apply issues `ALTER TABLE`, which the optimystic table module refuses,
and `startCadre` fails. Nothing migrates it under the current
no-backwards-compatibility policy; clear the site's data to start over.

## Strand formation (consent / invitation flow)

The Home **Strand formation** panel drives the cadre-core formation API
end-to-end. The flow is between two parties; in a browser-only demo that means
**two tabs** (a relayed second cadre), with the invitation moved out-of-band by
copy/paste:

1. **Responder** clicks *Create invitation* → `node.createOpenInvitation(sAppId)`
   mints a `FormationInvite` token, and `encodeInvitation` base64url-encodes it.
   Copy the encoded blob.
2. **Initiator** pastes it and clicks *Form strand* → `decodeInvitation` →
   `formStrand(invitation, { partyId })` runs the formation protocol against the
   responder's cadre and returns `{ memberKey, invitePrivateKey, strandId }`.
3. The initiator then launches the resulting **closed** strand against the same
   signed chat schema: `addStrand({ strandRow: { Id: strandId, MemberPrivateKey:
   invitePrivateKey, Type: 'c' }, sAppConfig })`.

### Dialability (relay reservation)

A browser tab can't open a listener, so to be **dialable** for formation it must
hold a circuit-relay-v2 **reservation** and advertise a `/p2p-circuit` address.
The relay is deployment infrastructure (see `ops/`), so its multiaddr is resolved
at runtime:

- `VITE_RELAY_ADDR` (build-time, comma-separated), then
- `localStorage["relay-addr"]` (per-browser, read only when the build sets none).

When a relay is configured the tab listens on `['/p2p-circuit', '/webrtc']`, and
`CadreNode.reserveRelays()` dials the relay, asks it for a reservation slot, and
waits for the `/p2p-circuit` address to appear (Home "Relay" row → `reserved`).
It then leaves a **supervisor** running that re-drives the reservation whenever it
is later lost, on a backoff that starts at 2 s and doubles up to 60 s. The dial,
the retries, and the status all live in cadre-core (`relay-reservation.ts`); this
app only supplies the addresses and renders the result.

Each relay is also the tab's **STUN** server, for upgrading a relayed connection to a
direct WebRTC one: cadre-core's `resolveStunServers` turns each relay address into
`stun:<relay host>:3478`. `VITE_STUN_URLS` (comma-separated `stun:` URLs) replaces
that, for a relay whose STUN is published elsewhere. See `ops/docs/ice-servers.md`.

The status is **recomputed on every read** from the node's live `/p2p-circuit`
addresses, so a reservation lost after startup (relay restarted, connection
dropped) stops reporting `reserved` and makes *Create invitation* refuse, rather
than minting an invitation carrying dead addresses. While the supervisor is
working the badge reads `retrying`, and it returns to `reserved` on its own once
the relay is back — no page reload. A resting `error` now means nothing is going
to try again (no node, or the node was stopped). The Home badge refreshes on the
4 s poll; `createInvitation` reads it at the decision point.

`network.relayAddrs` is deliberately NOT set on the browser config. It drives the
same reservation, but with the fail-fast posture: a first attempt that lands no
slot aborts `CadreNode.start()`, and a tab must still boot solo when its relay is
down. (It would also give the tab's strand nodes a per-relay circuit listener,
which is fatal at start in the same way.) So the tab keeps the explicit
`reserveRelays()` call.

The reservation is **requested explicitly**, not left to libp2p's relay discovery.
Discovery only nominates a peer it has learned the relay protocol from over
identify, and a cadre node's identify is network-namespaced while the relay in
`ops/` runs the stock one — so the tab would never learn that the relay is a
relay. Reserving needs no identify, and the tab was handed the relay's address,
so `relay-reservation.ts` asks for the slot directly.

With **no** relay configured the tab stays in the Phase-1 solo posture
(`listenAddrs: []`); *Create invitation* then surfaces a clear "not dialable —
configure a relay" error instead of failing silently. (Joining still works if the
pasted invitation points at a dialable responder.)

### Authorization gates ("RBAC")

There is no app-level role engine — "RBAC" here is the authorization model the
`CadreControl` schema constraints enforce, plus strand membership:

- `OwnerKey` / `ValidationKey` inserts are owner-signed (genesis bootstraps
  the first).
- `Strand` inserts are authorized by an owner signature **or** a valid
  `FormationUsage` row (indirect consent via a consumed `FormationInvite`).
- Closed strands (`Type: 'c'`) carry a member private key; open strands don't.

These gates are observable on Diagnostics (see below). The "Verify owner gate"
button attempts an *unauthorized* `Strand` insert (a non-enrolled key + bogus
signature, no consuming `FormationUsage`); the `CadreControl` constraint rejects it
at commit, demonstrating the gate is live.

> Live two-party cross-cohort convergence over a formed closed strand is covered by
> the formation→convergence e2e tier — see
> [Automated end-to-end tests](#automated-end-to-end-tests).

## Adding a device or app

The Cadre page's **Add a device or app** card is the owner side of
[handing an invitation from app to app](../../docs/architecture.md#handing-an-invitation-from-app-to-app),
with the phone app's flows and wording (`lib/add-device.svelte.ts`, `AddDevice.svelte`):

- **Paste request** — paste the join request the other app shows under *Join my existing
  cadre* and choose *Use request*. The tab refuses its own request and an app already in the
  cadre, then asks for approval: the app's name (what it calls itself, unverified), its code
  (the short peer id, to compare with the one the other app shows) and **Also an owner**.
  *Add* mints an invitation only that app can redeem
  (`createCadreInvitation({ peerId, grantsOwner })`). Paste only: no camera scanning.
- **Copy invitation** — an open, single-use invitation that whoever is given its text first
  can redeem. With **Also an owner** on, it expires in 15 minutes, and the card warns that
  its text grants admin rights until then.

The minted invitation shows as a QR code (`lib/QrCode.svelte`) and as text with a copy
button, with its expiry and, when no other machine of the cadre has an address a device
could dial, a warning that the new app can join only while this tab is open. It stays on
the card, in memory only, until *Done*, including across visits to other pages.
**Outstanding invitations** lists the live ones, latest expiry first, each with *Withdraw*.

Only an owner can mint: a tab that is not one, or whose owner genesis failed, sees one line
instead. The invitation must carry an address: with no relay reservation and no other
machine of the cadre holding one, *Make invitation* fails and says the tab has no relay
address. With a relay and no other machine (the usual solo tab) it succeeds with the
open-tab warning.

## Joining an existing cadre

The Cadre page's **Join my existing cadre** card is the joining side of
[handing an invitation from app to app](../../docs/architecture.md#handing-an-invitation-from-app-to-app):
a tab that founded a cadre of its own on first load joins the user's main cadre, with the
phone app's flow and wording (`lib/join-cadre.svelte.ts`, `lib/join-flow.ts`,
`JoinCadre.svelte`). The web app has no kit; `lib/cadre-web.ts` follows the phone kit's
sequence itself ([An app joins an existing cadre](../../docs/architecture.md#an-app-joins-an-existing-cadre)).

- **This tab's request** — the join request (`encodeCadreJoinRequest`, app name "Sereus web
  reference") as a QR code and copyable text, with the tab's code (the short peer id) to
  compare with what the owner's app shows. Paste it in that app under *Add a device or app*
  → *Paste request*, or ask it for an open invitation.
- **Join** — paste the response or open invitation and choose *Join*. A response made for
  another app's request is refused before anything stops. Already in the invitation's party
  (a second invitation, say one granting owner), the tab redeems in place. Otherwise its one
  node moves: the founded party's strands, pending joins and invitations are exported and
  kept as a move record (`lib/web-strand-move.ts`, `kv` key `strand-move.<partyId>`), the
  node stops and starts in the invitation's party (Home's status reads `joining`, and the
  "Add a device or app" card forgets its minted invitation and pending approval), and the
  invitation is redeemed there, waiting for a member to answer. The card shows each step:
  joining (with *Cancel* while it waits), admitted, moving strands, then done with the
  standing and the moved count. A join refused, expired or cancelled puts the tab back in
  the party it left, unchanged, and says why.
- **The move needs an owner grant.** When the founded party holds anything to move and the
  invitation makes the tab a member, the join is refused up front: every row a move seats is
  owner-signed. The tab's own chat strand has no control row, so a fresh tab's export is
  empty and a member invitation is fine; the chat strand keeps working in the joined party
  as the same local strand.
- **After admission** the start record names the joined party (`origin: 'joined'`, the
  founded party as `formerPartyId`), and the tab's key is wired for signing only when the
  party lists it as an owner (`wireOwnKeyIfOwner`; after an owner grant it is asked again
  every 2 s for up to a minute while the row arrives). Home's **Owner** row reads `enrolled`
  or `member`. A joined party never runs owner genesis, so a reload cannot seat the tab's key
  as a founding `OwnerKey` row of a cadre it merely joined.
- **Every start adopts** the move records naming its party, once the tab's key is wired as
  an owner there, before it reports `running`: a tab closed after admission finishes the
  move on its next load, and a member whose owner grant arrived late finishes it at the
  next start (*Restart node* on Home). Moved strands reach the party as rows, party keys
  and invitations; the tab does not open them (it has no `strand:discovered` handler).
- **The founded party stays in IndexedDB** under its own names (its control block database,
  its `<record>.<partyId>` records) until the tab dissolves it, a later ticket.
- **Two same-origin tabs** share the node-local database and the start record. A join in
  one tab switches the other only on its next load; until then the other keeps running the
  left party against that party's stores. Unsupported, on the same footing as the two-tab
  note in `lib/node-local-slots.ts`.

## Diagnostics (`#/diag`)

Polls every two seconds while the tab is visible. Surfaces:

- **Cadre** — party id, control-network connection + control peer id, CadrePeer
  membership count, owner self-genesis outcome, and the chat strand's status
  / connected peers / latency hint / sApp id / error.
- **Control authorization (RBAC)** — the `CadreControl` gates made observable:
  owner/validation key counts, the `FormationInvite` / `FormationUsage` audit
  rows, each control-DB `Strand`'s membership type (open/closed) + member-key
  presence, the relay-dialability posture, and a "Verify owner gate" button
  that probes an unauthorized control write (expected: rejected).
- **Identity** — peer ID, persistence badge, first-seen timestamp and age.
- **Connectivity** — control-node status, listen multiaddrs (empty in a browser
  peer), per-connection peer ID / remote multiaddr / direction / open protocols,
  and the relayed-vs-direct path summary.
- **Transports** — names of registered libp2p transports. The healthy browser
  bundle is **four** entries: WebSockets, circuit-relay, and the two WebRTC
  transports. **No TCP transport should appear** — cadre-core imports
  `@optimystic/db-p2p`'s main entry (which statically imports `@libp2p/tcp`),
  but the explicit transports array means `tcp()` is never instantiated, so it
  must not leak into the runtime list. Its presence indicates a Node-only
  transport leaked into the browser bundle.
- **FRET** — known peer count, network size estimate, churn, partition,
  Arachnode ring membership (on the control node).
- **Storage** — `IndexedDBRawStorage` (the control network's), quota / usage,
  raw approximate bytes, per-object-store row counts for the control database.
- **Crypto sanity** — host-API checks the libp2p stack relies on.
- **Recent errors** — a ten-deep ring buffer fed by the start/stop catch blocks,
  per-connection `close` events, and global `error` / `unhandledrejection`
  events.

## Vite config notes

Browsers natively provide `crypto.subtle`, `EventTarget`, `ReadableStream`,
`structuredClone`, `Promise.withResolvers`, `AbortSignal.throwIfAborted`, and
`TextEncoder`/`Decoder`, so the polyfill surface is much smaller than RN.

`vite.config.ts` aliases only the Node built-ins that transitive libp2p deps
reach for — `os`, `net`, `tls` → empty shim; `stream` → `readable-stream`;
`buffer` → npm `buffer`. cadre-core pulls in `@optimystic/db-p2p`'s main entry,
which statically imports `@libp2p/tcp`; the existing `net`/`os`/`tls` aliases
already cover its Node built-ins, and `tcp()` is never called (the app supplies
an explicit transports array), so nothing TCP-related runs. **`node:crypto` /
`crypto` are deliberately not aliased**: anything reaching for them in a browser
bundle is a real bug we want surfaced. (cadre-core's push notifiers formerly
imported `node:crypto`; they now live behind the Node-only
`@serfab/cadre-core/push-node` subpath, so a production `vite build` externalizes
no `node:crypto` from cadre-core.)

`src/polyfills.ts` handles the two residual gaps even modern browsers don't
cover:

- `globalThis.Buffer` — wired to the npm `buffer` package.
- `setTimeout` / `setInterval` return values with no-op `.ref()` / `.unref()`.

If you discover another missing API, add it to `polyfills.ts` with a comment
explaining which package needs it — do not introduce a `crypto` shim.

## Browser support

- **Chromium / Chrome**: primary development target.
- **Firefox**: should work — relies only on standard APIs (WebSocket, IndexedDB,
  WebCrypto, `crypto.subtle`). Smoke-check before relying on it.
- **Safari**: untested. `@optimystic/db-p2p-storage-web` targets Safari 14+.
  Smoke-check before relying on it.

If anything fails in Firefox / Safari, capture the console error and file a fix
ticket rather than papering it over with a shim — the same applies as for
`crypto`.

## Architecture

```
src/
  App.svelte             # nav + hash route switcher (Home, Cadre, Messages, Activity, Diagnostics)
  Home.svelte            # node status + party/peer/control/strand/relay state + strand-formation panel
  Cadre.svelte           # /cadre — cadre membership page
  JoinCadre.svelte       # /cadre's "Join my existing cadre" card
  AddDevice.svelte       # /cadre's "Add a device or app" card
  Messages.svelte        # /messages — chat strand send / list
  Activity.svelte        # /log — CadreNode lifecycle event log
  Diagnostics.svelte     # /diag — cadre + libp2p diagnostic surface
  main.ts                # mount + polyfill bootstrap
  polyfills.ts           # Buffer global + timer .ref/.unref shim
  main.css               # global styles
  lib/
    cadre-web.ts             # CadreNode lifecycle (control net, owner step, chat strand, the join)
    party-start.ts           # the start record: party id, founded or joined, the party left
    web-strand-move.ts       # move records: the founded party's strands carried into the joined one
    node-local-slots.ts      # per-party kv slots for the durable node-local records
    strand-storage.ts        # per-scope IndexedDB IRawStorage provider (pre-open bridge)
    chat-strand.ts           # chat sApp schema + signed SAppConfig + strand id
    store.svelte.ts          # Svelte 5 runes store: node state + CadreNode event log
    network.svelte.ts        # strand-formation panel state (create / join invitation)
    add-device.svelte.ts     # "Add a device or app" state: request, approval, mint, list, withdraw
    join-cadre.svelte.ts     # "Join my existing cadre" state: the request, the join and its steps
    join-flow.ts             # the join's steps, their words, and the words for each failure
    cadre-format.ts          # peer-id code + expiry text shared by the Cadre page's cards
    relay-config.ts          # optional circuit-relay multiaddr from a runtime manifest
    messages.svelte.ts       # chat strand DB wrapper — reactive message list + polling
    router.svelte.ts         # tiny hash-based router (#/, #/cadre, #/messages, #/log, #/diag)
    diagnostics.svelte.ts    # tick-driven snapshot store powering /diag
    Copyable.svelte          # copy-to-clipboard chip used in /diag and /cadre
    QrCode.svelte            # text drawn as an SVG QR code (the `qrcode` package)
  shims/
    empty.ts             # vite alias target for node:os / node:net / node:tls
```

## Automated end-to-end tests

A Playwright suite lives in `e2e/`. Chromium-only for now; Firefox / Safari are
explicit non-goals at this layer.

```bash
# One-time browser install (downloads Chromium if not already cached).
yarn workspace @serfab/reference-app-web test:e2e:install

# Run the suite (builds and previews the SPA automatically).
yarn workspace @serfab/reference-app-web test:e2e
```

- **Tier 1 — solo** (`e2e/solo/`) — always runs. Covers boot + identity/party
  persistence, hash routing, the chat strand send/list round-trip, reload
  persistence of strand DML, the schema-signature gate (a pure-Node assertion
  that the valid signed config verifies and a tampered one throws
  `SchemaVerificationError`), the diagnostics-surface invariants — notably the **four-transport** Transports list,
  the canary that no TCP transport leaked into the browser bundle — and
  (`formation-rbac.spec.ts`) the **formation + RBAC** surface a single tab can
  prove: the formation panel renders, the dialability guard rejects *Create
  invitation* with no relay, a malformed invitation is rejected on join, the
  **owner gate** rejects an unauthorized control write, and the authorization
  surface reflects the genesis owner + zero formation rows.
- **Tier 2 — formation → convergence** (`e2e/distributed/formation-convergence.spec.ts`)
  — the live two-party tier. The dialable second party is an **in-process headless
  cadre responder** (`e2e/fixtures/formation-responder.ts`), booted in the spec's
  `beforeAll` (the Playwright worker process — `global-setup` runs in a different
  process and cannot share the live node handle). The browser is the **initiator**:
  it dials out only, so it needs **no relay**. The happy path redeems an
  `OpenInvitation` through the Home formation panel, asserts a **closed** strand
  (`type:'c'` + member key) forms, wires the strand cohort link by hand
  (`__cadre.dialStrandPeer`, since control-network strand discovery is still TODO),
  and then proves convergence: a message the responder seeds replicates to the
  browser through the cohort, and the responder records a `FormationUsage` consent
  row bound to the strand. A negative test redeems a deliberately-**expired**
  invitation and asserts the join is rejected with no formed strand and no new
  consent row. The reverse (browser→responder) direction is a best-effort tail on
  the happy path. The tier self-skips if the responder cannot boot, and can be
  disabled with `FORMATION_E2E_DISABLED=1`. This tier replaced the obsolete
  bootstrap-mesh distributed suite, which asserted *membership-free* Optimystic
  convergence over a shared network — a model that no longer exists now that chat
  data lives in a strand cohort.
- **Tier 2 — join an existing cadre** (`e2e/distributed/join-cadre.spec.ts`) — an
  in-process headless cadre (`e2e/fixtures/cadre-member.ts`: owner genesis, a loopback
  WebSocket listener) mints a **member** invitation targeted at the tab's peer id; the tab
  pastes it under *Join my existing cadre*, and Home then shows that party and `member`.
  After a reload the same two values hold, the tab's key is absent from the party's
  `OwnerKey` rows (`__cadre.isOwner()` is false) and the start record says `joined`: the
  defect this pins is a joined party running owner genesis on every start. Same gate and
  self-skip as the formation tier.

Wiring this suite into CI is out of scope for the current ticket — it stops at
"runs cleanly locally."

## Out of scope (for follow-up)

- Real-time push (gossip / sync subscription wiring) — convergence is poll-based.
- A richer app-level RBAC notion beyond the schema-enforced `CadreControl` gates.
