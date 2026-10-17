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
- **Owner self-genesis** — a solo node seeds itself as its own owner under an
  owner key of its own, never its libp2p identity (see [The tab's owner key](#the-tabs-owner-key)).
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

- `sereus-strand-control` — the key store (identity, owner key, joined-strand and strand-move
  records) and the node-local records: the saved start (`start-options`), the per-party records
  (`<record>.<partyId>`) and, while the old cadre is being removed, the dissolve marker
  (`dissolving-party`).
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
  [Joining an existing cadre](#joining-an-existing-cadre)), **Add a device or app** (see
  [Adding a device or app](#adding-a-device-or-app)), **Devices and nodes** (see
  [Devices and nodes](#devices-and-nodes)) and **Owner keys** (see [Owner keys](#owner-keys)).
- `#/messages` — compose / list chat messages backed by the strand's
  `App.Participant` / `App.Message` tables (Quereus SQL). The chat sApp is
  append-only — there is no edit/delete (that belonged to the old demo app).
- `#/log` — **Activity** — a CadreNode lifecycle event log
  (`control:*`, `strand:*`, `seed:*`, owner genesis), newest first.
- `#/diag` — diagnostics surface (see below).

## Storage bridge (`lib/strand-storage.ts`)

The tab runs `@serfab/cadre-core/edge-node`'s edge node over IndexedDB (`lib/web-edge-platform.ts`;
[Architecture → The edge node](../../docs/architecture.md#the-edge-node)), the same runtime the
phone kit's `createPhoneNode` runs over the secure store and rn-leveldb. cadre-core partitions data
by storage scope key: the strand id for each strand, and `controlStorageScope(partyId)` —
`control-<hex party id>` — for the control database. `IndexedDBRawStorage` wraps an
**already-open** handle (the opener is async), while `EdgeNodeStorage.rawStorage` is synchronous,
so the platform returns cadre-core's `lazyRawStorage` over `openStore(scope)`: a scope's database
(`sereus-strand-<key>`) opens on its first use, nothing is opened ahead of a start or an
`addStrand`, and a strand the control network lists gets storage like any other. One handle and
one `IndexedDBRawStorage` per key, cached until the edge node's stop closes them (`closeStores`).

### Two databases, not one

The tab's **node-local** `kv` records stay in the database historically named
`sereus-strand-control` (`NODE_LOCAL_STORE_KEY`): the tab's key store (`lib/node-local-slots.ts` →
`nodeLocalKeyStore`: the Ed25519 identity under `peer-private-key`, the owner key under
`owner-private-key`, and cadre-core's joined-strand and strand-move records under
`keystore.<slot>`) and the edge node's node-local records (`nodeLocalKv`: the saved start, the
dissolve marker, and each party's trusted-owner anchor, bootstrap peers, enrolled-machine count and
strand network state under `<record>.<partyId>`, the keys `cadre-core/src/edge-node/node-local.ts`
names). They cannot move into the party-scoped control database, because the party id that names it
is one of the records read out of them. Each party's records are filed under its own id because a
tab that joins another cadre switches party, and comes back to the one it founded when the join
fails: one key per tab would have the joined party's first save overwrite the founded party's records.

**The saved start** (`kv` key `start-options`, the edge node's record) names the party and how the
tab came to it (`origin: 'founded' | 'joined'`, the party left as `formerPartyId`). On load the store
reads it and starts its options with the current relays (`lib/store.svelte.ts` → `start`); its
`autoStart` is ignored, since a tab starts on load. A tab with none mints a party and starts it as
`founded`, with the owner-key label `browser`; a join rewrites it once a member admitted the tab
([Joining an existing cadre](#joining-an-existing-cadre)). A record that is present but one the
edge node cannot use (it logs and drops it) fails the start with a clear message rather than
founding a fresh party over it; clear the site's data to start over.

**Upgrade.** A tab from before the edge node has a `party-start` record and no `start-options`, so
it founds a fresh party once; the old party's data and any `strand-move.*` records stay unread in
IndexedDB. Its identity and owner key carry over, since they are under the same `kv` keys.
Development builds only, no compatibility.

The node-local database also holds the control **blocks** of tabs that ran before the
block store became party-scoped. They are left in place, unread and undeleted: they
belong to a party that was never recorded alongside them, which is the defect the scoping
fixed (see the `NODE_LOCAL_STORE_KEY` comment in `lib/strand-storage.ts`).

## Solo cadre (Phase 1)

No control bootstrap, no listen addresses. The node self-seeds as its own
owner and hosts a single signed chat strand with no peers. Send →
list round-trips and the data survives reload (DML persists to the strand's
IndexedDB database). This is the single-node analogue of the RN reference's
current coverage, plus the schema-signature gate.

Owner genesis is **fail-soft and bounded** (the edge node's `runOwnerGenesis`, 60 s): the chat
round-trip runs on the solo node and does not depend on owner, so a genesis that fails or does not
settle is logged and shown as `failed` or `timed-out` on Home / Diagnostics rather than aborting
startup.

### The tab's owner key

The tab keeps one owner key, apart from its identity, under the node-local `kv` key
`owner-private-key` (the libp2p protobuf bytes of an Ed25519 private key, the identity's stored
form, written strict where the browser supports it): the `cadre/owner` slot of the tab's key store
(`nodeLocalKeyStore` in `lib/node-local-slots.ts`), which the edge node's owner step reads. One per
tab, not per party: a key may own several cadres.

- **Founded party, no `OwnerKey` row yet:** the slot's key (created now unless the slot
  already holds one) becomes the founding row, labelled `browser`, and is wired. Home's
  **Owner** row reads `enrolled`.
- **Founded party that has owners:** the slot's key is wired only when it is a live owner
  (`enrolled`); otherwise the tab is a `member` and no key is created, since a new one could
  not be seated without another owner's signature.
- **Joined party:** see [Joining an existing cadre](#joining-an-existing-cadre).
- **`failed`, `timed-out`:** the owner step threw (logged to the console) or did not settle within
  the edge node's bound; the node runs without an owner key wired.
- **Backup, export, import** (`lib/cadre-web.ts`, pass-throughs to the edge node, behind the Cadre
  page's [Owner keys](#owner-keys) card): `addBackupOwnerKey` seats a new key as an owner under a
  label and returns it with its export, keeping nothing; `exportOwnerKey` exports the tab's own key
  and names the key it exported; `importOwnerKey` stores an exported key in the slot (refused when
  the slot holds a different one) and wires it when the party lists it, which the edge node reports
  as `running` with the owner `enrolled` and the store follows. All three are cadre-core's
  `owner-key-flows.ts`, optionally passphrase-locked. Listing and removal (`listOwnerKeys`,
  `planOwnerKeyRemoval`, `removeOwner`) go through the edge node the same way, in turn with its
  transitions.
- **Exposure** is the peer key's: origin-scoped IndexedDB. Clearing the site's data loses the
  owner key with the identity, and the tab is then no owner of the party it founded unless it
  imports a backup of the key. Non-extractable WebCrypto keys were weighed and declined,
  because a file or QR backup needs an exportable key.

The chat strand's database can only be opened with the chat schema that
created it. A build whose `CHAT_SCHEMA` changes an existing table (a column
added, say) cannot open a database an earlier build left in the browser: the
schema apply issues `ALTER TABLE`, which the optimystic table module refuses,
and adding the chat strand fails (Home's status reads `error`). Nothing migrates it under the current
no-backwards-compatibility policy; clear the site's data to start over.

## Strand formation (consent / invitation flow)

The Home **Strand formation** panel drives the cadre-core formation API
end-to-end. The flow is between two parties; in a browser-only demo that means
**two tabs** (a relayed second cadre), with the invitation moved out-of-band by
copy/paste:

1. **Responder** clicks *Create invitation* → `foundStrand(…, { background: true })`
   publishes the closed host strand the invitation is bound to and continues its
   start in the background, `node.createOpenInvitation(sAppId)` mints a
   `FormationInvite` token, and `encodeInvitation` base64url-encodes it. Copy the
   encoded blob.
2. **Initiator** pastes it and clicks *Form strand* → `decodeInvitation` →
   `formStrand(invitation, { partyId })` runs the formation protocol against the
   responder's cadre and returns `{ memberKey, invitePrivateKey, strandId }`. While
   the responder's host strand is still starting, `formStrand` throws the retryable
   `host-strand-unavailable` refusal and the token stays unspent; *Form strand*
   again.
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

When a relay is configured the tab listens on `/webrtc` plus the bare `/p2p-circuit` entry
cadre-core adds for a named relay, and the edge node's config names the relays through
`network.relayAddrs` with `requireRelay: false` (`cadre-core/src/edge-node/config.ts`): the
control node dials the relay, asks it for a reservation slot, and waits for the `/p2p-circuit`
address to appear (Home "Relay" row → `reserved`), and each strand node gets a supervised
reservation of its own, so the tab's strand nodes publish a circuit address too. A first attempt
that lands nothing is logged and retried in the background rather than failing the start, so a
tab still boots solo when its relay is down. The **supervisor** re-drives the reservation whenever
it is later lost, on a backoff that starts at 2 s and doubles up to 60 s. The dial, the retries,
and the status all live in cadre-core (`relay-reservation.ts`); this app only supplies the
addresses (`lib/web-edge-platform.ts`) and renders the result.

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
  cadre, then asks for approval: the app's name (what it calls itself, unverified) and its code
  (the short peer id, to compare with the one the other app shows). *Add* mints an invitation
  only that app can redeem (`createCadreInvitation({ peerId })`). Paste only: no camera scanning.
- **Copy invitation** — an open, single-use invitation that whoever is given its text first
  can redeem.

Either invitation admits the app as a machine and a member, for 24 hours, and grants no
ownership. An app that is to be an owner too takes an owner grant, made under an owner app's
Owner keys; this tab's own owner-grant card and a join field that takes a grant are
`reference-app-web-owner-grants`.

The minted invitation shows as a QR code (`lib/QrCode.svelte`) and as text with a copy
button, with its expiry and, when no other machine of the cadre has an address a device
could dial, a warning that the new app can join only while this tab is open. It stays on
the card, in memory only, until *Done*, including across visits to other pages.
**Outstanding invitations** lists the live open ones, latest expiry first, each with *Withdraw*.
One made for a single app is listed under [Devices and nodes](#devices-and-nodes) instead, as
a device invited and not joined yet, so each invitation shows once.

Only an owner can mint: a tab that is not one, or whose owner genesis failed, sees one line
instead. The invitation must carry an address: with no relay reservation and no other
machine of the cadre holding one, *Make invitation* fails and says the tab has no relay
address. With a relay and no other machine (the usual solo tab) it succeeds with the
open-tab warning.

## Devices and nodes

The Cadre page's **Devices and nodes** card lists every machine of this cadre and lets an
owner remove one: an uninstalled app, a lost or stolen phone, an always-on node whose machine
died ([Removing a machine](../../docs/architecture.md#removing-a-machine)). It has the phone
app's list, confirmation and wording ([reference-app-rn.md → Devices and Nodes](../../docs/reference-app-rn.md#devices-and-nodes)),
with "this tab" for "this device" (`lib/machines.svelte.ts`, `Machines.svelte`).

- **The list** has one row per machine `CadreNode.listMachines` reports: what it is, from the
  node profile it published ("App", "Always-on node", or "Machine" until it publishes one), with
  "(this tab)" on the tab's own row; "Last seen" from its last self-signed record (a running
  machine re-stamps it every 7.5 minutes); and "Key", the first 8 characters of its identity
  key, in the fingerprint form cadre-host uses. A row that no longer passes this tab's
  membership check says **Not trusted here**. Owner keys are not machines and are not listed
  here.
- **Invited, not joined yet**: each live invitation made for one app whose peer has not
  joined, with its code, owner or member, and expiry, and *Withdraw* (asks once).
- **When it is read**: when the node reaches `running` and its owner step settles, after each
  removal or withdrawal here, after *Add a device or app* makes an invitation, and on
  *Refresh*; it is not polled. A read that finishes after the node was replaced is dropped.
- **Who can remove.** On an owner tab every row has *Remove* except the tab's own, under which
  "A tab does not remove itself from its cadre: to remove this tab, use another owner device."
  (`self`): leaving a cadre is the tab's own flow, and another machine removes it, which the tab
  then learns ([When this tab is removed](#when-this-tab-is-removed)).
  A member sees the list with one line saying only an owner can remove machines.
- **The confirmation** reads `planMachineRemoval` and opens "Remove this ‹app, always-on node or
  machine›?" in the card, with the machine's key, what happens (it leaves the cadre, and the
  invitations it could join again with are withdrawn), and what removal does not do. *Remove*
  runs `removeMachine`. One another owner removed meanwhile says "Already removed". The
  confirmation stays open across a visit to another page; a join, or this tab's own removal,
  closes it.
- **A lost phone's owner key stays.** Removing a machine leaves every owner key live, so the
  confirmation also says "If this was a lost or stolen phone that held an owner key, remove that
  key too in Owner keys; otherwise whoever has the phone can still act as an owner.", with
  *Go to Owner keys*, which closes it and scrolls to [Owner keys](#owner-keys).

### When this tab is removed

When an owner removes this tab from its cadre while the tab runs, the node reports it
(`cadre:removed`) and the edge node acts on it, as on the phone
([cadre-rn README → Removed from the cadre](../cadre-rn/README.md#removed-from-the-cadre)):

1. **In turn.** A start, stop, join, dissolve or strand-move retry in progress finishes first:
   the edge node queues the removal behind them.
2. **The node stops**, and the saved start stops naming the party before anything is deleted.
   It becomes a start of `formerPartyId`, the party the tab founded and left, or is deleted when
   there is none. The tab ignores the record's `autoStart`, so the next load starts that party,
   or founds a fresh one, as the card's button does.
3. **The party's storage is deleted** with the dissolve's marked removal
   ([Removing the cadre the tab left](#removing-the-cadre-the-tab-left)), after finishing any
   removal a marker already names.
4. **Status `removed`.** The store maps the edge node's `removed` to its own: the Cadre page
   shows "This tab was removed from cadre ‹party id› by an owner (‹its key's fingerprint›). Its
   copy of that cadre has been deleted from this browser.", with **Go back to your own cadre**
   when the tab founded one, or **Start a new cadre**, and a line saying that joining another
   cadre starts from the tab's own, since a join switches a running node. *Restart node* on Home
   does the same. The card stays until a start reaches `running`. The join card's steps and an
   open removal confirmation are cleared.

It is best-effort, as the report is: a tab removed while it was closed is not told after the
next load, and runs that cadre while its machines refuse it (the `NOTE:` at `watchRemoval` in
`cadre-core/src/edge-node/edge-node.ts`). A failure acting on the report is logged by the edge
node and reaches the store as `error`.

## Owner keys

The Cadre page's **Owner keys** card lists this cadre's owner keys, makes a backup key, exports
this tab's key, imports a key, and removes one
([architecture.md → Owner Keys](../../docs/architecture.md#owner-keys)). It has the phone app's
list, forms, prompt and wording ([reference-app-rn.md → Owner Keys](../../docs/reference-app-rn.md#owner-keys)),
with "this tab" for "this device", Download for Share, and paste only for Import, since a tab
has no scanner (`lib/owner-keys.svelte.ts`, `OwnerKeys.svelte`, `OwnerKeyExportForm.svelte`).

- **The list** has one row per live owner key `listOwnerKeys` reports: the name it was added
  under ("browser" for the key the tab founded its cadre with), or "Unnamed key"; its fingerprint
  (first 8 characters), with "This tab" on the key this tab signs with; and **Not trusted here**
  when this tab's trusted-owner anchor lacks it. It is read when the node reaches `running` and
  its owner step settles, after each action here, and on *Refresh*; a read that finishes after
  the node was replaced is dropped. A member sees the list, one line saying only an owner can add
  or remove owner keys, and Import.
- **Make a backup key** (owner only): a name (default "Backup", at most 64 characters) and
  **Protect with a passphrase**, on by default, with the passphrase typed twice; the button stays
  disabled and says why while the passphrase is empty or the two differ. `addBackupOwnerKey`
  seats the key as an owner, and the card shows its export once, the only copy.
- **Export this tab's key** (owner, when the list marks a key "This tab"): the same form, the
  name defaulting to that key's, then `exportOwnerKey`, which exports the key in the tab's owner
  slot and names it, and the export is titled with that key. The slot's key is the only key the
  tab signs with, so the export is the key the list marks.
- **The export** stays on the card until *Done*, including across visits to other pages:
  "Anyone who has this can control your cadre. Keep it somewhere safe and offline. This tab does
  not keep a copy.", the QR code, the text with a copy button, and *Download*, which saves it as
  `sereus-owner-key-‹fingerprint›.txt` through a `Blob` URL revoked a second after the click.
  Nothing of it is written to `localStorage` or IndexedDB. A join, its rollback or a restart
  replaces the node, and the card's next read forgets the export with the rest of the card.
- **Keep a backup: this tab's own key is site data.** The tab's owner key lives in its origin's
  IndexedDB ([The tab's owner key](#the-tabs-owner-key)), so clearing the site's data loses it
  with the tab's identity. A backup key, or an export of this tab's key, kept outside the browser
  is what makes the tab an owner again after that.
- **Import an owner key** takes pasted export text; a locked one
  (`sereus-owner-key-locked:1.…`) shows a passphrase field. The outcomes are the phone's: an owner
  of this cadre ("This tab is now an owner of this cadre, with ‹name› (‹fingerprint›)."); an owner
  this tab takes from its next start, when the node already signs with another key; and "This
  key is not an owner of this cadre. An owner can add
  it.", the key kept in the slot. The last two both come back `wired: false`, and the card reads
  the owner keys again to tell them apart. A tab already holding a different key, a wrong
  passphrase and text that is not an owner key are refused by name. A wired key changes the
  owner state with the node still `running`, so Add a device or app and Devices and nodes read
  their standing again.
- **Remove** (owner only, on every row but this tab's own, under which "A tab cannot remove its
  own owner key; use another owner key."): `planOwnerKeyRemoval`, then "Remove owner key
  ‹name› (‹fingerprint›)?" in the card, with one **Keep** box per device or owner key the removed
  key added (checked by default; a device named as Devices and nodes names it), the line about
  this tab's own key when the removed key added it (`ownDependency`), and the `last-owner`
  refusal ("It cannot be removed: it is the only owner key of this cadre.") with only *Close*.
  *Remove* runs `removeOwner(key, { revouch })` with the kept rows, then both cards re-read.

**Uses.** A lost or stolen phone that held an owner key: remove its machine under Devices and
nodes, then its key here. A backup to keep offline: make a backup key, then download or print the
QR code. A new browser or phone: join the cadre, then import a backup key there.

## Joining an existing cadre

The Cadre page's **Join my existing cadre** card is the joining side of
[handing an invitation from app to app](../../docs/architecture.md#handing-an-invitation-from-app-to-app):
a tab that founded a cadre of its own on first load joins the user's main cadre, with the
phone app's flow and wording (`lib/join-cadre.svelte.ts`, `lib/join-flow.ts`,
`JoinCadre.svelte`). The join is the edge node's `joinCadre` ([An app joins an existing
cadre](../../docs/architecture.md#an-app-joins-an-existing-cadre)), called by the store once
`lib/web-join.ts` has decoded the pasted invitation and found it to be this tab's.

- **This tab's request** — the join request (`encodeCadreJoinRequest`, app name "Sereus web
  reference") as a QR code and copyable text, with the tab's code (the short peer id) to
  compare with what the owner's app shows. Paste it in that app under *Add a device or app*
  → *Paste request*, or ask it for an open invitation.
- **Join** — paste the response or open invitation and choose *Join*. A response made for
  another app's request is refused before anything stops. An invitation for the party the tab
  already runs is redeemed in place, nothing switched or rolled back. Otherwise its one
  node moves: the founded party's strands, pending joins and invitations are exported and
  kept as a move record in the tab's key store (`cadre-core/src/edge-node/strand-move.ts`; a
  `keystore.cadre/strand-move/…` `kv` key), the node stops and starts in the invitation's
  party (Home's status reads `joining`, and the "Add a device or app" and "Devices and nodes"
  cards forget what belongs to the party left), and the invitation is redeemed there, waiting
  for a member to answer. The card shows each step:
  joining (with *Cancel* while it waits), admitted, moving strands, removing the old cadre,
  then done with the standing and the moved count. A join refused, expired or cancelled puts
  the tab back in the party it left, unchanged, and says why.
- **The move needs an owner grant.** When the founded party holds anything to move, a join by
  invitation is refused up front (`StrandsNeedOwnerJoinError`): every row a move seats is
  owner-signed, and an invitation admits a member. The card says to join with an owner grant
  made in the owner tab under Owner keys; the join field takes one with
  `reference-app-web-owner-grants`. The tab's own chat strand has no control row, so a fresh
  tab's export is empty and an invitation is fine; the chat strand keeps working in the joined
  party as the same local strand.
- **After admission** the saved start names the joined party (`origin: 'joined'`, the
  founded party as `formerPartyId`), and the tab's owner slot's key is wired for signing only
  when the party lists it as an owner (`wireJoinedOwnerKey`; after an owner grant it is asked
  again every 2 s within the edge node's 60 s bound while the row arrives). Home's
  **Owner** row reads `enrolled` or `member`. A joined party never runs owner genesis, so a
  reload cannot seat the tab's key as a founding `OwnerKey` row of a cadre it merely joined.
- **Every start adopts** the move records naming its party, once the tab's key is wired as
  an owner there, before it reports `running`: a tab closed after admission finishes the
  move on its next load, and a member whose owner grant arrived late finishes it at the
  next start (*Restart node* on Home). A move the join left incomplete shows *Retry moving*,
  the edge node's `finishStrandMove`: it asks the party again whether the tab's key is an owner
  and adopts on the running node; a refusal (`StrandMoveNotOwnerError`) or a failure shows as
  the stalled step. Moved strands reach the party as rows, party keys and invitations, and
  cadre-core records them in the tab's key store; the tab does not open them (it has no
  `strand:discovered` handler).
- **The founded party stays in IndexedDB** under its own names (its control block database,
  its `<record>.<partyId>` records, its joined-strand records) until the tab removes it, which
  the card does on its own once the move has finished ([Removing the cadre the tab left](#removing-the-cadre-the-tab-left)).
- **Two same-origin tabs** share the node-local database and the saved start. A join in
  one tab switches the other only on its next load; until then the other keeps running the
  left party against that party's stores. Unsupported, on the same footing as the two-tab
  note in `lib/node-local-slots.ts`.

### Removing the cadre the tab left

Once a join's move has finished, the card goes on to remove the party the tab founded and
left (B), so the tab runs only as a member of the cadre it joined (A): "Removing this tab's
old cadre from this browser…", then done. It is the edge node's `dissolveFormerParty`
([Dissolving the party it left](../../docs/architecture.md#dissolving-the-party-it-left)),
called by the store's `dissolveFormerParty`:

1. **Refused before anything stops** unless the running start names a `formerPartyId` other
   than its own party, and while B's move record exists (`StrandMovePendingError`): the card
   shows the strands still waiting, with *Retry moving*.
2. A's holdings are read on the running node (`readStrandHoldings`).
3. The node stops and a node is started for B alone (no strand launched, no relay, no owner
   step, nothing saved) to export B's strands and list its machines.
4. **Refused, nothing deleted,** when B holds a strand or open pending join A does not, or a
   machine other than this tab (`FormerPartyNotEmptyError`). Other machines: "kept in this
   browser; nothing was lost". Only strands or joins: the card asks "Delete them with the old
   cadre?", and *Delete them* removes again with those ids discarded.
5. **Removed:** B's control block database (the platform's `destroyScope`: `deleteStore` in
   `lib/strand-storage.ts`, which closes this page's handle first), B's `<record>.<B>` records,
   its trusted-owner anchor, its joined-strand records and its move record; the saved start
   drops `formerPartyId`. Strand block databases stay: a moved strand's database is A's copy too.
6. The edge node starts A again, as after a load, whatever happened above, and the store
   attaches to it.

**A marker makes the removal resumable.** `kv` `dissolving-party` = `{ v: 1, partyId: B }` is
written before the first deletion and deleted after the saved start stops naming B. Every
start reads it first: a marker naming another party finishes the deletions without checking
again and drops that party as `formerPartyId`; one naming the party being started was not
written by a removal and is deleted with a warning. A tab closed partway finishes on its next
load. The same marked removal deletes the storage of a party an owner removed this tab from,
with no check, once its node has stopped and the start record no longer names it
([When this tab is removed](#when-this-tab-is-removed)).

**Another tab of this site still running B** keeps B's database open, and the browser fires
`blocked` on the delete and waits for that tab. `deleteStore` does not wait: the removal stops
with the marker kept (the next start reports it as the edge node's `unfinishedRemoval`), and the
card says "Close this site's other tabs to finish removing the old cadre". The browser deletes the database once that tab closes, and the next start (a
reload, or *Restart node* on Home) finishes the rest. A second delete of the same database
from this page while the first still waits is refused at once, since it would wait behind
the first.

**On load**, a running start that still names B shows "This tab's old cadre is still in this
browser" with *Remove it now* and *Later* (or the waiting strands, when a move is
unfinished); a removal a start could not finish shows what stopped it. Each is shown once per
start of the node, not on every visit to the page. An old cadre kept on purpose is shown
again after each reload.

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
  Cadre.svelte           # /cadre — cadre membership page, and the card after an owner removed this tab
  JoinCadre.svelte       # /cadre's "Join my existing cadre" card
  AddDevice.svelte       # /cadre's "Add a device or app" card
  Machines.svelte        # /cadre's "Devices and nodes" card
  OwnerKeys.svelte       # /cadre's "Owner keys" card
  OwnerKeyExportForm.svelte # the Owner keys card's backup and export form
  Messages.svelte        # /messages — chat strand send / list
  Activity.svelte        # /log — CadreNode lifecycle event log
  Diagnostics.svelte     # /diag — cadre + libp2p diagnostic surface
  main.ts                # mount + polyfill bootstrap
  polyfills.ts           # Buffer global + timer .ref/.unref shim
  main.css               # global styles
  lib/
    cadre-web.ts             # the tab's edge node, built once, and the tab's surface over it: diagnostics getters, chat strand, formation, cadre invitations, owner-key pass-throughs, debug hook
    web-edge-platform.ts     # the edge node's platform: key store, per-scope IndexedDB storage, transports, listen addresses
    web-join.ts              # this tab's join request, and the check of a pasted invitation
    node-local-slots.ts      # the key store and the node-local store, over the node-local database's kv store
    strand-storage.ts        # per-scope IndexedDB IRawStorage, opened on first use; deleting a scope
    chat-strand.ts           # chat sApp schema + signed SAppConfig + strand id
    store.svelte.ts          # Svelte 5 runes store: follows the edge node's status, attaches the page layer to each node, runs its actions; CadreNode event log
    network.svelte.ts        # strand-formation panel state (create / join invitation)
    add-device.svelte.ts     # "Add a device or app" state: request, approval, mint, list and withdraw open ones
    machines.svelte.ts       # "Devices and nodes" state: the cadre's machines, the devices invited, removing one
    owner-keys.svelte.ts     # "Owner keys" state: the cadre's owner keys, backup, export, import, removing one
    join-cadre.svelte.ts     # "Join my existing cadre" state: the request, the join and its steps
    join-flow.ts             # the join's steps, their words, and the words for each failure
    cadre-format.ts          # peer-id code, key fingerprint, expiry and error text shared by the Cadre page's cards
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
  surface reflects the genesis owner + zero formation rows. `owner-keys.spec.ts`
  makes a passphrase-locked backup key on the Cadre page, checks the export shown
  once and the downloaded file's text, and removes the key again.
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
  WebSocket listener) mints a machine invitation targeted at the tab's peer id; the tab
  pastes it under *Join my existing cadre*, and Home then shows that party and `member`.
  After a reload the same two values hold, the tab's key is absent from the party's
  `OwnerKey` rows (`__cadre.isOwner()` is false) and the start record says `joined`: the
  defect this pins is a joined party running owner genesis on every start. The card also
  removes the party the tab founded, which held nothing to move, so the start record names
  no `formerPartyId` and that party's control block database is gone. Same gate and
  self-skip as the formation tier.

Devices and nodes, and this tab's own removal, have no tier: removing a machine needs a second
owner machine, which neither fixture runs. Neither has importing an owner key, since a solo tab's
slot already holds the key it founded its cadre with, nor removing a key that added other rows.

Wiring this suite into CI is out of scope for the current ticket — it stops at
"runs cleanly locally."

## Out of scope (for follow-up)

- Real-time push (gossip / sync subscription wiring) — convergence is poll-based.
- A richer app-level RBAC notion beyond the schema-enforced `CadreControl` gates.
- Two same-origin tabs running one party. Nothing keeps a second tab from starting the party the
  first runs: they share the node-local database, the start record and the identity. When an
  owner removes that machine, the tab that acts first rewrites the start record and deletes the
  party's records under the other, and its delete of the control database waits for the other
  tab to close (`deleteStore`), with the marker kept.
