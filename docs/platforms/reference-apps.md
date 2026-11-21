# The reference apps

Three sample chat apps run a cadre node on a phone or in a browser: `packages/reference-app-rn` (React Native), `packages/reference-app-web` (browser) and `packages/reference-app-ns` (NativeScript). This document says what each one shows, which cadre-core or kit call each cadre-management screen makes, and where the apps differ. It is for an app developer deciding what to copy.

Related: [Running a node in a React Native app](react-native.md) · [in a browser](browser.md) · [in a NativeScript app](nativescript.md) · [Several apps in one cadre](../cadre/apps.md) · [Device testing](../contributing/device-testing.md)

## What each app demonstrates

All three start one node in the `device` class, join their party's control network, and run a chat strand whose tables they read and write with SQL. Each has a chat screen and a screen for the node and the cadre (Settings on the phone apps; Home and Cadre in the browser).

| App | Runtime | Node entry point | Storage | Shows |
|---|---|---|---|---|
| `reference-app-rn` | React Native on Hermes (Expo dev client) | `createPhoneNode` from `@serfab/cadre-rn/phone-node`, in `src/cadre-phone.ts` | LevelDB, with keys in the platform secure store | Every screen in this document |
| `reference-app-web` | Browser (Svelte, Vite) | `createEdgeNode` from `@serfab/cadre-core/edge-node`, in `src/lib/web-edge-platform.ts` | IndexedDB | The same cadre screens without a camera, a signed app schema, and a diagnostics page |
| `reference-app-ns` | NativeScript on V8, Android only | `createEdgeNode`, in `src/ns-edge-platform.ts` | SQLite | That the stack runs on a third engine: connect, join by invitation, create a strand, chat |

The React Native app is the one to copy for a phone app. Three of its choices are worth keeping:

- **One module owns the node.** `src/cadre-phone.ts` creates the kit's phone node once and exports functions over it. Screens never construct a `CadreNode`, so start, stop and join stay serialized by the kit.
- **One hook owns the app's view of the node.** `src/use-cadre.ts` follows the kit's status, attaches strands, and exposes the actions that the Settings sections (`src/*-section.tsx`) call.
- **Rules and wording live in plain modules.** `node-claim.ts`, `owner-keys.ts`, `machines.ts`, `rentals.ts`, `join-flow.ts`, `join-failure.ts` and `send-marks.ts` import neither React nor a native module, so the package's tests run them under Node.

The browser app keeps the same split with Svelte stores (`src/lib/*.svelte.ts`) over `src/lib/cadre-web.ts`; the NativeScript app uses two view models, `src/cadre-vm.ts` and `src/chat-vm.ts`.

### Founding and joining chat strands

In the React Native app, **Create Chat Strand** founds an open strand with `CadreNode.foundStrand` (`createChatStrand` in `src/chat-strand.ts`). `foundStrand` publishes the strand's row and starts the local instance in one resumable call, so an app killed between the two steps resumes on the next attempt with the same strand id ([Founding a strand](../strands/lifecycle.md#founding-a-strand)). Publishing is an owner-signed write: a device that is a member of its cadre but not an owner cannot found a strand.

A node that sees a strand row it does not run yet emits `strand:discovered`, and `use-cadre.ts` attaches it with `addStrand` (`joinChatStrand`). The event can fire before the hook subscribes, so the hook also reads `CadreNode.getDiscoveredStrands()` right after subscribing ([What a node does](../cadre/node.md#what-a-node-does)).

The chat screen shows one strand. `src/strand-selection.ts` picks it without depending on arrival order: the strand the user created or chose, otherwise the smallest id. Without that rule a strand that arrives from another machine while the user creates one can displace it.

The browser and NativeScript apps do not publish their chat strand. Each calls `CadreNode.addStrand` with `founder: true`, which starts the strand on that node and writes no `Strand` row, so the party's other machines never open it and the node does not start it again after a restart. The browser app adds one strand with a fixed id on every load. The NativeScript app creates a strand with a new id on each tap of **Create Chat Strand** and does not record the id, so after a restart the strand's data is on the phone and nothing opens it. Neither app handles `strand:discovered`.

**Create Closed Strand + Invite** (React Native) and the Home page's formation panel (browser) show the cross-party flow in [Inviting and joining](../strands/formation.md#formation-invitations). The host calls `createOpenInvitation`, then `foundStrand` with `type: 'c'`, a new member key and the invitation as `formationInvite`, and shows the text from `encodeInvitation`. The invitee pastes it; the app calls `decodeInvitation`, `formStrand`, then `addStrand` with the strand id and member key that `formStrand` returned.

The host must hold a relay reservation before it makes that invitation, because the invitee dials the host at the addresses the invitation carries, and a phone or a tab has no other address ([Which nodes can be reached through a relay](../network/relay.md#which-nodes-can-be-reached-through-a-relay)). Both apps ask the node at that moment whether it is reachable, and refuse before founding anything when it is not; a refusal after founding would leave a closed strand nobody can be invited to. Joining needs no relay.

## The chat schema

The apps run [`schemas/chat-simple.qsql`](../../schemas/chat-simple.qsql), which is the source of record and carries the reasoning for each column in its comments. It has two tables. `Participant` has a text `Id` (the phone apps use the node's peer id, the browser app the author's name), a `Name` of 1 to 100 characters and a `Role`. `Message` has a text `Id`, a `ParticipantId` with a foreign key to `Participant`, the `Content`, and a `Timestamp` the sender supplies.

The schema has no signature checks and no authorization constraints: any member of the strand can insert, update or delete any row. `schemas/chat.qsql` is a fuller design with per-participant keys and signed writes; no app loads it.

Each app embeds the schema as `CHAT_SCHEMA` in its `chat-strand.ts`, because a bundler cannot read the file at run time. The copies are hand-kept, and each package's `test/chat-schema-drift.spec.ts` fails when its copy stops matching the file. `composeStrand` in `@serfab/quereus-plugin-sereus` adds the `declare schema App { … }` wrapper, so the file and the constants are bare table lists.

Points an app developer should carry over:

- **`Message.Id` is a UUID the sending app generates,** tagged `"optimystic.fresh" = true` so that offline mode reports a queued message as certain to commit ([Writing an app schema](../schema-guide.md) covers client-generated keys).
- **`Timestamp` is the sender's clock,** so message order across members is only as good as their clocks. A schema cannot call the current time.
- **A resend reuses the key.** A strand write can fail without settling whether it was stored, so the composer generates the message id once per message and presents it again on a retry ([When the composer releases a message id](#when-the-composer-releases-a-message-id)).
- **`Participant.Role` is the app's own column.** cadre-core does not read it; the React Native app writes `owner` or `member` as a display value when a closed strand is created or joined.
- **Raise `CHAT_SCHEMA_VERSION` with every schema change.** It is the config's `schemaVersion`, and a strand refuses an app whose number is below the highest it has seen ([App schema versions across a strand's members](../strands/app-schema.md#app-schema-versions-across-a-strands-members)).
- **Sign the schema in a real app.** The phone apps pass an unsigned config whose `id` is a name, and set `requireSignedSchemas: false` to allow it. The browser app signs its config with `signSchema` under a demo author key bundled in the source. A production app ships its author's public key as the `id` and a signature made offline.

## Messages not yet delivered

A commit is stored on the sending node even when no other member of the strand is connected to take a copy, and is lost if that device is lost first. The chat marks such a message "Not yet delivered" ([A commit's durability](../strands/writes.md#a-commits-durability)).

`insertMessage` in `src/chat-operations.ts` inserts with `returning StampId() as Tx` to learn the commit's transaction id (`insertChatMessage` in `src/lib/chat-dml.ts` in the browser). The chat then reads `strand.database.commitDurability(tx)` in the same synchronous step that records the mark, and clears the mark when the node emits `strand:commit-held` for that transaction. Reading earlier can miss an event that arrived while the send was completing. The three apps do this in `src/use-chat.ts`, `src/lib/messages.svelte.ts` and `src/chat-vm.ts`.

The React Native and browser apps also offer [offline mode](../strands/writes.md#offline-mode). A switch (Settings → Node on the phone, on the Messages page in the browser) calls `setStrandOfflineMode` on the kit or the edge node, which changes every strand at once and saves the choice with the start options, so a restart or a push wake starts in the same mode. A message sent in offline mode moves through these marks, keyed by its transaction id (`send-marks.ts` in each app):

| Mark | Meaning | Source |
|---|---|---|
| Waiting to send | The offline queue holds it. "May not go through" is added when another writer could make it fail. | `strand:offline-status` `queued`; outlook `exposed` |
| Sending | The queue is submitting it. | `submitting`, `partially-committed` |
| Not yet delivered | Committed, and no other member holds it. | `committed`, then `commitDurability` |
| Not sent, with a reason | The members refused it. Its row leaves the local view, so the chat names it above the list until dismissed. | `failed` |

A waiting message that no send attempt can have delivered offers **Discard**, which calls `strand.database.offline.discard`. A line above the list reports the queue's state from `strand:queue-state`.

The marks follow `CadreNode` events, not listeners on `strand.database.offline`, because a hibernation rebuilds the strand's database object and the node's events continue across that.

Limits of the samples: a "Not yet delivered" mark is held in memory, so a message read from storage after a restart carries none; the NativeScript app has no offline mode (ticket `feat-strand-offline-mode-nativescript`); and no app has a leave-strand action, so none handles `StrandQueueNotEmptyError`.

### The queued-messages record

The offline queue reports a transaction only by id, and after a restart nothing in memory says which message an id stores. `QueuedMessageRecord` in `queued-messages.ts` (React Native and browser) keeps that link. It is the chat app's own node-local record, not the kit's: a JSON list of `{ strandId, transactionId, messageId, content }` under the key `chat-queued-messages`. It sits in the same node-local store as the saved start: the `sereus-node-local` LevelDB database on the phone (through `PhoneNode.nodeLocalRecords()`), the node-local `kv` store in the browser.

- **Added** when a send is queued, and **removed** when the queue reports the transaction committed or failed, or no longer knows it.
- **Read** each time a strand's database is published: on its `strand:queue-state`, and once for every strand already published when the chat attaches to the node. The chat asks the queue for each recorded transaction's status (`offline.status`) and rebuilds the marks, which covers a restart.
- **Not trusted.** A record that cannot be parsed is logged and read as empty. The messages are in the strand and the queued transactions in the strand's offline journal; the record only restores marks.

### When the composer releases a message id

Each composer keeps the id it generated for a message and presents the same id when the user sends unchanged text again, so the primary key refuses a second row ([Client-Generated Keys and Retrying a Write](../schema-guide.md#client-generated-keys-and-retrying-a-write) states the rule). On a resend the composer first reads whether the row exists and inserts only when it does not. The code is `ChatSender` in `src/chat-send.ts` on React Native, `sendMessage` in `src/lib/messages.svelte.ts` in the browser, and `ChatViewModel.send` in `src/chat-vm.ts` on NativeScript.

A failed send keeps the id. The composer releases it, so that the next send generates a new one, at the first of three events:

- **A send resolves,** because the row was stored or was found already stored.
- **The composer's text changes** (in the browser, the author or the text). Edited text is a different message: reusing the id would report the edit as sent while the stored row kept the earlier text. Text that is cleared and typed again also gets a new id.
- **A poll of the message list shows the id's row.** A send that reported failure did store the message, so the composer drops its error and clears the box if it still holds that text.

A poll does not release the id while a send is in flight. If that send then failed, the next press of Send would generate a second id and could store the message twice.

## Adding a device or app

**Add a device or app** is the owner's side of [handing an invitation from app to app](../cadre/apps.md#handing-an-invitation-from-app-to-app). It makes a [cadre invitation](../cadre/membership.md#cadre-invitations) that another app redeems to join this cadre as a machine. It never makes the other app an owner; that takes an owner grant ([Owner keys](#owner-keys)). Sources: `src/add-device-section.tsx` on React Native; `src/lib/add-device.svelte.ts` and `src/AddDevice.svelte` in the browser.

The section offers two ways to make the invitation, both valid for 24 hours and one use (the cadre-core defaults):

- **From the other app's join request.** The joining app shows a request (`sereus-join-request:1.…`) carrying its peer id and the name it gives itself. The owner pastes or scans it. The section decodes it with `decodeCadreJoinRequest`, refuses this app's own request and a peer that is already a machine of the cadre, and shows an approval prompt. The name is whatever the asking app wrote, so the prompt labels it unverified and shows a shortened peer id to compare with the other app's. Approval calls `createCadreInvitation({ peerId })`, so only that app can redeem the result.
- **An open invitation.** `createCadreInvitation({})` makes an invitation that whoever redeems first can use.

`createCadreInvitation` also returns the invitation's reach, and the section turns it into a warning. `local-network` means the new app must be on the same network as the cadre's other machines. `issuer-only` means it can join only while this app is open and reachable. With no address at all the call throws and the section reports it.

The invitation is shown once, as a QR code and as text. The app keeps no copy; the control database keeps the invitation's row. **Outstanding invitations** lists open invitations from `listCadreInvitations`, each with **Withdraw** (`withdrawCadreInvitation`). An invitation made for one peer is listed under [Devices and nodes](#devices-and-nodes) instead, as a device invited and not yet joined.

Only an owner sees the controls. The sections read the app's standing with `isOwnerDevice` (`src/owner-standing.ts`).

### Between apps on one phone

On React Native a second Sereus app on the same phone can send its request as a link, and receive the answer as a link, so the user copies nothing ([Between apps on one phone](../cadre/apps.md#between-apps-on-one-phone)). `app/+native-intent.tsx` rewrites an incoming link into a Settings route parameter with the kit's `parseCadreLink`, and Settings clears the parameter as soon as it is read, because a link can carry an invitation.

The owner app shows a prompt (Allow or Deny), then makes the invitation for that peer id and opens the asking app with it (`answerJoinRequest` in `src/join-link.ts`). It answers without a prompt when it can only refuse: `no-cadre`, `not-owner`, `already-member`. Two rules protect the user:

- **A denial starts a 30-second cooldown** during which every linked request is answered `denied` without a prompt. That bounds how often another app can raise the prompt, whatever peer ids it sends. Pasted requests are unaffected.
- **One request at a time.** A request that arrives while a prompt is open is ignored; one that arrives before the node is connected waits.

### Recommending another app

**Recommend an app** (React Native, `src/recommend-app-section.tsx`) lets the owner allow a named app in advance ([Recommending another app](../cadre/apps.md#recommending-another-app)). The list comes from the kit's `KNOWN_SEREUS_APPS` plus the build's `extra.sereusApps`. Approving saves a permission in the kit's `AppRecommendationStore`, valid for one hour, then opens the app or its store page.

When a linked request arrives whose reply scheme matches a saved permission, the owner app uses the permission up (`AppRecommendationStore.take`) and answers with an invitation without prompting. The deny cooldown and the already-member check run first. A pasted request never uses a permission.

## Devices and nodes

**Devices and nodes** lists the cadre's machines and lets an owner remove one ([Removing a machine](../cadre/removing-machines.md)). Sources: `src/machines-section.tsx`, `src/machine-removal.tsx` and `src/machines.ts`; `src/lib/machines.svelte.ts` and `src/Machines.svelte` in the browser.

Each row comes from `CadreNode.listMachines` and shows four things: whether the machine is always on, which is unknown until that machine has published its own record; when it was last seen, from its last self-signed record, which a running machine renews periodically; the first eight characters of its identity key, the fingerprint form cadre-host shows; and "Not trusted here" when the row no longer passes this node's own membership check, for example after the owner key that approved it was removed.

The list is read when the section appears, after each change made on the screen, and on **Refresh**. It is not polled.

Removal is two calls. `planMachineRemoval(peerId)` reads what the removal will do without writing, and the confirmation shows it: the invitations that will be withdrawn, and each closed strand in which the cadre's membership key will be replaced but which this device cannot finish, with the reason. `removeMachine(peerId)` then does it. The confirmation states two things that users otherwise assume wrongly:

- **Owner keys stay.** If the removed device was a lost phone that held an owner key, that key must be removed too, and the prompt links to Owner keys.
- **Removal does not erase.** The removed machine keeps whatever it had already copied.

A device does not remove itself; another owner device does it. A member sees the list without buttons.

Below the list, `listPendingPartyKeyRotations` supplies one line per closed strand whose key replacement has not finished, saying who can finish it: an owner device of this cadre, or the other party's manager, in which case the line shows the new public key for that manager to admit ([Replacing the party's key](../strands/keys.md#replacing-the-partys-key)). The block is read again on `strand:party-key-rotation-blocked` and `strand:party-key-rotated`.

### When this app is removed

When an owner removes this app while it runs, the kit or the edge node stops the node and deletes that cadre's local data. The app follows the `removed` status and shows which cadre it was removed from and by which owner key, with a way back to the cadre it founded earlier, if any, or to a join. An app removed while it was not running is not told, and keeps the data while the cadre's machines refuse it.

### Adding an always-on node

**Add an always-on node** (React Native, `src/add-node-section.tsx`) claims a node that a cadre-host machine started ([Claiming a node](../cadre/membership.md#claiming-a-node)). The user scans or pastes the node's code. `readNodeCode` in `src/node-claim.ts` decodes it with `decodeNodeClaimPayload`. An approval prompt names the cadre, the owner key that will sign, the node's peer id, and whether the node's addresses are public or home-network only. Approval calls `CadreNode.claimNode`.

- **The code holds the claim secret.** The app never logs the code or the decoded payload, and clears it from navigation state once read.
- **Failures are mapped by error type.** `describeClaimFailure` turns `PeerUnreachableError` and each `ClaimRefusedError` code into a sentence and says whether the same code can succeed again. Its table is typed by the error's own code type, so a code added to cadre-core fails type-checking until it has a sentence.
- **A retry keeps the code.** The host stops displaying a code soon after a claim reaches it, so after a retryable failure the section offers **Try again** with the code it holds.

On Android the app registers the `sereus-join` scheme, so the system camera can open a code in the app; the approval prompt still appears. On iOS it does not register the scheme: when two installed apps register one custom scheme, iOS does not define which opens, and a code could reach an app whose cadre the user did not intend.

The steps for trying this against a real cadre-host are in [Device testing](../contributing/device-testing.md#adding-a-home-machines-node).

## Owner keys

**Owner keys** lists the cadre's [owner keys](../cadre/owner-keys.md#what-an-owner-key-is) and holds every action on them. Sources: `src/owner-keys-section.tsx`, `src/owner-grant-views.tsx` and `src/owner-keys.ts`; `src/lib/owner-keys.svelte.ts`, `src/lib/owner-grants.ts` and `src/OwnerKeys.svelte` in the browser. The calls go through the kit's phone node or the edge node, not the `CadreNode`, because they must run in turn with start, stop and join, and because an import writes the device's owner key slot.

| Action | Who | Call | Notes |
|---|---|---|---|
| List | any device | `listOwnerKeys` | Marks the key this device signs with, and any key missing from this device's trusted-owner anchor |
| Add an owner key | owner | `createOwnerGrant({ label })` | A grant valid 15 minutes, one use, for another device or app |
| Make a backup | owner | `createOwnerGrant({ label, expiresInMs: null })` | A grant with no expiry, to keep offline |
| Outstanding grants | owner | `listOwnerGrants`, `withdrawOwnerGrant` | Backups listed first |
| Redeem an owner grant | any device | `redeemOwnerGrant(text)` | Seats this device's own key as an owner |
| Export this device's key | owner | `exportOwnerKey` | Optional passphrase, on by default |
| Import an owner key | any device | `importOwnerKey(text, passphrase?)` | Refused when the slot holds a different key |
| Remove | owner | `planOwnerKeyRemoval`, `removeOwner(key, { revouch })` | Not offered for the device's own key |

Mechanism: [Owner grants](../cadre/owner-keys.md#owner-grants), [Exporting and importing an owner key](../cadre/owner-keys.md#exporting-and-importing-an-owner-key), [Removing an owner key](../cadre/owner-keys.md#removing-an-owner-key).

What the screens add to those calls:

- **A grant or an export is shown once,** with a warning about what its holder can do. The app stores no copy. A grant's row stays in the control database and can be withdrawn; an export cannot be recalled.
- **Grant and export answer different needs.** A backup grant works only while one of the cadre's machines is reachable at an address the grant carries; an export works with no network. The backup screen shows the same reach warning as an invitation: a backup with reach `issuer-only` cannot replace this device if it is lost.
- **Redeeming reports three outcomes:** the device became an owner; it already was one, and the grant is unused; or another machine accepted the grant and the key's row has not replicated here yet.
- **Removal asks what to keep.** `planOwnerKeyRemoval` returns the grants the key made, which stop working with it, and the devices and owner keys it approved. The prompt shows a keep switch for each, and `removeOwner` re-approves the kept rows under this device's key first.

Known exposure: the React Native app does not hide a displayed grant or export from screenshots, screen recording or the app switcher (ticket `feat-rn-owner-key-export-hidden-from-screen-capture`). In the browser, clearing site data loses the owner key ([Running a node in a browser](browser.md#limits-and-accepted-tradeoffs)).

## Joining an existing cadre

**Join my existing cadre** is the joining side: an app that may already have founded a cadre of its own joins the one another Sereus app holds, brings its strands along, and removes the cadre it left ([An app joins an existing cadre](../cadre/apps.md#an-app-joins-an-existing-cadre)). Sources: `src/join-cadre-section.tsx`, `src/use-join-flow.ts`, `src/join-flow.ts` and `src/join-failure.ts`; `src/lib/join-cadre.svelte.ts`, `src/lib/web-join.ts` and `src/JoinCadre.svelte` in the browser.

**First launch.** When the React Native app finds no saved start, it asks whether the user already uses Sereus apps before it shows the Connect form. Answering yes shows the join section with no node running, so the app never founds a cadre it would then have to move out of. The browser app founds a cadre on first load and joins from there.

**The request.** The section shows this app's join request as a QR code and text, made with `encodeCadreJoinRequest` from the app's name and its peer id, which is readable with no node running (`identityPeerId`).

**One field takes three credentials.** The user pastes or scans the response to the request, an open invitation, or an owner grant; the prefix tells them apart. The app calls `joinCadre` on the kit or the edge node. An invitation makes the app a machine; an owner grant makes it a machine and an owner at once, under the device's own owner key. A response made for another app's request is refused before anything stops.

**The join runs as visible steps**, held in an app-wide hook so that they survive a tab switch:

1. **Joining.** The node stops and starts in the credential's party, then waits for a member to admit it. Only this step has **Cancel**; a refusal, an expiry or a cancel returns the app to the cadre it left, unchanged.
2. **Admitted**, as an owner or as a member.
3. **Moving** the app's strands into the joined cadre ([Moving the app's strands](../cadre/apps.md#moving-the-apps-strands)).
4. **Removing** the cadre the app left from this device, with `dissolveFormerParty` ([Dissolving the party it left](../cadre/apps.md#dissolving-the-party-it-left)).

What the apps do when a step cannot finish:

- **A machine invitation while the app's own cadre holds strands is refused before anything stops** (`StrandsNeedOwnerJoinError`). Every row a move writes is owner-signed, so the app asks for an owner grant instead.
- **A move that did not finish** shows the counts and **Retry moving** (`finishStrandMove`). Every start retries by itself, and the old cadre is not removed while strands wait.
- **An old cadre that holds something the joined one lacks** (`FormerPartyNotEmptyError`) is not removed. The app asks whether to delete those items with it, or keeps it when it has other machines.
- **After a relaunch** the saved start still names the old cadre, and the app shows the step it stopped at.

On React Native, **Choose the app that holds your cadre** sends the request to an owner app on the same phone as a link and takes the answer as a link ([Between apps on one phone](../cadre/apps.md#between-apps-on-one-phone)). The app saves the open request first (the kit's `LinkRequestStore`), so the answer is still accepted if the OS killed the app meanwhile. When another app recommended this one, the first-launch question names that app, but only if this build lists it, because anyone can construct the hint.

## Renting a provider node

**Rent an always-on node** (React Native only, `src/provider-store-section.tsx`) rents a container from a hosting provider and adds its node to the cadre ([Renting a node from an app](../hosting/provider.md#renting-a-node-from-an-app)). A build names one provider with `EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL`; without it the section is absent. Where a list of providers would come from is undecided (ticket `decide-provider-directory`).

The section does four things:

- **Reads the provider.** It fetches the descriptor, parses it with cadre-core's `parseProviderDescriptor`, and lists the plans from the descriptor's `plansUrl`.
- **Signs in.** `signInWithProvider` from `@serfab/cadre-rn/provider` opens the provider's authorize page in the system browser with PKCE and exchanges the code. The redirect URI is `<app scheme>://provider-auth`, which the provider compares with the registered URI by exact string. Tokens go in the secure store, and `app/+native-intent.tsx` drops the redirect's query so the single-use code never sits in navigation state.
- **Rents after an approval.** The prompt names the cadre, the signing owner key and the provider. Then `use-cadre.ts` calls cadre-core's `rentNode` and records the rental in the kit's `rentalStore` as soon as the provider creates the container, so a rental interrupted by an app kill is found at the next launch.
- **Shows each rental.** While Settings is in front, `src/use-rental-poll.ts` re-reads each container and the billing status every five seconds.

`rentNode` decides whether the phone claims the new node or the container redeems an invitation at another member; the provider document gives the rule.

`src/rentals.ts` decides what each rental row offers from its state: **Finish adding** (`finishRental`) for a claim the phone did not complete; **Try again** or **Cancel** for an invitation join that failed; **Remove from cadre** and **Forget** for a node the provider stopped. A running, joined node offers nothing, because a subscription ends on the provider's own site. Only an owner can rent.

## Differences between the apps

| | React Native | Browser | NativeScript |
|---|---|---|---|
| First run | Asks whether to join an existing cadre before founding one | Founds a cadre on first load | Connect form; founds on Connect |
| Join an existing cadre | Paste, scan, or link from another app; invitation or owner grant | Paste; invitation or owner grant | Paste a machine invitation, while connected (ticket `feat-reference-app-ns-owner-grant-join`) |
| Add a device or app, Devices and nodes, Owner keys | Yes | Yes, paste only; Download in place of Share | No |
| Recommend an app; links between apps | Yes | No | No |
| Add an always-on node by claim | Yes | No | No |
| Rent a provider node | Yes | No | No |
| Closed strand by invitation | Yes | Yes | No |
| Offline mode and send marks | Yes | Yes | "Not yet delivered" only |
| App schema | Unsigned, `requireSignedSchemas: false` | Signed with a bundled demo key | Unsigned, `requireSignedSchemas: false` |
| Chat strands | Any number; one shown, with a picker | One fixed strand id, `sereus-web-chat`; strands moved by a join are recorded but not opened | Any number until a restart; the first one listed is shown |
| A strand the app creates | Published with `foundStrand` | The chat strand is not published; a closed strand made for an invitation is | Not published, and not reopened after a restart |
| A strand another machine publishes | Attached on `strand:discovered` | Not opened | Not opened |
| Identity and owner key | Platform secure store | Origin's IndexedDB | The app's SQLite database, unencrypted |
| Relay addresses | Settings field, default `EXPO_PUBLIC_RELAY_ADDR` | `VITE_RELAY_ADDR`, else `localStorage["relay-addr"]` | Settings field |
| Chat list refresh | Poll every 2 seconds | Poll every 4 seconds while the tab is visible | Poll every 2 seconds |
| Push wake | Yes | No | No |
| Diagnostics page | No | Yes, with a check that an unauthorized control write is rejected | No |

No app subscribes to change notifications (ticket `feat-reference-apps-watch-strand-changes`).
