# cadre-core API guide

This guide is for app developers. For each call an app makes on `@serfab/cadre-core` it says which object owns the call, what the caller can rely on and which document explains the mechanism. Signatures and types are in [`cadre-node.ts`](../packages/cadre-core/src/cadre-node.ts), [`types.ts`](../packages/cadre-core/src/types.ts) and [`edge-node/edge-node.ts`](../packages/cadre-core/src/edge-node/edge-node.ts).

See also: [getting started](getting-started.md) for a first working app · [concepts](concepts.md) for the terms · [the cadre node](cadre/node.md) for configuration · [writing an app schema](schema-guide.md)

## Entry points

An app imports from `@serfab/cadre-core` and, on a phone or in a browser, from `@serfab/cadre-core/edge-node`. Neither imports a `node:` built-in, so both bundle for a browser or a phone. The other subpaths are for Node.js only: the file-backed stores for [node-local state](cadre/node.md#node-local-state), the push senders and the default transport list. The [package README](../packages/cadre-core/README.md#entry-points) lists them.

## Creating a node

An app on a phone or in a browser creates an edge node, which builds and runs a `CadreNode` for it. Any other program constructs `CadreNode` directly. Calls in the later sections are methods of the started `CadreNode` unless the text names another owner; "(function)" marks a function exported from `@serfab/cadre-core`.

### `CadreNode`

`new CadreNode(config)` builds a node and opens nothing. [Configuration](cadre/node.md#configuration) describes the options.

- `start()`: Resolves when the control database is open, the formation responder is installed and the strand watcher is running. It does not wait for another machine to connect.
- `stop()`: Stops every strand and the control node. sApp configs are held in memory only, so the next `start()` offers each stored strand again as `strand:discovered`.
- `on(event, handler)`, `off(event, handler)`: Subscribe and unsubscribe ([Events](#events)). A handler can be attached before `start()`.
- `peerId`, `partyId`, `getMultiaddrs()`: This node's identity, party and current addresses. Before `start()`, `peerId` is undefined and the address list is empty.
- `isRunning` (alias `running`), `controlConnected`: Synchronous state, for code that cannot subscribe.
- `getControlDatabase()`: The `ControlDatabase`. Null before `start()`.

### The edge node

`createEdgeNode(platform)` from `@serfab/cadre-core/edge-node` returns an `EdgeNode`. Create one per app: the call throws while another edge node over the same `platform.storage.id` is starting, joining or running. [The edge node](cadre/node.md#the-edge-node) says what the platform object supplies and what a start does.

- `start(options)`: Starts the app's node for `options.partyId`, or joins a start in progress, and returns the `CadreNode`. It saves the options for unattended starts.
- `stop()`, `restart(options)`: `stop` also closes every store and marks the saved start so that nothing restarts the node unattended. `restart` rebuilds the node with new options.
- `status`, `onStatus(listener)`, `node`: `status.state` is `stopped`, `starting`, `joining`, `running`, `removed` or `failed`. `node` is the running `CadreNode` or null.
- `on(event, handler)`: Applies the handler to every node a start builds, before it starts, and returns an unsubscribe function. Register the `strand:discovered` handler here, before `start`.
- `loadSavedStart()`, `identityPeerId()`: The saved options of the last start; the app's peer id, the same in every party. Both work with no node running.
- `joinCadre(credential, options?)`: Moves the app's node into the cadre a cadre invitation or owner grant names, keeping its peer id. A failed join restarts what was running before and throws. See [An app joins an existing cadre](cadre/apps.md#an-app-joins-an-existing-cadre).
- `pendingStrandMove()`, `finishStrandMove()`, `dissolveFormerParty(options?)`: After leaving a party the app founded: adopt its strands in the joined party, then delete its local data. See [Moving the app's strands](cadre/apps.md#moving-the-apps-strands) and [Dissolving the party it left](cadre/apps.md#dissolving-the-party-it-left).
- `setStrandOfflineMode(mode)`: Puts every strand, running and later, in the mode and saves it for the next start. Throws a plain `Error` while no node runs and on a platform with no offline journal.
- `listOwnerKeys()`, `exportOwnerKey()`, `importOwnerKey()`, `planOwnerKeyRemoval()`, `removeOwner()`, `createOwnerGrant()`, `redeemOwnerGrant(text)`: The [owner-key](#owner-keys) calls over the key store's owner slot. Export and import work with no node running.

The same entry exports `attachStrandWhenWritable(node, config, options?)`, which calls `addStrand` and, when the first sync outlasts its timeout, keeps waiting up to `patienceMs` (default 240 seconds) instead of failing.

## The cadre

### Owner keys

Every change to the control database is signed by an owner key through the node's `OwnerSigner`. An "owner call" in this guide throws unless a signer is wired with `useOwnerSigner` and its key is a live owner key. See [The owner signer](cadre/owner-keys.md#the-owner-signer).

- `createOwnerKey(keyStore)`, `loadOwnerSigner(keyStore)`, `softwareOwnerSigner(privateKey)` (functions): Create an owner key in the key store's owner slot, load the one there (undefined for an empty slot), or wrap a key held in memory. Each returns an `OwnerSigner` that never prompts.
- `ControlDatabase.ensureOwnerKey(publicKey, label?)`: The founding write of a new cadre: seats the key as the first owner when the party has none. Safe to repeat on every start.
- `useOwnerSigner(signer)`: Signs every later owner write through `signer` and records its key as trusted on this machine. One signer per node. `initializeSeedBootstrap(privateKey)` is the same call with a software signer.
- `isOwner()`: True when a signer is wired and its key is a live owner key.
- `wireOwnKeyIfOwner(signer?)`: Wires `signer` only when its key is already a live owner; it never inserts a row. A machine that joined a cadre calls it on every start.
- `listOwnerKeys()`, `addOwner(publicKey, { label })`: List the live owner keys; seat another (owner call), where `false` means it was already an owner.
- `planOwnerKeyRemoval(key)`, `removeOwner(key, options?)`: The plan reads without writing. The removal (owner call) re-vouches the rows named in `options.revouch`, then removes the key, under one approval. See [Removing an owner key](cadre/owner-keys.md#removing-an-owner-key).
- `createOwnerGrant(options?)`, `listOwnerGrants()`, `withdrawOwnerGrant(key)`: Owner calls, except the list. A grant lets its holder seat an owner key through any member machine. Fifteen minutes and one use by default; `expiresInMs: null` mints a backup grant with no expiry. See [Owner grants](cadre/owner-keys.md#owner-grants).
- `redeemOwnerGrant(bundle, signer, options?)`: Seats `signer`'s key as an owner of this node's party. It does not wire the signer; call `wireOwnKeyIfOwner(signer)` afterwards.
- `joinWithOwnerGrant(bundle, signer, options?)`: For a node started in the grant's party that is not yet a member: makes it a machine and its key an owner under one approval.
- `encodeOwnerGrant(bundle)`, `decodeOwnerGrant(text)` (functions): Convert a grant bundle to and from its `sereus-owner-grant:1.` text.
- `exportOwnerKey(keyStore, options?)`, `importOwnerKeyInto(keyStore, node, text, passphrase?)` (functions): Export the owner slot's key as text, optionally locked with a passphrase, and import such text. See [Exporting and importing an owner key](cadre/owner-keys.md#exporting-and-importing-an-owner-key).

### Adding a machine

There are four ways to add a machine, and [Which side dials](cadre/membership.md#which-side-dials) says which fits a given pair of machines. The owner's side of each is an owner call.

**By cadre invitation.** The new machine redeems a credential at any member machine, so the owner's machine can be offline. See [Cadre invitations](cadre/membership.md#cadre-invitations).

- `createCadreInvitation(options?)`: Mints an invitation that admits a machine and grants nothing else. Twenty-four hours and one use by default; `peerId` restricts it to one device. Returns the bundle (`invitation`), its `sereus-invite:1.` text (`encoded`) and its `reach`.
- `invitationReach()`: Where a device could redeem an invitation minted now once this machine is gone: `anywhere`, `local-network` or `issuer-only`. Mints nothing.
- `listCadreInvitations()`, `withdrawCadreInvitation(key)`: List invitations with their standing; withdraw one. Machines it already admitted stay members.
- `redeemCadreInvitation(invitation, options?)`: On the new machine, which needs a stable identity (`keyStore` or `privateKey`). One pass over the listed members by default; `waitForMember` keeps trying while every answer is retryable. Repeating it on an admitted machine succeeds. `decodeCadreInvitation(text)` (function) gives the bundle.

**By claim.** A node started with a `claim` block in its config belongs to nobody and waits, and its host shows a claim payload, usually as a QR code. On the owner's machine, `claimNode({ peerId, multiaddrs, secret })` takes the waiting node into this cadre; `decodeNodeClaimPayload(text)` (function) produces its argument from the payload. A refused or undelivered claim writes nothing, and the same owner may repeat a claim. On the waiting node, `isAwaitingClaim()` is true until an owner claims it. See [Claiming a node](cadre/membership.md#claiming-a-node).

**By seed.** The owner vouches for a peer id it already knows and hands the machine a signed seed. `addDrone({ dronePeerId, droneMultiaddrs })` does the owner's side and returns `seed` and `encodedSeed`; `authorizePeer` and `createSeed` are its two steps. The new machine passes the text to `decodeSeed` and `applySeed`, or the owner sends the seed with `deliverSeed`. A machine that is neither an owner nor started with `claim` accepts a delivered seed only after `enableSeedListener()`, and only under its [seed trust policy](cadre/control-security.md#seed-trust-policies). See [The seed](cadre/membership.md#the-seed) and [Seed delivery protocol](cadre/membership.md#seed-delivery-protocol).

**From a hosting provider.** `rentNode(node, client, options?)` (function) creates a container at the provider and adds it to this cadre, by invitation when `invitationReach()` is `anywhere` and by claim otherwise. `finishRental(node, client, containerId, options?)` (function) resumes an interrupted rental. See [Renting a node from an app](hosting/provider.md#renting-a-node-from-an-app).

### Listing and removing machines

- `listMachines()`: One entry per machine: its peer id, whether this node trusts it, its profile and when it last published its address.
- `planMachineRemoval(peerId)`: What `removeMachine` would do, read without writing: whether this node may remove the machine, which invitations it could return through, and which closed strands need a new party key.
- `removeMachine(peerId)`: Owner call. Removes the machine, its push token and every invitation it could redeem, in one transaction, then replaces the party's key in each closed strand running here.
- `listPendingPartyKeyRotations()`: The closed strands where a key replacement started by a removal has not finished.
- `removedFromCadre()`: On the removed machine: the removal it learned of, or null. The query form of `cadre:removed`.

A removed machine keeps the data it already holds, and removing the owner key it held is a separate step (`removeOwner`). See [Removing a machine](cadre/removing-machines.md) and, for the strand side, [Replacing the party's key](strands/keys.md#replacing-the-partys-key).

### Connectivity

The node connects to the party's other machines itself ([Cohort auto-connect](cadre/control-convergence.md#cohort-auto-connect)).

- `hasReachableControlSibling()`: Whether a control write made now would reach another machine. With none, the write commits here and is sent again when a machine becomes reachable ([Writes made while alone](cadre/control-convergence.md#writes-made-while-alone)).
- `reserveRelays(addrs, opts?)`, `getRelayReservationState()`: For a node that learns its relay at run time: request a reservation, which the node renews whenever it is lost, and read its state. `reserveRelays` never throws. See [Reservations are requested explicitly](network/relay.md#reservations-are-requested-explicitly).

## Strands

### Founding

- `foundStrand(config)`: Owner call. Publishes the strand's row to the party and starts the strand here as its founder. Safe to repeat after an interruption. Returns the running `instance`, the `strandRow` and `founded`.
- `foundStrand(config, { background: true })`: Resolves once the row is published; `ready` settles when the local start does.
- `generateStrandMemberKey()` (function): Mints the read secret a closed strand is founded with (`config.memberPrivateKey`).
- `signSchema(fields, authorPrivateKey)` (function): The sApp author's signature over `schema`, `version` and `schemaVersion`, for `SAppConfig.signature`.

In `config.sAppConfig`, `id` is the sApp author's public key, `schema` is the body of the app schema ([Writing an app schema](schema-guide.md)), and `signature` is required unless the node sets `requireSignedSchemas: false`. A strand id is 1 to 128 characters from lowercase letters, digits, `.`, `_` and `-`, and must not begin with `control-`, because it becomes a file or database name.

For a closed strand, take the read secret from the returned `strandRow.MemberPrivateKey`, not from the value passed in: a row that was already published keeps its stored key. `founded: false` means another machine of the party published the row first and this machine attached as a joiner. See [Founding a strand](strands/lifecycle.md#founding-a-strand).

`publishStrand` and `addStrand` are the two halves of `foundStrand`. An app stopped between them leaves a strand published and never started, so call `foundStrand`.

### Inviting another party

A formation invitation has two parts: the `OpenInvitation` the app hands to the other party, and a `FormationInvite` row in the control database that makes its token redeemable. See [Formation invitations](strands/formation.md#formation-invitations).

- `createOpenInvitation(sAppId, expirationMs?)`: Mints the `OpenInvitation` (24 hours by default), naming this machine and some of the party's others. Throws when none has an address. It writes no row, so the token is not redeemable until one of the next two calls publishes it.
- `foundStrand({ …, formationInvite })`: Owner call. Publishes the invitation's row bound to the strand, in the same transaction and approval as the strand row.
- `publishFormationInvite(token, sAppId, options?)`: Owner call. Publishes the row on its own. `options` sets `expiresAtMs`, `totalUses`, `validationUrl` and the `strandId` it is bound to.
- `encodeInvitation(invitation)`, `decodeInvitation(text)`: Convert an `OpenInvitation` to and from text for a QR code or a link.
- `initializeStrandSolicitation(options?)`: Optional. Replaces the formation responder that `start()` installed, to add a disclosure validator, an approver or deadlines.

Every machine of the inviting party answers redemptions without the app calling anything ([Who answers formation](strands/formation.md#who-answers-formation)). A machine that is not running the closed strand an invitation is bound to answers `host-strand-unavailable`, which is retryable and leaves the invitation unspent.

### Joining

- `formStrand(invitation, disclosure?)`: One attempt from this machine. On success the node remembers the join, so the strand is offered through `strand:discovered` on every later start. Throws one of the formation errors in [Errors](#errors).
- `requestJoin(invitation, disclosure?)`: Owner call. Records the request for the whole party, tries once, and returns a `PendingJoinStatus` whose `state` is `joined`, `waiting` or `failed`. Every owner machine then retries, across restarts, until the join succeeds, the invitation is spent or expires, or the request is dismissed.
- `listPendingJoins()`, `dismissPendingJoin(id)`: Every request not dismissed, as this machine sees it; remove one for the whole party (owner call), which cancels it if pending.

Do not call both `formStrand` and `requestJoin` with one invitation: nothing coordinates them and one receives `token-spent`. See [Joining while the inviter is offline](strands/formation.md#joining-while-the-inviter-is-offline) and [What a joiner's node remembers](strands/keys.md#what-a-joiners-node-remembers).

After `formStrand` returns, the app starts the strand with `addStrand`, building the row from the result. A row for a joined strand has null founder columns:

```ts
const result = await node.formStrand(invitation, { purpose: 'chat' });
await node.addStrand({
	strandRow: {
		Id: result.strandId,
		Type: result.memberPrivateKey ? 'c' : 'o',
		MemberPrivateKey: result.memberPrivateKey ?? null,
		FounderOwnerKey: null,
		FounderPeerId: null,
	},
	sAppConfig,
});
```

`FormStrandResult.strandAddrs` is often empty, which is not an error. A join made by `requestJoin` is offered through `strand:discovered`.

### Starting a joined or discovered strand

A node starts a strand only when the app has given it an sApp config for that strand. The others are offered to the app, which claims them with `addStrand`.

- `strand:discovered` event: Fires once per strand per session, for each strand of the party, or joined from another party, that no sApp config claims. Carries the `StrandRow` to pass to `addStrand`.
- `getDiscoveredStrands()`: The strands offered and not yet claimed. An entry leaves when the strand is claimed or its row is removed.
- `addStrand({ strandRow, sAppConfig })`: Starts the strand here and resolves with a writable instance. On a joining machine it waits for the first sync and rejects with the retryable `StrandAwaitingFirstSyncError` if that outlasts `strandFirstSync.timeoutMs`; the strand stays up and keeps syncing.
- `whenStrandWritable(strandId, { timeoutMs })`: Resolves when a started strand becomes writable. The promise form of `strand:writable`. It does not wake a hibernating strand.

`strand:discovered` can fire inside `start()`, before the app's handler is attached. An app that claims discovered strands subscribes first and then reads `getDiscoveredStrands()`. A strand discovered between the two steps reaches the handler twice, so the handler tracks the strand ids it is claiming; `getStrands()` lists a strand only after `addStrand` resolves.

A rejected `addStrand` leaves the sApp config registered and the node retries the start itself. The app then sees `strand:error` for each failed retry and `strand:started` on success, not a second `strand:discovered`. A start refused with `AppSchemaRefusedError` is [not retried](strands/app-schema.md#a-schema-that-can-never-apply-here-is-not-retried) until the next `addStrand`. [Joining: no writes before the first sync](strands/formation.md#joining-no-writes-before-the-first-sync) explains why a joining machine waits.

### Stopping and leaving

| Call | Scope | What the caller can rely on |
| --- | --- | --- |
| `stopStrand(strandId)` | This machine, this session | Stops the strand and forgets its sApp config. It is not offered again until the node restarts; `addStrand` reverses the stop. |
| `unpublishStrand(strandId, options?)` | The party, for a strand it founded | Owner call. Removes the party's `Strand` row, so every machine of the party stops the strand. For a closed strand this destroys the party's read secret and membership key, which are stored nowhere else. Local data is not erased. |
| `forgetJoinedStrand(strandId, options?)` | The party, for a strand it joined | Removes the party-wide record of the join and stops the strand here; the other machines detach it. Where a party-wide record exists it is an owner call, and it throws when that record cannot be read. |

None of the three tells the strand's other members anything, and the party's membership row in a closed strand stays; to remove it, call the `leaveStrand` writer first ([Membership of closed strands](#membership-of-closed-strands)).

`unpublishStrand` and `forgetJoinedStrand` throw `StrandQueueNotEmptyError` while the strand's offline queue on this machine holds transactions. `{ discardQueued: true }` withdraws the transactions that were never sent and proceeds.

### The strand's database

`getStrands()` and `getStrand(strandId)` return `StrandInstance` objects. `instance.status` is one of `starting`, `syncing`, `active`, `idle`, `hibernating`, `stopping`, `stopped` or `error`. `instance.database` is set only while the strand is running and writable here, so check it before use; it is unset while syncing and while hibernating.

`instance.database.getDatabase()` returns the Quereus `Database`. App tables are in the `App` schema:

```ts
const db = node.getStrand(strandId)!.database!.getDatabase();
await db.exec('insert into App.Message (Id, Content) values (?, ?)', [id, text]);
for await (const row of db.eval('select Id, Content from App.Message')) {
	show(row);
}
```

| Call | Owner object | What the caller can rely on |
| --- | --- | --- |
| `commitDurability(transactionId)` | `StrandDatabase` | Whether another member already holds a commit, by the `StampId()` its statement returned. See [A commit's durability](strands/writes.md#a-commits-durability). |
| `offline` | `StrandDatabase` | The offline queue: its entries, their statuses, and `whenDrained()`. Undefined on a node without `strandOffline`. |
| `setStrandOfflineMode(strandId, mode)`, `getStrandOfflineMode(strandId)` | `CadreNode` | In `'offline'` mode a commit resolves once the transaction is saved on this machine. The mode lasts until the process exits. `getUnreachedStrandMachines(strandId)` names the party's machines a queued transaction may be waiting for. See [Offline mode](strands/writes.md#offline-mode). |
| `appSchemaState()` | `StrandDatabase` | `applied`, `waiting-for-queue`, `waiting-for-cohort` or `failed`. See [An app schema upgrade waits for the queue or the cohort](strands/app-schema.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort). |
| `watchTables(tables, onChange, options)` | `StrandDatabase` | Calls back when a named table changes, by a local commit or by replication. See [Change notifications](strands/app-schema.md#change-notifications). |

### Hibernation and wake

Hibernating a strand releases its network node and database until something wakes it. A node hibernates strands on idle timers only when its configuration sets `hibernation.enabled`. An edge node never sets it, so an app on a phone or in a browser hibernates and wakes strands itself. See [When hibernation applies](strands/hibernation.md#when-hibernation-applies), [States](strands/hibernation.md#states) and [Wake paths](strands/hibernation.md#wake-paths).

- `recordStrandActivity(strandId)`: With the timers on, restarts the strand's idle timer and wakes the strand if it is idle or hibernating. With the timers off it does neither. Either way it also calls `notifyStrandActivity`.
- `hibernateStrand(strandId)`, `hibernateAll()`, `wakeStrand(strandId)`: Hibernate at once, for an app going to the background, and wake. They work with the timers on or off. Strands with the `realtime` latency hint are not hibernated.
- `serviceWake(strandId, { windowMs })`: For a push received on a phone: wakes the strand for the window and hibernates it again if nothing happened. Never throws.
- `registerDeviceToken(platform, token)`, `clearDeviceToken()`: Publish or delete this device's push token. The first publish and the delete need an owner signer.
- `notifyStrandActivity(strandId, reason?)`, `pushWake(peerId, strandId, reason?)`: On an always-on machine: wake the party's hibernating phones for a strand, or one machine directly. See [Push wake](strands/hibernation.md#push-wake).

## Membership of closed strands

A closed strand keeps its members, managers and invitations in tables inside the strand's own database. The node writes the ordinary rows itself: `foundStrand` seats the founder as member and manager, and after a join the node seats the party and binds each of its machines. An app calls the functions in this section only for manager actions and for leaving.

Each is a function that takes the strand's Quereus database and a parameter object holding the signing key pair, and performs one transaction. The key pair is the party's membership key for that strand, which is not the strand's read secret. [Calling the membership writers](strands/membership.md#calling-the-membership-writers) shows a call and states what a caller can rely on.

| Function | Signed by | What it does |
| --- | --- | --- |
| `issueInvite`, `cancelInvite`, `listOutstandingInvites` | A manager | Create a single-use membership invitation, cancel an unused one, list those still redeemable. |
| `consumeInvite`, `registerMemberPeer` | The invitation's key; the member | Seat a member, and bind a machine to it. The node does both for a join. |
| `addMemberByManager`, `revokeMember` | A manager | Seat a member without an invitation, which is how a removed party is admitted again; remove a member. |
| `leaveStrand` | The member | Removes the caller's own membership. |
| `addManager`, `admitManager`, `removeManager`, `sealStrand` | A manager | Change who administers the strand. `sealStrand`, by the last manager, permanently stops admission. |
| `isStrandMember`, `isStrandManager`, `isStrandSealed`, `listMemberPeers` | | Read from the rows this node holds. |

See [Who may administer a closed strand](strands/membership.md#who-may-administer-a-closed-strand), [Removing members](strands/membership.md#removing-members) and, for the two keys, [Closed-strand member key handling](strands/keys.md#closed-strand-member-key-handling).

### `EnrollmentService` and member registration

`EnrollmentService` wraps the same admission in a request-and-result form, for an app that receives a registration from another party and decides whether to seat it. Its methods `registerMember(registration, signature)` and `validateMemberRegistration(registration, signature)` check the signature, that the member may join and that it is not already a member; `registerMember` then writes the row. A `MemberRegistration` is `{ strandId, key, peerIds }`. A refusal is returned as `success: false` with a `reason`, not thrown.

The instance `CadreNode.getEnrollmentService()` returns has no verifier and no registry, so its `registerMember` always answers `MemberVerifier not configured`; it is useful only for `createCadrePeer()`, which generates a node identity key pair. To register members, construct a service over the strand's database:

```ts
import { EnrollmentService, StrandMemberRegistry, StrandMemberVerifier } from '@serfab/cadre-core';

const enrollment = new EnrollmentService({
	memberVerifier: new StrandMemberVerifier(db),
	memberRegistry: new StrandMemberRegistry(db, { mode: 'manager', managerKeyPair }),
});
const result = await enrollment.registerMember(registration, signature);
```

`signature` is the member's signature over `memberRegistrationPayload(registration)`, made with `signStrandPayload`. `StrandMemberRegistry` admits by manager signature, as shown, or by redeeming an invitation (`{ mode: 'invite', inviteKey, invitePrivateKey }`). It does not write the `peerIds`: each machine binding needs the member's own signature, so the member calls `registerMemberPeer`. The node's own joins do not use this service ([The invite-to-join handshake](strands/membership.md#the-invite-to-join-handshake)).

## Formation approval hook

A formation invitation may carry a `validationUrl`: an HTTP endpoint run by an approver outside the party, which the inviting party's node asks whether one particular redemption may proceed. An owner enrolls the approver's public key with `enrollValidationKey(key)` before handing out such invitations; `removeValidationKey(key)` and `listValidationKeys()` complete the set. [Formation approval hook](formation-approval-hook.md) specifies the request, the response, how the node classifies each answer, and the limits, with an example hook in TypeScript.

## Events

`node.on(event, handler)` subscribes to the events of `CadreNodeEvents` in [`types.ts`](../packages/cadre-core/src/types.ts), which declares each payload. Every `strand:` payload carries `strandId`. Handlers for the two commit events run synchronously inside the commit, so keep them short.

### Strand lifecycle

| Event | Fires when |
| --- | --- |
| `strand:discovered` | The party holds a strand, or the node remembers a join, that no sApp config claims. Once per strand per session. |
| `strand:started` | A strand started on this machine. Its status is `active`, or `syncing` on a machine still waiting for its first sync. |
| `strand:writable` | A strand that started in `syncing` finished its first sync and its `database` is set. |
| `strand:stopped` | A strand stopped on this machine. |
| `strand:error` | A strand failed to start, on every failed attempt; a deferred app schema apply failed; or a running strand was stopped because another member recorded a newer app schema version ([A running member stops](strands/app-schema.md#a-running-member-stops)). |
| `strand:idle` | A strand saw no activity for its idle period. Only with the hibernation timers on. |
| `strand:hibernating` | A strand was hibernated. |
| `strand:waking` | A hibernating strand was woken. |

### Strand writes and schema

| Event | Fires when |
| --- | --- |
| `strand:commit-durability` | A commit on a strand's database wrote something. The node's own membership writes are included. |
| `strand:commit-held` | A commit reported as `followed` is now held by every machine assigned the blocks it wrote. |
| `strand:offline-status` | A transaction in the offline queue changed status. |
| `strand:queue-state` | A strand's offline queue or mode changed, and each time its database is published. |
| `strand:app-schema-deferred` | A strand's database was published while its app schema apply waits for the queue or the cohort. |
| `strand:app-schema-applied` | A deferred app schema apply completed. |

### Closed-strand membership

| Event | Fires when |
| --- | --- |
| `strand:revoked` | This node learned that its party is no longer a member of a closed strand. Not guaranteed to arrive. Nothing is stopped. |
| `strand:rejoin-blocked` | The node holds a membership invitation it cannot redeem, usually because its party was removed. A manager admits the party with `addMemberByManager`. |
| `strand:party-key-rotated` | On the machine that replaced the party's key in a closed strand, once the replacement is recorded. |
| `strand:party-key-rotation-blocked` | A key replacement cannot finish here because the party is not a manager of the strand. |

### Cadre

| Event | Fires when |
| --- | --- |
| `control:connected` | `start()` brought the control node and database up. It does not mean another machine is connected. |
| `control:disconnected` | The node stopped, or a start failed after `control:connected`. |
| `control:write-abandoned` | The node gave up retrying a control write ([Control-write retry](cadre/control-replication.md#control-write-retry)). A foreground caller also gets the error. |
| `pendingJoin:changed` | This machine's view of a `requestJoin` request changed. Owner machines only. |
| `seed:received` | A seed arrived over the seed protocol. |
| `seed:applied` | A delivered seed was verified, recorded and acknowledged. |
| `seed:error` | A delivered seed was refused or failed to apply. |
| `claim:accepted` | Once, on a node started with `claim`, when an owner claimed it. Fires before that seed's `seed:applied`. |
| `cadre:removed` | This node learned that an owner removed it from the cadre. Not guaranteed to arrive. Nothing is stopped or deleted. |

## Errors

Each error in the table is a class exported from `@serfab/cadre-core`, so an app can test with `instanceof`. A node that is not started, a missing owner signer and an invalid argument throw a plain `Error`.

The table lists the errors an app's own calls throw. Described elsewhere: the provider client's errors ([Renting a node from an app](hosting/provider.md#renting-a-node-from-an-app)); the errors of joining a cadre, moving strands and dissolving a former party ([Several apps in one cadre](cadre/apps.md)); and `FormationApprovalError` ([Formation approval hook: Outcomes](formation-approval-hook.md#outcomes)). The package's remaining error classes are caught by the node itself and answered with a protocol code.

| Error | Thrown by | Meaning |
| --- | --- | --- |
| `FormationRejectedError` | `formStrand` | The inviter refused. `code` says why ([Formation rejection codes](strands/formation.md#formation-rejection-codes)) and `retryable` whether the same invitation can succeed later. |
| `FormationUnreachableError` | `formStrand` | No answer arrived. Always retryable. |
| `FormationPostApprovalError` | `formStrand` | The inviter approved, so the token is spent, and a step on this machine then failed. Fix the local cause and ask for a new invitation. |
| `StrandAwaitingFirstSyncError` | `addStrand`, `whenStrandWritable` | The first sync did not finish in time. The strand keeps syncing; wait again. |
| `AppSchemaRefusedError`, `AppSchemaOutdatedError` | `addStrand`, `strand:error` | The app's schema can never apply to the strand's tables, or the strand records a higher schema version ([App schema versions across a strand's members](strands/app-schema.md#app-schema-versions-across-a-strands-members)). |
| `SchemaVerificationError`, `InvalidStrandIdError` | `addStrand`, `foundStrand` | The sApp signature is missing or wrong; the strand id cannot be used as a storage name. |
| `StrandQueueNotEmptyError` | `unpublishStrand`, `forgetJoinedStrand` | The offline queue holds transactions (`transactionIds`). Nothing was removed. |
| `StrandOfflineUnavailableError` | `CadreNode.setStrandOfflineMode` | The node has no offline journal configured. |
| `EntryNotDiscardableError`, `UnknownEntryError` | `StrandDatabase.offline.discard` | The transaction was sent or is being sent; or the queue does not hold it. |
| `StrandOfflineQueueBusyError`, `StrandTransactionBusyError` | The membership writers | The offline queue holds transactions; or a transaction is open and the caller passed `{ joinOpenTransaction: false }`. Nothing was written. |
| `CadreInviteRejectedError`, `CadreInviteUnreachableError`, `CadreInviteReplyInvalidError` | `redeemCadreInvitation`, `joinWithOwnerGrant` | A member refused (`code`, `retryable`), no listed address answered, or the acceptance failed its check. |
| `OwnerGrantRejectedError`, `OwnerGrantUnreachableError`, `OwnerGrantReplyInvalidError`, `OwnerGrantIssuerUnknownError` | `redeemOwnerGrant`, `joinWithOwnerGrant` | The same three cases for an owner grant; or its issuer is not an owner here. |
| `OwnerKeyAddRefusedError` | `addOwner`, `redeemOwnerGrant` | `code` is `alone`: the party has other machines and none is reachable. Connect and retry. |
| `OwnerKeyRemovalRefusedError`, `MachineRemovalRefusedError` | `removeOwner`, `removeMachine` | `code` is `not-an-owner`, `self` or, for an owner key, `unknown`, `last-owner` or `alone`. Nothing was written. |
| `OwnerSigningDeclinedError` | Any owner call | The user declined the signer's prompt, or it timed out. |
| `OwnerKeySlotOccupiedError`, `OwnerKeyExportError` | `createOwnerKey`, owner-key import and export | The owner slot already holds a key; or the text is not an owner key, needs a passphrase, or the passphrase is wrong (`code`). |
| `KeyStoreAccessError` | A `KeyStore` backend | The key store refused a read, for example a cancelled unlock prompt. It does not mean the key is absent. |
| `ClaimRefusedError`, `PeerUnreachableError` | `claimNode`, `deliverSeed` | The waiting node refused the claim; or no connection formed from any address given, and nothing was sent. |
| `ControlStoreIncompatibleError`, `RelayReservationFailedError`, `UnbindableListenAddressError` | `start()` | This build must not migrate the stored control database; a relay in `network.relayAddrs` gave no reservation while `network.requireRelay` is not `false`; or a listen address needs a transport the node lacks. |
