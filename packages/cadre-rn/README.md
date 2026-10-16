# @serfab/cadre-rn

The React Native kit for Sereus apps. A React Native app that runs a `@serfab/cadre-core` node depends on this package for the platform-specific pieces, instead of copying them from the reference app.

Every entry point is a subpath; there is no root import. An app loads only the parts it uses, so it installs only the native modules those parts need.

| Import | What it provides |
|---|---|
| `@serfab/cadre-rn/phone-node` | `createPhoneNode(platform)`: builds, starts, stops and rebuilds the phone's `CadreNode` the prescribed way, plus `attachStrandWhenWritable` and `retryAfterRestart` |
| `@serfab/cadre-rn/app-link` | The links two Sereus apps on one phone open each other with to hand over a join request and its answer: link building and parsing, the response codec, the installed-app lookup and `LinkRequestStore` (see [App links](#app-links-serfabcadre-rnapp-link)) |
| `@serfab/cadre-rn/provider` | Renting a node from a hosting provider: `signInWithProvider` through the system browser, `providerTokensSlot` for the tokens in the secure store, and `rentalStore`, the app's record of its rentals (see [Provider](#provider-serfabcadre-rnprovider)) |
| `@serfab/cadre-rn/lifecycle` | `createBackgroundRunner`: hibernates the node's strands when the app goes to the background and resumes, bounded, when it returns; `phoneNodeLifecycle(phone)` connects it to a phone node |
| `@serfab/cadre-rn/key-store` | `SecureStoreKeyStore`: cadre-core's `KeyStore` over the platform secure store, so the node identity lives in the iOS Keychain / Android Keystore rather than plaintext storage |
| `@serfab/cadre-rn/node-local` | `secureStoreSlot`, `kvStoreSlot` and the record keys: the `DurableSlot`s cadre-core's node-local stores (trusted owners, bootstrap peers, enrolled machines, strand network state) persist through |
| `@serfab/cadre-rn/noise-crypto` | `buildNoiseCrypto(mode)`, `NoiseCryptoMode`, `DEFAULT_NOISE_CRYPTO_MODE`: runs libp2p's Noise connection encryption in native code. Loading it also switches `crypto.subtle.digest` to native SHA-256/512 (see `native-digest`) |
| `@serfab/cadre-rn/native-digest` | `installNativeDigest(createHash)`, `nativeDigestActive()`: replaces the boot polyfill's JavaScript `crypto.subtle.digest` with a native hash |
| `@serfab/cadre-rn/polyfills` | Side effects only: the web APIs libp2p and Optimystic read that Hermes and React Native lack (`AbortSignal.timeout` / `any`, abort reasons, `WebSocket.prototype.bufferedAmount`, `Promise.withResolvers`, `structuredClone`, `DOMException`, `crypto.subtle.digest`, EventTarget / `CustomEvent`, `Intl.PluralRules`, timer `ref()` / `unref()`, and more) |
| `@serfab/cadre-rn/native-ed25519` | `installNativeEd25519(nativeSubtle)`, `nativeEd25519Active()`: installs `crypto.subtle`'s key, sign and verify methods from a native WebCrypto when any is missing |
| `@serfab/cadre-rn/polyfills/native-crypto` | Side effects only: native Ed25519 and SHA-256/512 behind `crypto.subtle` from boot, through `react-native-quick-crypto` |
| `@serfab/cadre-rn/polyfills/webrtc` | Side effects only: `react-native-webrtc`'s `registerGlobals()`, for apps that use `@libp2p/webrtc` |
| `@serfab/cadre-rn/boot-check` | Side effects only, development builds only: a boot-time table of which globals are native, polyfilled, known gaps or missing, and a `[reload] <reason>` log line before any reload started from JavaScript |
| `@serfab/cadre-rn/metro` | CommonJS, for `metro.config.js`: `withCadreMetro(config, options)` adds the Metro settings a Sereus app needs (Node built-in shims, one copy of each native module, libp2p's browser variants) |
| `"@serfab/cadre-rn"` in `app.json` `plugins` | The Expo config plugin (subpath `./app.plugin.js`, CommonJS): lets Android release builds dial `/ws` addresses, and with `appLinks` registers the app links (see [Config plugin (Expo)](#config-plugin-expo)) |

## Phone node

`createPhoneNode` is a phone app's whole node bring-up. It keeps the identity and the app's owner key in the secure store, each in its own slot, opens the four node-local stores party-scoped, gives each storage scope its own LevelDB database, makes the phone its party's owner, remembers the last start so the app can start again unattended, moves the node to another party's cadre by invitation, deletes the cadre it left once that cadre is empty, and deletes a cadre whose owner removed the app. Call it once, at module scope; a second call over the same storage names throws while the first is running.

It is `@serfab/cadre-core/edge-node`'s `createEdgeNode` over the secure store and rn-leveldb: the kit supplies the key store (`SecureStoreKeyStore`), the storage (a LevelDB database per storage scope and one for the node-local records, `src/phone-node/leveldb-storage.ts`) and the trusted-owner anchor's secure-store slot; the transitions, the owner step, the saved start, the join, the strand move, the dissolve and the removal are the edge node's, and `PhoneNode`, `PhoneNodeOptions`, `PhoneNodeStatus` and the other names below are its types under the kit's names. An app that runs a node on another platform (a browser, NativeScript) runs the edge node directly over a key store and storage of its own.

```ts
import * as SecureStore from 'expo-secure-store';           // or an adapter over the app's own secure store
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { createPhoneNode } from '@serfab/cadre-rn/phone-node';
import { buildNoiseCrypto, DEFAULT_NOISE_CRYPTO_MODE } from '@serfab/cadre-rn/noise-crypto';

export const phone = createPhoneNode({
	secureStore: SecureStore,
	secureStoreOptions: { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
	leveldb: { openFn: (n, c, e) => new LevelDB(n, c, e), WriteBatch: LevelDBWriteBatch, destroy: (name) => LevelDB.destroyDB(name) },
	noiseCrypto: { build: buildNoiseCrypto, defaultMode: DEFAULT_NOISE_CRYPTO_MODE },
	names: { storagePrefix: 'myapp-', nodeLocalDb: 'myapp-node-local', nodeLocalKvPrefix: 'myapp:node-local:' },
	dataVersion: '1',
});

// Register strand handling before the first start: strands joined from another party
// come back through `strand:discovered` after every start.
phone.on('strand:discovered', ({ strand }) => { /* attachStrandWhenWritable(phone.node!, { strandRow: strand, sAppConfig }) */ });

const saved = await phone.loadSavedStart();
if (saved?.autoStart) await phone.start(saved.options);
```

| Member | What it does |
|---|---|
| `start(options)` | Starts the node, or joins the start in flight; a running node is returned as is. A start called during a stop or restart runs after it, so it never builds on databases being closed. A failed start closes everything it opened and leaves `status` `failed`. A successful one saves its options with `autoStart: true`. |
| `stop()` | The user's disconnect: waits for a start in flight, saves `autoStart: false`, stops the node, and closes every database it opened (rn-leveldb locks each name, so one left open fails the next start). |
| `restart(options)` | Rebuilds the node with new relays or a new Noise mode, which libp2p reads only when the node is built. Leaves `autoStart` set. |
| `joinCadre(invitation, options?)` | Joins the cadre a decoded cadre invitation names, moving this app's one node to that party with the same identity (see [Joining another cadre](#joining-another-cadre)). Resolves once a member admitted the app, with the redemption's result, `formerPartyId` and `strandMove` (see [Moving the app's strands](#moving-the-apps-strands)). On a refusal, an expiry while waiting (`invite-spent`), a cancel through `options.signal` or a failed start, it starts again what was running before and throws. Options: `relayAddrs` and `noiseCryptoMode` (default: the running or saved start's), `signal`, `onProgress` (each redemption pass and pause, then `admitted` and, when this join's strands are being adopted, `moving-strands`; a listener that throws is logged and ignored). |
| `identityPeerId()` | This app's peer id, the same in every party, for a join request before any cadre is started. Answers at once while a node is running or joining; otherwise reads the identity from the secure store (creating it on a fresh install) in turn with start, stop and join, so the first start uses the same key. |
| `pendingStrandMove()` | The move from `formerPartyId` still waiting to be adopted: the party it moves to, the strands not seated there yet and those it refused. `undefined` when none waits. |
| `finishStrandMove()` | Adopts the waiting move on the running node now, in turn with start, stop and join, and returns cadre-core's `StrandMoveReport`; `undefined` when no move names the running party. Throws `StrandMoveNotOwnerError` while the app's key is no owner there. |
| `dissolveFormerParty(options?)` | Deletes the local storage of `formerPartyId` once the running party holds everything it holds and no other machine is in it, and starts the running party again without `formerPartyId` (see [Dissolving the left cadre](#dissolving-the-left-cadre)). |
| `loadSavedStart()` | The last successful start's options, `autoStart`, and `writtenBy`: the `dataVersion` of the build that wrote this device's data, for the app to compare with its own. During a stop it answers after the stop has saved `autoStart: false`, and during a removal after the removal has replaced it. |
| `on(event, handler)` | A node event for the life of the phone node: re-applied to every node a start or restart builds. Returns an unsubscribe. |
| `status`, `onStatus` | `stopped`, `starting`, `joining` (started in the invitation's party and redeeming there; `node` is null meanwhile), `running` (with `owner`: `enrolled`, `member`, `failed` or `timed-out`), `removed` (an owner removed the app from `partyId`; see [Removed from the cadre](#removed-from-the-cadre)), or `failed` (with the error). |
| `ownerPublicKey()` | The public key of the owner key the running node signs with, for pairing and approval prompts; null unless running with one wired (a `member` has none). |
| `listOwnerKeys()`, `addBackupOwnerKey(options?)`, `exportOwnerKey(options?)`, `importOwnerKey(text, passphrase?)`, `planOwnerKeyRemoval(key)`, `removeOwner(key, options?)` | The owner-key screen's calls; see [The phone's owner key](#the-phones-owner-key). |

Platform options with defaults:

- **`transports`**: WebSockets and circuit relay. An app with `react-native-webrtc` adds `webRTC({ rtcConfiguration: { iceServers: resolveStunServers(relayAddrs) } })`, as the reference app does.
- **`allowPrivateDial`**: `true`. Dials loopback, private and plain `ws://` addresses, which libp2p's React Native gater refuses. Without it an emulator cannot reach `10.0.2.2`, and a relay on the home network or without TLS is unreachable.
- **`ownerGenesisTimeoutMs`**: 60 s. Also bounds wiring the owner key of a joined party.
- **`configure(config)`**: none. The last word on the generated `CadreNodeConfig`: strand filter, `requireSignedSchemas`, `linkRoundTripMs`.

### The phone's owner key

The app holds at most one owner key, apart from its identity ([architecture.md → Owner Keys](../../docs/architecture.md#owner-keys)): in the same `SecureStoreKeyStore` as the identity, in the owner slot (`DEFAULT_OWNER_KEY_ID`, `cadre/owner`), with the same `secureStoreOptions`. Keep those ungated (`AFTER_FIRST_UNLOCK`, no `requireAuthentication`): background owner writes sign with no user present. Biometric gating belongs with prompting signers (`tickets/backlog/feat-owner-key-on-a-hardware-key.md`).

How a start settles it (`status.owner`):

- **Founded party with no `OwnerKey` row yet:** the slot's key becomes the founding row under `PhoneNodeOptions.ownerKeyLabel` (default `phone`) and is wired. It is created now unless the slot already holds one (a key imported before founding, or one an iOS reinstall kept in the Keychain); the kit creates a key nowhere else. `enrolled`.
- **Founded party that has owners:** the slot's key is wired when it is a live owner (`enrolled`). Otherwise, the slot empty or its key not an owner, the app is a `member` and no key is created, since a new one could not be seated without another owner's signature. A lost slot is recovered by importing a backup.
- **Joined party:** the slot's key is wired when it is a live owner; otherwise the identity key is, when the party lists it, which is what an owner-granting invitation seats until owner grants seat a key of their own. Otherwise `member`.

The owner-key calls run in turn with start, stop and join, and those that name the node throw while none is running:

- **`listOwnerKeys()`**: cadre-core's `CadreOwnerKey` rows, with label, voucher, `heldHere` and `trusted`.
- **`addBackupOwnerKey({ label?, passphrase? })`**: seats a new key as an owner, signed by this app's key, and returns `{ publicKey, exportText }`; the phone keeps nothing, so the app shows or saves the text once. Refused `alone` (cadre-core's `OwnerKeyAddRefusedError`) while the phone has no connection to a cadre with other machines.
- **`exportOwnerKey({ label?, passphrase? })`**: the slot's key as `{ publicKey, exportText }`; name the export by `publicKey`, since a phone signing with the identity key an owner-granting invitation seated keeps signing with it whatever the slot holds. Works with no node running; throws when the slot is empty.
- **`importOwnerKey(text, passphrase?)`**: stores the key in the slot and, with a node running, wires it when the party lists it (`{ wired: true }`, and `status.owner` becomes `enrolled`). Refused with `OwnerKeySlotOccupiedError` when the slot holds a different key, and with `OwnerKeyExportError` for text that is not an owner key (an invitation or join request is named), a locked export with no passphrase (`passphrase-required`) or a wrong one. A node already signing with the identity key keeps it until its next start.
- **`planOwnerKeyRemoval(key)`**, **`removeOwner(key, { revouch })`**: cadre-core's, for the removal prompt and its keep-switches.

One key imported on two devices signs on both; their concurrent writes conflict as any two owners' do.

### Joining another cadre

An app that runs its own one-node cadre joins the user's main cadre with `joinCadre`, which switches the node rather than running a second one beside it: a node serves one party, and a second libp2p host on the same identity would compete for its peer id. The reasons and the full sequence are in [architecture.md → An app joins an existing cadre](../../docs/architecture.md#an-app-joins-an-existing-cadre).

```ts
import { decodeCadreInvitation } from '@serfab/cadre-core';

const cancel = new AbortController();   // a Cancel button calls cancel.abort()
const joined = await phone.joinCadre(decodeCadreInvitation(pasted), {
	signal: cancel.signal,
	onProgress: (p) => {
		if (p.state === 'waiting') show(p.reason);   // 'no-member-answered' | 'member-not-ready'
		else if (p.state === 'admitted') show('admitted; finishing');
		else if (p.state === 'moving-strands') show('moving your chats');
	},
});
```

The saved start records how the app came to its party:

- **`origin`**: `'founded'` (or absent) runs owner genesis on every start; `'joined'`, which `joinCadre` saves, never does, and wires a key only when the party lists it as an owner ([The phone's owner key](#the-phones-owner-key)), so the app reports `owner: 'member'` otherwise. A start that names no `origin` takes the saved start's when it is for the same party.
- **`formerPartyId`**: the party this app founded and left. Its data stays on disk under its own names until `dissolveFormerParty()` deletes it, which also drops this field.

Nothing is saved until a member admits the app, so a kill while waiting relaunches into the party it left. `stop()` cancels a join in progress.

#### Moving the app's strands

Leaving a party it founded, `joinCadre` carries that party's strands, pending joins and invitations into the party it joins, with cadre-core's `exportStrandBundle` and `adoptStrandBundle` ([architecture.md → Moving the app's strands](../../docs/architecture.md#moving-the-apps-strands)). Leaving a party it joined moves nothing: that party's strands are its owners' to move.

- **Before anything stops**, the strands are exported from the running node, or from a node started for the export alone when none runs (status goes `starting` and back to `stopped`). The bundle is kept in the secure store, `cadre/strand-move/<base64url party id>`, one record per party left: it holds read secrets, party keys and bearer invitations. An empty export removes the party's earlier record instead.
- **The join is refused** with `StrandsNeedOwnerJoinError`, the party left running and unchanged, when there is something to move and the invitation does not grant owner: every row a move seats is owner-signed. A failed export or record write is thrown the same way.
- **Admitted**, the start is saved, then the bundle is adopted if the app's key is wired as an owner, then the join reports `running`. A kill during the adoption relaunches into the joined party, which finishes it.
- **`result.strandMove`** is `{ state: 'done' | 'partial', report }` (`partial`: `report.failed` lists what is retried), or `{ state: 'deferred', reason: 'owner-key-not-wired' }`, or `{ state: 'deferred', reason: 'adoption-failed', error }`. Absent when there was nothing to move.
- **A deferred or partial move** is retried by every start whose owner key is wired, before it reports `running`, or at once by `finishStrandMove()`. The record is deleted when an adoption fails nothing; strands the joined party refuses permanently (it participates in them under its own identity) are left out of later retries and listed in each report.
- **A failed join** deletes the record it wrote, so the next join exports afresh.
- **The left party's rows stay** in its storage until it is dissolved (below). No record for `formerPartyId` means nothing from it waits to be adopted; a record the kit cannot parse is deleted with a warning, so the absence is not proof that every strand arrived.

#### Dissolving the left cadre

Once the move has finished, `dissolveFormerParty()` deletes what the party the app founded and left still holds on the phone, so the app runs only as a member of the party it joined ([architecture.md → Dissolving the party it left](../../docs/architecture.md#dissolving-the-party-it-left)). It runs in turn with start, stop and join, and takes a restart of the running node: it stops it, starts a node for the left party alone to read that party's strands, pending joins and machines from its own storage, stops that node, and starts the running party again.

```ts
import { FormerPartyNotEmptyError } from '@serfab/cadre-rn/phone-node';

try {
	await phone.dissolveFormerParty();
} catch (err) {
	if (!(err instanceof FormerPartyNotEmptyError) || err.otherMachines.length > 0) throw err;
	// The user confirmed giving up what the running party does not hold.
	await phone.dissolveFormerParty({ discard: [...err.strandIds, ...err.pendingJoinIds] });
}
```

- **Refused before anything stops** with a plain `Error` unless the node runs with a `formerPartyId` other than its own party, and with `StrandMovePendingError` (`pending`, as `pendingStrandMove()` reports it) while a move from that party waits: call `finishStrandMove()` first, in the party the move names.
- **Refused after the read** with `FormerPartyNotEmptyError`, the running party started again and nothing deleted, when the left party holds a strand the running party does not, or a pending join still open there, or has a machine other than this app's node (`strandIds`, `pendingJoinIds`, `otherMachines`). A strand or join the running party dropped after the move reads the same, so the ids may be passed back as `discard`; other machines may not: remove them in the left party first.
- **Removed:** the left party's control database (through `leveldb.destroy`, rn-leveldb's `LevelDB.destroyDB`), its node-local records, its trusted-owner anchor, its unpublished joined-strand records and its move record; the saved start drops `formerPartyId`. Strand databases stay: a moved strand's database is the running party's copy.
- **A crash partway** is finished by the next start, or the next call: a node-local record under `names.dissolveMarkerKey` (`dissolving-party`) names the party from before the first deletion until the last.
- **A failure starting the running party again** after the removal is the call's error, the node down; after a refusal it is logged and leaves `status` `failed`.

### Removed from the cadre

When the running node reports that an owner removed this app from its party (cadre-core's `cadre:removed`, [architecture.md → Removing a machine](../../docs/architecture.md#removing-a-machine)), the kit acts on it in turn with start, stop and join, so the app only has to show it:

- **The node stops**, and the saved start stops naming the party before anything is deleted: it becomes a start of `formerPartyId` (the party this app founded and left, `origin: 'founded'`) with `autoStart: false`, or is deleted when there is none. Nothing starts unattended; the user sees why the app left its cadre first.
- **The party's local storage is deleted** as a dissolve deletes it: its control database, node-local records, trusted-owner anchor, unpublished joined-strand records and move record, with the same marker, so a failure partway is finished by the next start. Strand databases stay.
- **`status`** becomes `{ state: 'removed', partyId, removal, formerPartyId? }`: `removal` is cadre-core's `CadreRemoval` (the retired stamp, and `signerKey`, the removing owner, when its key is anchored here). From `removed`, `start` and `joinCadre` work as from `stopped`: the app offers "go back to your own cadre" (`start((await phone.loadSavedStart())!.options)`) when `formerPartyId` is set, and a join otherwise.
- **A failure rewriting the saved start** leaves the storage, which that start still names, and `status` `failed`.
- **An app that keeps its own copy of the start options** drops it on `removed`: the kit does not refuse them, and starting them builds the removed party again on empty storage. Starts that read `loadSavedStart()`, as `phoneNodeLifecycle` does, are safe.

It is best-effort, as the report is: a phone removed while its app was not running never learns it, and keeps the party's data while the party's other machines refuse it.

### Helpers

Two helpers for code that uses the node:

- `attachStrandWhenWritable(node, config)` treats a first sync that outlasts `addStrand`'s budget as progress and waits for the strand to become writable.
- `retryAfterRestart(write)` retries a write that fails for want of a super-majority, as the first writes after a node restarts alone do.

### What the app must install

`@serfab/cadre-core`, `rn-leveldb` and its secure-store module. `@optimystic/db-p2p-storage-rn` and the default transports are dependencies of the kit. `@libp2p/webrtc` and `react-native-webrtc` only if the app adds WebRTC.

## Lifecycle

`createBackgroundRunner` follows react-native's `AppState`.

- **On `background`** it hibernates the node's strands and keeps the control connection up for as long as the OS allows. It drops to `background-hibernating` when the control network disconnects.
- **On `active`** it starts the node again if the OS killed it. It then waits, bounded, for the control network to reconnect, and reports `degraded` if it does not. `inactive` (an incoming call, the app switcher) does nothing.
- **Rapid flapping** is safe: a later transition always wins over an earlier one still in progress.

```ts
import { AppState } from 'react-native';
import { createBackgroundRunner, phoneNodeLifecycle } from '@serfab/cadre-rn/lifecycle';

const runner = createBackgroundRunner({ ...phoneNodeLifecycle(phone), appState: AppState });
runner.onStateChange(() => render(runner.state, runner.resuming, runner.degraded));
runner.start();   // once the node is running; runner.stop() on logout
```

`phoneNodeLifecycle(phone)` supplies the runner's two node hooks from a `PhoneNode`. Its cold start uses the saved start, and only while `autoStart` is set, so a node the user stopped stays stopped. An app that must refresh its own state after a cold start passes its own `ensureNode` instead.

The runner never imports `react-native`: `AppState` is assignable to its `AppStateLike`, and tests pass a fake. A push wake (FCM/APNs) is the app's own; the reference app's `push-wake*.ts` is the worked example.

## App links (`@serfab/cadre-rn/app-link`)

Two Sereus apps on one phone hand a join request and its answer to each other by opening each other with a link, so the user confirms once in the owner app instead of copying a request one way and an invitation back. [docs/architecture.md → Between apps on one phone](../../docs/architecture.md#between-apps-on-one-phone) has the flow, the link formats, the decisions and the security reasoning; this section is the API. The module imports nothing from React Native or Expo: the app passes `Linking.canOpenURL` in.

The asking app, which wants to join:

```ts
import { Linking, Platform } from 'react-native';
import { decodeCadreInvitation, encodeCadreJoinRequest } from '@serfab/cadre-core';
import { installedSereusApps, joinRequestLink, KNOWN_SEREUS_APPS, LinkRequestStore, parseCadreLink } from '@serfab/cadre-rn/app-link';

const store = new LinkRequestStore(phone.linkRequestSlot());   // one per app

// iOS: the user picks one of the installed owner apps. Android: null, and the system chooser lists them.
const owners = await installedSereusApps(KNOWN_SEREUS_APPS, ownScheme, (url) => Linking.canOpenURL(url));
const ownerApp = Platform.OS === 'ios' ? pickedFrom(owners) : null;

const { nonce } = await store.begin(ownerApp?.name ?? null);
const request = encodeCadreJoinRequest({ v: 1, peerId: await phone.identityPeerId(), appName, reply: { scheme: ownScheme, nonce } });
await Linking.openURL(joinRequestLink(request, ownerApp));

// When the answer's link arrives, at launch or as a `url` event:
const link = parseCadreLink(url);
if (link?.kind === 'join-response') {
	const response = await store.take(link.text);   // UnsolicitedJoinResponseError unless it answers the open request
	if ('invitation' in response) await phone.joinCadre(decodeCadreInvitation(response.invitation));
}
```

The owner app, which answers:

```ts
import { decodeCadreJoinRequest, encodeCadreInvitation } from '@serfab/cadre-core';
import { joinResponseLink, parseCadreLink } from '@serfab/cadre-rn/app-link';

const link = parseCadreLink(url);
if (link?.kind === 'join-request') {
	const request = decodeCadreJoinRequest(link.text);
	// …the user confirms, and the app mints `invitation` targeted at request.peerId. A request
	// without a reply (scanned or pasted) gets the invitation shown for copying instead.
	if (request.reply) {
		const answer = { v: 1, nonce: request.reply.nonce, appName: ownName, invitation: encodeCadreInvitation(invitation) } as const;
		await Linking.openURL(joinResponseLink(request.reply, answer));
	}
}
```

- **`parseCadreLink(url)`** says whether a URL is a join request or a join response, and returns its text undecoded. Anything else, a node code (`sereus-join:1.…`) or an invitation included, is `null`, so the app's other link routing is untouched.
- **`joinRequestLink(text, ownerApp)`** is the request text itself on Android (`ownerApp` `null`), which every opted-in app handles, so the system chooser lists the owner apps. On iOS, which has no chooser, it is `<ownerApp.scheme>://cadre-join-request/<text>`.
- **`joinResponseLink(reply, response)`** is `<reply.scheme>://cadre-join-response/<response text>` on both platforms. It checks the reply again with cadre-core's `requireCadreJoinReply`, so a web or system scheme throws. Past `CADRE_LINK_MAX_LENGTH` (32 KB) it throws `CadreLinkTooLongError`, and the owner app shows the invitation for copying instead.
- **`encodeCadreJoinResponse` / `decodeCadreJoinResponse`** are the answer's codec (`sereus-join-response:1.`, encoded as the request is): the request's nonce, the answering app's unverified name, and exactly one of an `invitation` text and a `refused` reason (`denied`, `no-cadre`, `not-owner`, `already-member`).
- **`installedSereusApps(apps, ownScheme, canOpenURL)`** is for iOS: the apps whose scheme `canOpenURL` reports installed, the app's own excluded. React Native's `canOpenURL` rejects for a scheme missing from `LSApplicationQueriesSchemes`; that app counts as not installed, with a warning naming the scheme.
- **`LinkRequestStore`** holds the asking app's open request; see [below](#the-open-request).
- **`PhoneNode.linkRequestSlot()`** is where the store keeps the request: the node-local database, under `PhoneNodeNames.linkRequestKey` (default `link-join-request`), so an asking app the OS killed while the owner app was in front takes the answer when the link starts it. It works with no node running.
- **Recommending another app** has its own store and links; see [below](#recommending-another-app).

### The open request

`LinkRequestStore` is the asking app's guard against answers it did not ask for.

- **`begin(ownerAppName)`** opens a request, or returns the open one with its nonce unchanged, so an answer to an earlier tap still lands.
- **`take(text)`** returns the decoded answer only when its nonce is the open request's, once, within `LINK_REQUEST_TTL_MS` (30 minutes), and otherwise throws `UnsolicitedJoinResponseError`. A malformed answer throws the codec's error and leaves the request open.
- **`current()` and `cancel()`** read and close the open request. A slot read that fails throws from `current` and `take` rather than reading as no request.
- **One per app.** Its calls run one at a time, so two deliveries of the same link cannot both take the answer; a second store over the same slot would not share that.

### Recommending another app

An owner app recommends a Sereus app and lets it join on its first launch without a prompt: the user allows it in the owner app first, and the owner app answers that app's join request without asking again. [docs/architecture.md → Recommending another app](../../docs/architecture.md#recommending-another-app) has the flow and the security reasoning.

The owner app, which recommends:

```ts
import { Linking, Platform } from 'react-native';
import { AppRecommendationStore, recommendedByLink, storePageLink } from '@serfab/cadre-rn/app-link';

const recommendations = new AppRecommendationStore(phone.recommendationSlot());   // one per app

// The user picked `app` from the known list and allowed it, choosing grantsOwner.
await recommendations.approve({ scheme: app.scheme, appName: app.name, partyId, grantsOwner });
const installed = await Linking.canOpenURL(`${app.scheme}://`);
const url = installed ? recommendedByLink(app, ownScheme) : storePageLink(app, Platform.OS === 'ios' ? 'ios' : 'android', ownScheme);

// Later, for a join request opened as a link, before prompting:
const approved = request.reply ? await recommendations.take(request.reply.scheme, partyId) : null;
// approved: mint the targeted invitation with approved.grantsOwner and answer by link, no prompt.
```

The recommended app reads the hint once, at first launch (the Play Install Referrer, through the app's own install-referrer module) or from a `recommended-by` link:

```ts
import { KNOWN_SEREUS_APPS, parseCadreLink, recommendedBySchemeFromReferrer } from '@serfab/cadre-rn/app-link';

const scheme = recommendedBySchemeFromReferrer(referrer) ?? (link?.kind === 'recommended-by' ? link.text : null);
const recommender = [...KNOWN_SEREUS_APPS, ...extraApps].find((app) => app.scheme === scheme);
// recommender: ask whether to join it, then send the join request to it as above, with recommender as ownerApp.
```

- **`AppRecommendationStore`** keeps the owner app's pre-approvals, one per scheme. `approve(entry)` records one, replacing any for the same scheme; `live(partyId)` lists the live ones, most recently approved first; `withdraw(scheme)` drops one; `take(scheme, partyId)` returns the live one for that scheme and party and removes it, or returns null. An entry lasts `RECOMMENDATION_TTL_MS` (an hour), is used up by one `take`, and is never returned for another party. Its calls run one at a time, as `LinkRequestStore`'s do; a malformed record reads as none, with a warning, and a slot read that fails throws.
- **`PhoneNode.recommendationSlot()`** is where the store keeps them: the node-local database, under `PhoneNodeNames.recommendationsKey` (default `recommended-apps`). It works with no node running.
- **`storePageLink(app, platform, ownScheme)`** is the app's Play page on `'android'`, with the install referrer `sereus-recommended-by:1.<ownScheme>` (`recommendedByReferrer`), and its App Store page on `'ios'`, which has no referrer. It is null when the app has no store id for that platform.
- **`recommendedByLink(app, ownScheme)`** is `<app.scheme>://cadre-recommended-by/<ownScheme>`, for an app already installed; `parseCadreLink` reads it as `{ kind: 'recommended-by', text: <scheme> }`.
- **`recommendedBySchemeFromReferrer(referrer)`** is the scheme when the referrer is exactly that token, and null for anything else, Play's `utm_source=google-play&utm_medium=organic` for an install no link started included.
- **Trust neither hint.** Anyone can build a Play link with any referrer, and any app can open another with any link. Use a scheme only when the app's own known list (the kit's plus its extras) has it, by exact equality, and show the name from that list, never from the hint.

### Adding an app to the known list

`KNOWN_SEREUS_APPS` has one entry per published Sereus app, `{ name, scheme }`, plus `androidPackage` (its Play application id) and `iosAppStoreId` (its numeric App Store id) once it is in a store, for `storePageLink`. A new app is added to it in `src/app-link/known-apps.ts` and to the copy in `app.plugin.cjs` (the plugin is CommonJS and cannot load the ESM build; a test keeps the two equal), then the kit is released. Until then the app passes itself as an extra, both in the plugin's `appLinks.extraApps` and in the `apps` argument of `installedSereusApps`.

Every Sereus app needs a URL scheme of its own, `expo.scheme`, which Expo registers: the answer comes back at it, and on iOS which of two apps sharing a scheme opens a link is undefined.

### What the app must install

`@serfab/cadre-core`, for the request codec. Natively, the config plugin's [`appLinks` option](#applinks-links-between-sereus-apps), which takes effect in the next native build.

## Provider (`@serfab/cadre-rn/provider`)

cadre-core's `provider/` has everything an app needs to rent a node from a hosting provider except the three platform pieces: opening the system browser for the sign-in, keeping the tokens, and remembering which containers the app rented ([docs/architecture.md → Renting a node from an app](../../docs/architecture.md#renting-a-node-from-an-app)). This subpath is those three. It imports nothing from React Native or Expo: the app passes `expo-web-browser`'s `openAuthSessionAsync` and its secure store in, so it runs under a Node test.

```ts
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { createProviderClient, createTokenSource, fetchProviderDescriptor, rentNode } from '@serfab/cadre-core';
import { providerTokensSlot, rentalStore, signInWithProvider } from '@serfab/cadre-rn/provider';

const descriptor = await fetchProviderDescriptor('https://nodes.acme.example/api/v1/descriptor');
const slot = providerTokensSlot(SecureStore, descriptor.id);
const rentals = rentalStore(phone.nodeLocalRecords());   // one per app

let tokens = await slot.load();
if (!tokens) {
	const signedIn = await signInWithProvider({ descriptor, clientId: 'my-app', redirectUri: 'my-app://provider-auth', openAuthSession: WebBrowser.openAuthSessionAsync });
	if (signedIn === 'cancelled') return;              // the user closed the browser: nothing was created
	tokens = signedIn;
	await slot.save(tokens);
}
const client = createProviderClient({
	apiBaseUrl: descriptor.apiBaseUrl,
	tokens: createTokenSource({ descriptor, clientId: 'my-app', tokens, persist: (next) => slot.save(next) }),
});
const result = await rentNode(node, client);        // the app records the container id for `finishRental` (below)
```

- **`signInWithProvider({ descriptor, clientId, redirectUri, openAuthSession, scopes?, fetch? })`** runs the OAuth 2 + PKCE handshake cadre-core's `provider/oauth.ts` defines: it mints the verifier and the state, opens `authorizationUrl` through `openAuthSession(url, redirectUri)`, reads the redirect and exchanges the code, returning `ProviderTokens`. `'cancelled'` when the browser closed without a redirect. A redirect carrying the provider's refusal (`access_denied`, `invalid_scope`), one whose state is not this sign-in's, and a refused exchange throw `ProviderAuthError` with the code. `openAuthSession` has the signature of `openAuthSessionAsync`; a bare React Native app passes an adapter over its own in-app browser that resolves `{ type: 'success', url }` on the redirect and anything else on a close. The redirect URI must be one the app registered with the provider, spelled exactly as registered; the app's `+native-intent` (Expo Router) should rewrite that path to a plain screen, since the browser session owns the URL and the single-use code must not stay in navigation state.
- **`providerTokensSlot(secureStore, providerId, options?)`** keeps one provider's pair in the secure store under `sereus.provider-tokens.<base64url provider id>`: `load()` (`undefined` when none is stored or the record is unreadable as one, logged; a denied read throws), `save(tokens)` (the sign-in's pair, and each one `createTokenSource`'s `persist` rotates to) and `clear()` for sign-out. The tokens are credentials for the customer's account, so they sit where the identity key does; the slot must be ungated, as `secureStoreSlot` must.
- **`rentalStore(kv)`** over `PhoneNode.nodeLocalRecords()` is the app's record of its rentals, by party, under `rentalsKvKey(partyId)` (`/node-local`): `Rental = { providerId, providerName, containerId, join, peerId?, createdAt, finished }`, with `list(partyId)`, `add(partyId, rental)`, `update(partyId, containerId, { peerId?, finished? })` and `remove(partyId, containerId)`, run one at a time. cadre-core's `rentNode` persists nothing, so an app records the container when the provider creates it (`finished: false`), marks it finished when `rentNode` or `finishRental` returns, and on its next launch offers to finish any record still unfinished. A record that cannot be read reads as no rentals, logged: the containers still exist on the provider's own pages.
- **`PhoneNode.nodeLocalRecords()`** (`/phone-node`) is the node-local database as a key-value store, for this and any other record an app keeps beside the saved start; it works with no node running.

### What the app must install

`@serfab/cadre-core`, and `expo-web-browser` (or the bare app's own in-app browser) for the sign-in; the secure store is the one the key store uses.

## Key store and node-local records

cadre-core asks its host for durable storage: a `KeyStore` for the node identity (`keyStore` in `CadreNodeConfig`, never `privateKey` on a phone) and the owner key, each in a slot of its own, and a `DurableSlot` behind each node-local store (`trustedOwners`, `bootstrapPeers`, `enrolledMachines`, `strandNetworkState`). Left out, each falls back to memory, and a phone that restarts before it reconnects loses its dial hints and its trusted owners. These two subpaths are the phone's answer.

Both talk to the secure store through `SecureStoreApi`, three async methods (`getItemAsync`, `setItemAsync`, `deleteItemAsync`) over string values. `expo-secure-store` is structurally assignable to it. A bare React Native app passes an adapter over its own secure-storage module that keeps the same contract: `null` for an absent key, a throw for a denied or failed read. Neither subpath imports a native module.

```ts
import * as SecureStore from 'expo-secure-store';
import { SecureStoreKeyStore } from '@serfab/cadre-rn/key-store';
import { anchorSlotKey, bootstrapPeersKvKey, kvStoreSlot, secureStoreSlot } from '@serfab/cadre-rn/node-local';
import { PersistentBootstrapPeerStore, PersistentTrustedOwnerStore } from '@serfab/cadre-core';

const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const keyStore = new SecureStoreKeyStore(SecureStore, options);
const trustedOwnerStore = await PersistentTrustedOwnerStore.open(
	secureStoreSlot(SecureStore, anchorSlotKey(partyId), options), partyId);
const bootstrapPeerStore = await PersistentBootstrapPeerStore.open(
	kvStoreSlot(nodeLocalKv, bootstrapPeersKvKey(partyId)), partyId);
```

The trust-bearing anchor goes in the secure store; the dial hints, the enrolled-machine count and the strand network state go in a LevelDB database of the app's own (`nodeLocalKv` above is a `LevelDBKVStore` over it), because they grant no authority and outgrow the secure store's value limit. The module headers give the reasoning. A `LevelDBKVStore` holds each write in memory until it is flushed, so keep one per open database for every slot to share, and `close()` it before the database; `kvStoreSlot` flushes on each save. `createPhoneNode` (above) wires all of this; these subpaths are for an app that builds its node another way.

Use the same options object for the key store and the anchor slot. `keychainAccessible: AFTER_FIRST_UNLOCK` lets iOS read the identity and the owner key while the device is locked, which a background or push-wake start needs. `secureStoreSlot` refuses a gated (`requireAuthentication`) slot, because it reads `null` as absent.

### What the app must install

`@serfab/cadre-core` (an optional peer, needed by every subpath that builds or persists a node: these two, `/phone-node` and `/lifecycle`), and the secure-store module it passes in: `expo-secure-store` under Expo, or the bare app's own choice. The LevelDB store is the app's `@optimystic/db-p2p-storage-rn`, which it already has for strand storage.

## Polyfills and boot check

**Import `@serfab/cadre-rn/polyfills` before anything else.** libp2p and its dependencies read these globals while their modules evaluate, so a library module that loads first has already captured `undefined`, and the failure shows up much later as an unrelated timeout. Nothing in the package can enforce the order; the app's entry file must:

```js
// index.js: the app's entry module (package.json "main")
import '@serfab/cadre-rn/polyfills';          // first
import '@serfab/cadre-rn/polyfills/native-crypto';   // only if the app has react-native-quick-crypto
import '@serfab/cadre-rn/polyfills/webrtc';   // only if the app uses @libp2p/webrtc
import '@serfab/cadre-rn/boot-check';         // after every polyfill, before the app
import 'expo-router/entry';                   // or AppRegistry.registerComponent(...)
```

`boot-check` goes after every polyfill and before the app's own code because both of its parts act at import time: the audit table has to print before an import-time crash could, and the reload logger has to be installed before the app tree evaluates. In a development build logcat shows the table under `[cadre-rn] polyfill audit`, and warns with `[cadre-rn] MISSING globals` if a global the stack reads is absent. `RTCPeerConnection` reads as a known gap in an app that does not import `/polyfills/webrtc`, and `crypto.subtle.importKey` in one that does not import `/polyfills/native-crypto`.

Each patch checks for the API first and does nothing where the runtime already provides it. The reference app's [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md#polyfills) lists what each one patches and which library needs it.

### What the app must install

React Native links native modules only for the app's own direct dependencies, so the app lists these in its `package.json` and rebuilds its native app after adding them:

- `react-native-get-random-values` (`^1.11.0`), for `/polyfills`: the native random source behind `crypto.getRandomValues`. There is deliberately no `Math.random` fallback.
- `react-native-webrtc` (`^124.0.6`), for `/polyfills/webrtc` only.

Both are optional peer dependencies of this package, as is `react-native` itself (`boot-check` imports its `DevSettings`). The pure-JavaScript polyfill libraries (`@ungap/structured-clone`, `web-streams-polyfill`, `event-target-polyfill`, `@noble/hashes`) are ordinary dependencies of this package; the app does not list them.

## `@serfab/cadre-rn/metro`

`withCadreMetro` takes the config the app's own toolchain produced, adds the Sereus settings to it and returns it, so an app's `metro.config.js` is one call. With Expo:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withCadreMetro } = require('@serfab/cadre-rn/metro');

module.exports = withCadreMetro(getDefaultConfig(__dirname), { projectRoot: __dirname });
```

With bare React Native:

```js
// metro.config.js
const { getDefaultConfig } = require('@react-native/metro-config');
const { withCadreMetro } = require('@serfab/cadre-rn/metro');

module.exports = withCadreMetro(getDefaultConfig(__dirname), { projectRoot: __dirname });
```

| Option | Meaning |
|---|---|
| `projectRoot` | The app's directory (`__dirname`). |
| `linkedRoots` | Optional. Local checkouts whose packages are linked into the app (a monorepo root, sibling repositories). Each is watched, and its `node_modules` is searched after the app's own. Omit it when every package comes from npm. |

What it adds, keeping whatever the incoming config already set (lists are appended to, an alias the app already has wins, an existing `resolveRequest` is called by the new one):

- Symlink support, and the `linkedRoots` as watch folders and module search paths.
- Aliases for the Node built-ins libp2p imports: `os` and `crypto` to small shims in this package, `net` and `tls` to an empty module, `stream` and `buffer` to the `readable-stream` and `buffer` packages. Both the bare and the `node:` names are mapped.
- A `resolveRequest` that resolves this package's peer dependencies (`react-native` and the native modules) from the app, whoever imports them, so the bundle holds one copy of each; resolves `@babel/runtime` helpers to their CommonJS files from the app's copy; and swaps `@libp2p/crypto` and `@libp2p/webrtc` files for the `browser` variants their package lists, which run under Hermes.

It relies on the toolchain's defaults for package exports (both Expo's and React Native's enable them) and leaves condition names to the app. The reference app's [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md#metro-configuration) explains each setting; the comments in `metro/index.cjs` have the full reasoning.

The app installs nothing extra for `/metro`. The peers it resolves are the ones the other subpaths already need, and only if something imports them.

## Config plugin (Expo)

An Expo app lists the kit under `plugins` in its `app.json`:

```json
{ "expo": { "plugins": ["@serfab/cadre-rn"] } }
```

At prebuild the plugin sets `android:usesCleartextTraffic="true"` on the `<application>` element of `android/app/src/main/AndroidManifest.xml`. Android release builds refuse plain `ws://` connections without it, so the app can dial no `/ws` address; React Native's template opts debug builds in, which hides the problem until the first release build. Dialing without TLS is safe because Noise encrypts and authenticates every libp2p connection against the peer id in the address; the reference app's [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md#release-builds-cleartext-websocket) has the reasoning.

- **It overrides `false` in the manifest.** The plugin sets `true` even where the app's own manifest says `false`.
- **Against another plugin, the one listed first wins.** When another plugin also sets the attribute (such as `expo-build-properties`' `android.usesCleartextTraffic`), the one listed **first** in `plugins` wins, because Expo runs manifest changes in reverse order of the list.
- **A network security config takes precedence.** Android follows an `android:networkSecurityConfig` file over the manifest flag, so an app whose file forbids cleartext must permit it there. The plugin does not edit that file.
- **iOS is unchanged.** Whether App Transport Security blocks React Native's WebSocket has not been checked; the docs section linked above says what would settle it.

The plugin resolves `expo/config-plugins` from the app's project root when it runs, so the kit installs nothing from Expo. Like any manifest change it takes effect in the next native build.

A bare React Native app, with no prebuild, adds the attribute by hand:

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<application android:usesCleartextTraffic="true" ...>
```

### `appLinks`: links between Sereus apps

The native settings [App links](#app-links-serfabcadre-rnapp-link) needs. Without the option, the plugin does only the above.

```json
{ "expo": { "scheme": "my-sereus-app", "plugins": [["@serfab/cadre-rn", { "appLinks": true }]] } }
```

`"appLinks": { "extraApps": [{ "name": "My Other App", "scheme": "my-other-app" }] }` adds Sereus apps not yet in the kit's known list. An extra may also carry `androidPackage` and `iosAppStoreId`, as a known app does, so one list of extras serves the plugin and the app's code.

- **Android.** The main activity gets a `VIEW` intent filter (`DEFAULT`, `BROWSABLE`) for the scheme `sereus-join-request`, so opening a join request lists the app in the system chooser. The manifest gets a `<queries>` `VIEW` intent for that scheme, so the opening app's `resolveActivity` sees the other handlers on Android 11 and later, and one for each scheme of `KNOWN_SEREUS_APPS` and `extraApps`, so `canOpenURL('<scheme>://')` can report which are installed. Each is skipped when already present.
- **iOS.** The schemes of `KNOWN_SEREUS_APPS` and of `extraApps` are added to `LSApplicationQueriesSchemes`, keeping the entries already there, so `canOpenURL` can report which apps are installed. The prebuild fails when the list passes 50 schemes, the most iOS reads.
- **The app's own scheme** is `expo.scheme`, which Expo registers as usual.
- **A misspelt option fails the prebuild**, as does an extra app without a name, with a scheme that is not a lowercase URL scheme, with an `androidPackage` that is not a dotted Java package name, or with an `iosAppStoreId` that is not 1 to 12 digits, rather than leaving the app without links.

A bare React Native app adds the intent filter and the `<queries>` entry to `AndroidManifest.xml`, and the schemes to `Info.plist`, by hand.

## `@serfab/cadre-rn/noise-crypto`

Metro resolves `@chainsafe/libp2p-noise`'s browser build, so on React Native every connection handshake and every encrypted frame runs SHA-256, ChaCha20-Poly1305 and X25519 in JavaScript on Hermes. SHA-256 over 512 bytes was measured at about 15 ms on a Galaxy S7 and 5 ms on an Android emulator, against 0.03 ms in Node on the emulator's own machine. `buildNoiseCrypto` returns a Noise crypto implementation backed by `react-native-quick-crypto` instead (the source file's header comment has the full measurements).

```ts
import { buildNoiseCrypto, DEFAULT_NOISE_CRYPTO_MODE } from '@serfab/cadre-rn/noise-crypto';

const config: CadreNodeConfig = {
	// ...
	network: {
		// ...
		noiseCrypto: buildNoiseCrypto(DEFAULT_NOISE_CRYPTO_MODE),
	},
};
```

| Mode | Effect |
|---|---|
| `'off'` | Returns `undefined`: Noise keeps its pure-JavaScript default. |
| `'symmetric'` (default) | Native SHA-256 and ChaCha20-Poly1305, the per-frame costs. X25519 stays pure JavaScript. |
| `'full'` | Also native X25519 key generation and Diffie-Hellman. It has had less device time than `'symmetric'`. |

Every mode starts from `noisePureJsCrypto` and overrides only its own functions, so anything it does not replace (`getHKDF`, for one) keeps working.

cadre-core reads `network.noiseCrypto` only when it builds the node. Changing the mode means stopping the node and starting a new one.

The reference app (`packages/reference-app-rn`) is the worked example: it takes the mode as a start option, defaults it from a build-time `EXPO_PUBLIC_NOISE_CRYPTO`, offers the three modes in its Settings screen, and shows the running node's mode on the Node card. [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md#phone-rn-app-configuration) walks through it.

### Native hashing comes with it

Loading this subpath also calls `installNativeDigest` (`@serfab/cadre-rn/native-digest`) with quick-crypto's `createHash`, so the boot polyfill's JavaScript `crypto.subtle.digest` is replaced with native SHA-256/512. Optimystic hashes every block through that digest (multiformats' `sha256`), and in pure JavaScript it took 47% of a phone app's JS time. Hashing done before the import uses the JavaScript fallback.

### What the app must install

React Native links native modules only for the app's own direct dependencies, so the app lists these in its `package.json`:

- `react-native-quick-crypto` (`^1.1.7`)
- `react-native-nitro-modules` (`>=0.31.2`), quick-crypto's native bridge
- `react-native-quick-base64` (`>=3.0.0`), which quick-crypto imports

`react-native-quick-crypto` needs React Native's new architecture. `@craftzdog/react-native-buffer`, which this module imports, is installed by quick-crypto itself; under a package manager that does not hoist (pnpm's default layout), list it in the app too.

All four are optional peer dependencies of this package: an app that never imports `/noise-crypto` does not need them. This module imports only quick-crypto and the buffer; nitro and quick-base64 are peers so that `/metro` resolves them from the app as well, keeping one copy of each.

## `@serfab/cadre-rn/native-digest`

`installNativeDigest(createHash, subtle?)` replaces `crypto.subtle.digest` with one over a Node-style `createHash`, for SHA-256 and SHA-512; any other algorithm stays with the previous digest. It replaces only the digest `polyfills/hermes.js` tagged as its JavaScript fallback, so real WebCrypto, or a digest the app installed itself, is left alone. It checks the hash against a known SHA-256 vector first, and keeps the fallback, with a warning, if the check fails. It returns `'installed'`, `'already'`, `'not-polyfilled'` or `'check-failed'`. `nativeDigestActive()` reports whether the native digest is in place.

It imports no native module. `noise-crypto` calls it, so an app that passes native Noise crypto needs nothing more; an app that does not can call it with its own `createHash` after the polyfills have loaded.

## Native Ed25519 (`@serfab/cadre-rn/polyfills/native-crypto`)

@libp2p/crypto signs and verifies Ed25519 through WebCrypto when it can, and otherwise in pure JavaScript (`@noble/curves`). Hermes has no WebCrypto beyond the boot polyfill's digest, so without this a phone does every signature in JavaScript: 169 ms per verify on a Galaxy S7, against 0.72 ms native (measured by sereus-chat).

```js
// index.js
import '@serfab/cadre-rn/polyfills';
import '@serfab/cadre-rn/polyfills/native-crypto';   // right after /polyfills, before libp2p
import '@serfab/cadre-rn/boot-check';
```

It installs `generateKey`, `importKey`, `exportKey`, `sign` and `verify` from react-native-quick-crypto's `subtle` when the global `crypto.subtle` lacks any of them, and installs the native digest (`native-digest`) at the same time. **It has to load at boot**: @libp2p/crypto decides between WebCrypto and JavaScript once, when its Ed25519 module is evaluated, and keeps the answer, so filling the methods later -- from `noise-crypto`, which itself imports libp2p -- would be too late for Ed25519. The digest has no such constraint.

`installNativeEd25519(nativeSubtle, subtle?)` (`@serfab/cadre-rn/native-ed25519`) is the logic, importing no native module. It installs the five as a set, replacing any already present, because a `CryptoKey` from one implementation is unusable by another's `sign`; all or nothing, so a probe never sees half a WebCrypto; and a complete WebCrypto is left alone. The methods serve every algorithm quick-crypto supports, so libp2p's ECDSA and RSA key import and export reach quick-crypto too. It returns `'installed'`, `'already'`, `'not-needed'` or `'unavailable'`.

### What the app must install

react-native-quick-crypto, react-native-nitro-modules and react-native-quick-base64, as for `noise-crypto`, and a native rebuild. Quick-crypto needs React Native's new architecture.
