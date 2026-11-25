# @serfab/cadre-rn

The React Native kit for Sereus apps: it builds and runs a `@serfab/cadre-core` node on a phone, and supplies the polyfills, Metro settings, native crypto and secure storage that node needs under Hermes. Every entry point is a subpath, so an app installs only the native modules that the subpaths it imports need.

This README is the API reference. Why each piece exists, how a phone becomes reachable, and where node state is stored are in [Running a node in a React Native app](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md).

## Install

```sh
yarn add @serfab/cadre-rn @serfab/cadre-core
```

Prerequisites: React Native 0.79 or newer, and a native build of the app (a development client or a release build; Expo Go cannot load the native modules). `react-native-quick-crypto` needs React Native's new architecture.

### What the app must install

React Native links native code only for an app's own direct dependencies, so the app lists these native modules in its own `package.json` and rebuilds after adding one. All are optional peer dependencies of the kit: a subpath the app never imports needs nothing.

| Subpath | The app installs |
|---|---|
| `/polyfills` | `react-native-get-random-values` (`^1.11.0`) |
| `/polyfills/webrtc` | `react-native-webrtc` (`^124.0.6`), and `@libp2p/webrtc` for the transport |
| `/polyfills/native-crypto`, `/noise-crypto` | `react-native-quick-crypto` (`^1.1.7`), `react-native-nitro-modules` (`>=0.31.2`), `react-native-quick-base64` (`>=3.0.0`) |
| `/phone-node` | `@serfab/cadre-core`, `rn-leveldb`, and a secure-store module (`expo-secure-store`, or the bare app's own) |
| `/lifecycle`, `/node-local`, `/key-store` | `@serfab/cadre-core`; the secure-store module for the last two |
| `/app-link` | `@serfab/cadre-core`, and the config plugin's `appLinks` option |
| `/provider` | `@serfab/cadre-core`, and `expo-web-browser` or the bare app's own in-app browser |
| `/boot-check` | Nothing beyond `react-native` |
| `/metro`, the config plugin | Nothing |

`@craftzdog/react-native-buffer`, which `/noise-crypto` imports, is installed by quick-crypto; under a package manager that does not hoist (pnpm's default layout), list it in the app too. The kit's other dependencies, the default transports (`@libp2p/websockets`, `@libp2p/circuit-relay-v2`) and `@optimystic/db-p2p-storage-rn` among them, are ordinary dependencies the app does not list.

## First run

Four files change in the app.

```js
// index.js: the app's entry module (package.json "main")
import '@serfab/cadre-rn/polyfills';                 // first
import '@serfab/cadre-rn/polyfills/native-crypto';   // only with react-native-quick-crypto
import '@serfab/cadre-rn/polyfills/webrtc';          // only with @libp2p/webrtc
import '@serfab/cadre-rn/boot-check';                // after every polyfill, before the app
import 'expo-router/entry';                          // or AppRegistry.registerComponent(...)
```

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');   // or '@react-native/metro-config'
const { withCadreMetro } = require('@serfab/cadre-rn/metro');

module.exports = withCadreMetro(getDefaultConfig(__dirname), { projectRoot: __dirname });
```

```json
{ "expo": { "plugins": ["@serfab/cadre-rn"] } }
```

```ts
// phone.ts
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

const saved = await phone.loadSavedStart();
if (saved?.autoStart) await phone.start(saved.options);
else await phone.start({ partyId: newPartyId, bootstrapAddrs: [], relayAddrs: [] });   // first launch: the app mints a party id, such as a UUID
```

After a native rebuild, a first launch ends with `phone.status.state` at `running` and `phone.status.owner` at `enrolled`: the app founded a one-node cadre and holds its owner key. A development build also prints the table `[cadre-rn] polyfill audit` to the device log, with no `MISSING` row. `packages/reference-app-rn/src/cadre-phone.ts` in the repository is a complete example.

## Subpaths

| Import | What it provides |
|---|---|
| `@serfab/cadre-rn/phone-node` | `createPhoneNode(platform)`, `attachStrandWhenWritable`, `retryAfterRestart` |
| `@serfab/cadre-rn/lifecycle` | `createBackgroundRunner`, `phoneNodeLifecycle(phone)` |
| `@serfab/cadre-rn/app-link` | Link builders and parser, the response codec, `installedSereusApps`, `LinkRequestStore`, `AppRecommendationStore` |
| `@serfab/cadre-rn/provider` | `signInWithProvider`, `providerTokensSlot`, `rentalStore` |
| `@serfab/cadre-rn/key-store` | `SecureStoreKeyStore`: cadre-core's `KeyStore` over the platform secure store |
| `@serfab/cadre-rn/node-local` | `secureStoreSlot`, `kvStoreSlot` and the record keys, for cadre-core's node-local stores |
| `@serfab/cadre-rn/noise-crypto` | `buildNoiseCrypto(mode)`, `NoiseCryptoMode`, `DEFAULT_NOISE_CRYPTO_MODE` |
| `@serfab/cadre-rn/native-digest` | `installNativeDigest(createHash)`, `nativeDigestActive()` |
| `@serfab/cadre-rn/native-ed25519` | `installNativeEd25519(nativeSubtle)`, `nativeEd25519Active()` |
| `@serfab/cadre-rn/polyfills` | Side effects only: the web APIs Hermes and React Native lack |
| `@serfab/cadre-rn/polyfills/native-crypto` | Side effects only: native Ed25519 and SHA-256/512 |
| `@serfab/cadre-rn/polyfills/webrtc` | Side effects only: `react-native-webrtc`'s `registerGlobals()` |
| `@serfab/cadre-rn/boot-check` | Side effects only, development builds only: the polyfill audit and the reload log |
| `@serfab/cadre-rn/metro` | CommonJS: `withCadreMetro(config, options)` |
| `"@serfab/cadre-rn"` in `app.json` `plugins` | The Expo config plugin (subpath `./app.plugin.js`, CommonJS) |

## Phone node

`createPhoneNode` is `@serfab/cadre-core/edge-node`'s `createEdgeNode` over the secure store and rn-leveldb ([The edge node](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#the-edge-node)). `PhoneNode`, `PhoneNodeOptions`, `PhoneNodeStatus` and the other names in this section are the edge node's types under the kit's names.

Call `createPhoneNode` once, at module scope. A second call over the same storage prefix throws while the first node is starting, joining or running. Register event handlers with `phone.on` before the first start: strands joined from another party arrive through `strand:discovered` after every start.

### Platform options

Passed to `createPhoneNode` and fixed for the app's lifetime. `PhoneNodePlatform` in `src/phone-node/node.ts` and `EdgeNodePlatform` in cadre-core are the full types.

| Option | Default | Meaning |
|---|---|---|
| `secureStore` | required | `expo-secure-store`, or an adapter with the same three methods (see [Key store and node-local records](#key-store-and-node-local-records)). |
| `secureStoreOptions` | none | One options object for the identity, the owner key and the anchor. Use `{ keychainAccessible: AFTER_FIRST_UNLOCK }` and no `requireAuthentication`. |
| `leveldb` | required | rn-leveldb's two constructors and its `destroyDB`, as under [First run](#first-run). |
| `names` | `DEFAULT_PHONE_NODE_NAMES` | Database prefix, node-local database name and record keys. Renaming one orphans installed phones' records. |
| `transports` | WebSockets and circuit relay | A function of the relay addresses. An app with WebRTC adds `webRTC({ rtcConfiguration: { iceServers: resolveStunServers(relayAddrs) } })`. |
| `listenAddrs` | `[]` (accepts nothing but a relayed connection) | A function of the relay addresses. An app with WebRTC passes the kit's `webrtcListenAddrs`, which names `/webrtc` whenever the phone has a relay, so a peer can open a direct connection to it. |
| `noiseCrypto` | libp2p-noise's JavaScript crypto | `{ build, defaultMode }`; see [Noise crypto](#noise-crypto). |
| `allowPrivateDial` | `true` | Dial loopback, private and plain `ws://` addresses, which libp2p's React Native connection gater refuses. |
| `ownerGenesisTimeoutMs` | 60 s | Bound on settling the owner key at a start or a join. |
| `dataVersion` | none | Saved with each successful start and reported by `loadSavedStart()` as `writtenBy`. |
| `configure(config)` | none | Called last with the generated `CadreNodeConfig`, to change what the options do not cover: strand filter, `requireSignedSchemas`, `linkRoundTripMs`. |

### Start options and the saved start

`PhoneNodeOptions` is what one start is made with: `partyId`, `bootstrapAddrs`, `relayAddrs`, and optionally `noiseCryptoMode`, `ownerKeyLabel` (default `phone`), `strandOfflineMode`, `origin` and `formerPartyId`. The kit saves the options of every successful start, so the app can start again unattended.

- **`relayAddrs`** are the circuit relays the node reserves on. With none, the node starts and dials out, but no other party can reach it ([Reachability](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md#reachability-configuring-a-relay)).
- **`origin`** is `'founded'` (or absent) for a party the app started itself, which settles the owner key on every start, and `'joined'` for one it joined, which never creates one. `joinCadre` saves `'joined'`. A start that names no `origin` takes the saved start's when it is for the same party.
- **`formerPartyId`** is the party this app founded and left by joining another. Its data stays on disk until `dissolveFormerParty()` deletes it.
- **`autoStart`** in the saved start is `true` after a successful start and `false` after `stop()`. A failed start saves nothing, so a mistyped address cannot replace the last options that worked. An OS kill leaves it `true`.

### Members

`EdgeNode` in `packages/cadre-core/src/edge-node/edge-node.ts` in the repository states each member's full contract.

| Member | What it does |
|---|---|
| `start(options)` | Starts the node, or joins a start in flight. A running node is returned as is, whatever its options. A failed start closes what it opened and leaves `status` `failed`. |
| `stop()` | The user's disconnect: saves `autoStart: false`, stops the node and closes every database it opened. |
| `restart(options)` | Rebuilds the node with new relays or a new Noise mode. Leaves `autoStart` set. |
| `setStrandOfflineMode(mode)` | Changes the offline mode of running and later strands, and saves it ([Offline mode](https://github.com/gotchoices/sereus/blob/master/docs/strands/writes.md#offline-mode)). Throws while no node runs. |
| `identityPeerId()` | This app's peer id, the same in every party. With no node running it reads the identity from the secure store, creating it on a fresh install. |
| `loadSavedStart()` | `{ options, autoStart, writtenBy? }` for the last successful start, or `undefined`. A read fault throws. |
| `on(event, handler)` | Subscribes to a node event on every node a start or restart builds. Returns an unsubscribe. |
| `status`, `onStatus(listener)` | `stopped`, `starting`, `joining`, `running` (with `owner`: `enrolled`, `member`, `failed` or `timed-out`), `removed`, or `failed` (with the error). |
| `node`, `options` | The running `CadreNode` and its start options; `null` unless running. |
| `unfinishedRemoval` | A removal of a party's local storage that the last start could not finish, or `null`. The next start retries. |
| `ownerPublicKey()` | The public key the running node signs with as an owner; `null` unless running with one wired. |
| `linkRequestSlot()`, `recommendationSlot()`, `nodeLocalRecords()` | Storage for the app-link and provider stores, in the node-local database. They work with no node running. |

The owner-key, owner-grant, join, strand-move and dissolve calls have sections of their own. Calls that change the node run one at a time, each waiting for the one in progress.

### The phone's owner key

The app holds at most one owner key, separate from its identity ([Owner keys](https://github.com/gotchoices/sereus/blob/master/docs/cadre/owner-keys.md)). It is kept in the secure store's owner slot (`DEFAULT_OWNER_KEY_ID`, `cadre/owner`) under the same ungated `secureStoreOptions` as the identity; a signer that prompts before signing is ticket `feat-owner-key-on-a-hardware-key`.

How a start settles it (`status.owner`):

- **Founded party with no owner yet.** The slot's key becomes the founding owner key under `ownerKeyLabel`, and the node signs with it (`enrolled`). The key is created unless the slot already holds one, such as a key an iOS reinstall kept in the Keychain.
- **Any other party.** The node signs with the slot's key when the party lists that key as a live owner (`enrolled`). Otherwise the app is a `member` and no key is created.

Apart from founding, the kit creates a key only when the app redeems or joins with an owner grant while the slot is empty.

The owner-key calls:

- **`listOwnerKeys()`** returns cadre-core's `CadreOwnerKey` rows, with label, voucher, `heldHere` and `trusted`.
- **`exportOwnerKey({ label?, passphrase? })`** returns the slot's key as `{ publicKey, exportText }`. It works with no node running and throws when the slot is empty.
- **`importOwnerKey(text, passphrase?)`** stores the key in the slot, and with a node running wires it when the party lists it (`{ wired: true }`). It throws `OwnerKeySlotOccupiedError` when the slot holds a different key, and `OwnerKeyExportError` for text that is not an owner key, a missing passphrase (`passphrase-required`) or a wrong one. One key imported on two devices signs on both.
- **`planOwnerKeyRemoval(key)`** and **`removeOwner(key, { revouch })`** are cadre-core's, for the removal prompt.

### Owner grants

An owner grant is a code whose holder becomes an owner of the cadre, with a key of its own ([Owner grants](https://github.com/gotchoices/sereus/blob/master/docs/cadre/owner-keys.md#owner-grants)). These calls throw while no node is running.

- **`createOwnerGrant({ label?, expiresInMs?, uses? })`** returns `{ grant, encoded, reach }`, signed by this app's key. The default is 15 minutes and one use; `expiresInMs: null` makes a backup grant with no expiry. `reach` says whether anyone could redeem it once this phone is gone.
- **`listOwnerGrants()`** returns every grant the node holds, with `live`, `withdrawn` and `usesRecorded`.
- **`withdrawOwnerGrant(key)`** returns `false` when the grant is not held here or was already withdrawn. Keys it already seated stay owners.
- **`redeemOwnerGrant(text)`** makes this app an owner of the running party with the owner slot's key, created when the slot is empty. It returns `{ ownerKey, alreadyOwner, wired }`.

`redeemOwnerGrant` results:

- **`alreadyOwner`**: the slot's key is a live owner already. Nothing is signed or written, so the grant spends no use.
- **`wired: false`**: this node is not a member machine, so another member redeemed for it, and the key's row had not arrived within `ownerGenesisTimeoutMs`. A later start wires it.
- **Errors**: `OwnerGrantRejectedError` (`party-mismatch`, or `grant-spent` for an expired, withdrawn or used grant), `OwnerKeyAddRefusedError` (`alone`, on a member with no connection to the others), `OwnerGrantIssuerUnknownError`, `OwnerGrantUnreachableError`, and the decoder's error for text that is not an owner grant.

### Joining another cadre

An app that runs its own one-node cadre joins the user's main cadre with `joinCadre`, which moves the node and keeps its identity ([An app joins an existing cadre](https://github.com/gotchoices/sereus/blob/master/docs/cadre/apps.md#an-app-joins-an-existing-cadre)).

`joinCadre` takes either credential. A machine invitation admits the app as a machine. An owner grant makes it a machine and an owner at once, which an app needs to bring along the strands of the party it founded.

```ts
import { decodeCadreInvitation, decodeOwnerGrant, OWNER_GRANT_PREFIX } from '@serfab/cadre-core';

const credential = pasted.startsWith(OWNER_GRANT_PREFIX) ? decodeOwnerGrant(pasted) : decodeCadreInvitation(pasted);
const cancel = new AbortController();   // a Cancel button calls cancel.abort()
const joined = await phone.joinCadre(credential, {
	signal: cancel.signal,
	onProgress: (p) => {
		if (p.state === 'waiting') show(p.reason);   // 'no-member-answered' | 'member-not-ready'
		else if (p.state === 'admitted') show('admitted; finishing');
		else if (p.state === 'moving-strands') show('moving your chats');
	},
});
```

- **Options**: `relayAddrs` and `noiseCryptoMode` (default: the running or saved start's), `signal`, and `onProgress`.
- **Result**: the redemption's result, plus `asOwner`, `formerPartyId` and `strandMove`.
- **While waiting**, `status` is `joining` and `phone.node` is `null`. Nothing is saved until a member admits the app, so an app killed while waiting relaunches into the party it left. `stop()` cancels a join.
- **On failure** (a refusal, an expiry reported as `invite-spent` or `grant-spent`, a cancel, or a failed start) it starts again what was running before and throws.

#### Moving the app's strands

When the app leaves a party it founded, `joinCadre` carries that party's strands, pending joins and invitations into the party it joins ([Moving the app's strands](https://github.com/gotchoices/sereus/blob/master/docs/cadre/apps.md#moving-the-apps-strands)). Leaving a party it joined moves nothing.

- **Before anything stops**, the kit exports the strands and keeps the bundle in the secure store, because it holds read secrets, party keys and bearer invitations.
- **`StrandsNeedOwnerJoinError`** refuses the join, with the party left running and unchanged, when there is something to move and the credential is a machine invitation: every row a move seats is owner-signed.
- **`result.strandMove`** is `{ state: 'done' | 'partial', report }`, or `{ state: 'deferred', reason }` with `reason` `'owner-key-not-wired'` or `'adoption-failed'` (and its `error`). It is absent when there was nothing to move. In `partial`, `report.failed` lists what is retried.
- **A deferred or partial move** is retried by every start whose owner key is wired, before it reports `running`, and at once by `finishStrandMove()`, which throws `StrandMoveNotOwnerError` while the app's key is not an owner there.
- **`pendingStrandMove()`** returns the move still waiting, or `undefined`: the party it moves to, the strands not seated there yet, and those that party refused permanently.

#### Dissolving the left cadre

Once the move has finished, `dissolveFormerParty()` deletes what the party the app founded and left still holds on the phone ([Dissolving the party it left](https://github.com/gotchoices/sereus/blob/master/docs/cadre/apps.md#dissolving-the-party-it-left)). The call stops the running node, reads the left party, and starts the running party again.

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

- **Refused before anything stops** with `StrandMovePendingError` while a move from that party waits, and with an `Error` when the node is not running with a `formerPartyId`.
- **Refused after the read**, with nothing deleted: `FormerPartyNotEmptyError` when the left party holds a strand or an open pending join the running party does not, or has a machine other than this app's node. The strand and join ids may be passed back as `discard`; other machines must be removed in the left party first.
- **Deleted**: the left party's control database, node-local records, trusted-owner anchor, joined-strand records and move record. Strand databases stay: a moved strand's database is the running party's copy.
- **A crash partway** is finished by the next start or call.

### Removed from the cadre

When an owner removes this app from its party (cadre-core's `cadre:removed`, [The removed machine learns of it](https://github.com/gotchoices/sereus/blob/master/docs/cadre/removing-machines.md#the-removed-machine-learns-of-it)), the kit acts on it, so the app only has to show it:

- **The node stops**, and the saved start becomes a start of `formerPartyId` with `autoStart: false`, or is deleted when there is none. Nothing starts unattended.
- **The party's local storage is deleted**, as a dissolve deletes it.
- **`status`** becomes `{ state: 'removed', partyId, removal, formerPartyId? }`. From there `start` and `joinCadre` work as from `stopped`: the app offers a return to its own cadre (`start((await phone.loadSavedStart())!.options)`) when `formerPartyId` is set, and a join otherwise.
- **An app that keeps its own copy of the start options** must drop it on `removed`: starting them builds the removed party again on empty storage.

A phone removed while its app was not running never receives the report, and keeps the party's data.

### Helpers

- **`attachStrandWhenWritable(node, config, { patienceMs? })`** calls `addStrand`, and when the first sync outlasts `addStrand`'s budget it waits for the strand to become writable, up to `patienceMs` (default `DEFAULT_STRAND_PATIENCE_MS`, 240 s).
- **`retryAfterRestart(write, { attempts?, delayMs? })`** retries a write the cohort did not answer, as the first writes after a node restarts alone are. Only that: a write a cohort member voted against is a verdict no backoff changes, and propagates on the first attempt. Defaults: 5 attempts, 3 s apart.

## Lifecycle

`createBackgroundRunner` (`@serfab/cadre-rn/lifecycle`) follows React Native's `AppState`.

```ts
import { AppState } from 'react-native';
import { createBackgroundRunner, phoneNodeLifecycle } from '@serfab/cadre-rn/lifecycle';

const runner = createBackgroundRunner({ ...phoneNodeLifecycle(phone), appState: AppState });
runner.onStateChange(() => render(runner.state, runner.resuming, runner.degraded));
runner.start();   // once the node is running; runner.stop() on logout
```

- **On `background`** it hibernates the node's strands and leaves the control connection up for as long as the OS allows. `state` becomes `background-connected`, then `background-hibernating` when the control network disconnects.
- **On `active`** it starts the node again if the OS killed it, then waits up to `settleTimeoutMs` (default 15 s) for the control network to reconnect. `resuming` is `true` meanwhile, and `degraded` is `true` if the wait ran out.
- **`inactive`** does nothing, and a later transition wins over an earlier one still in progress.

`phoneNodeLifecycle(phone)` supplies the runner's `getNode` and `ensureNode` from a `PhoneNode`. Its cold start uses the saved start, and only while `autoStart` is set, so a node the user stopped stays stopped. An app that must refresh its own state after a cold start passes its own `ensureNode`.

The runner never imports `react-native`: `AppState` is assignable to its `AppStateLike`. A push wake (FCM or APNs) is the app's own code.

## App links

`@serfab/cadre-rn/app-link` lets two Sereus apps on one phone hand a join request and its answer to each other as links, so the user confirms once in the owner app ([Between apps on one phone](https://github.com/gotchoices/sereus/blob/master/docs/cadre/apps.md#between-apps-on-one-phone)). The answer is a machine invitation, which admits the asking app as a machine only. An app with strands of its own to bring joins with an owner grant instead (ticket `decide-app-link-join-carries-ownership`).

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

- **`parseCadreLink(url)`** returns `{ kind, text }` with `kind` `join-request`, `join-response` or `recommended-by`, the text undecoded. Anything else is `null`, a node code or an invitation included.
- **`joinRequestLink(text, ownerApp)`** is the request text itself when `ownerApp` is `null` (Android, where the system chooser lists every app that handles it). With an owner app (iOS, which has no chooser) it is `<ownerApp.scheme>://cadre-join-request/<text>`.
- **`joinResponseLink(reply, response)`** is `<reply.scheme>://cadre-join-response/<response text>`. It throws for a web or system scheme, and throws `CadreLinkTooLongError` past `CADRE_LINK_MAX_LENGTH` (32,768 characters); the owner app then shows the invitation for copying.
- **`encodeCadreJoinResponse` and `decodeCadreJoinResponse`** are the answer's codec: the request's nonce, the answering app's unverified name, and either an `invitation` text or a `refused` reason (`denied`, `no-cadre`, `not-owner`, `already-member`).
- **`installedSereusApps(apps, ownScheme, canOpenURL)`** returns the apps whose scheme `canOpenURL` reports installed, the app's own excluded. On iOS a scheme missing from `LSApplicationQueriesSchemes` counts as not installed, with a warning naming it.

### The open request

`LinkRequestStore` is the asking app's guard against answers it did not ask for. Create one per app, over `phone.linkRequestSlot()`. The request is kept in the node-local database, so an asking app that the OS killed while the owner app was in front still takes the answer.

- **`begin(ownerAppName)`** opens a request, or returns the open one with its nonce unchanged, so an answer to an earlier tap still arrives.
- **`take(text)`** returns the decoded answer only when its nonce is the open request's, once, within `LINK_REQUEST_TTL_MS` (30 minutes). Otherwise it throws `UnsolicitedJoinResponseError`. A malformed answer throws the codec's error and leaves the request open.
- **`current()`** and **`cancel()`** read and close the open request. A slot read that fails throws.

The store's calls run one at a time, so two deliveries of the same link cannot both take the answer. Use one store per slot.

### Recommending another app

An owner app can recommend a Sereus app and approve its join in advance, so that app joins on its first launch without a second prompt ([Recommending another app](https://github.com/gotchoices/sereus/blob/master/docs/cadre/apps.md#recommending-another-app)). The pre-approval admits a machine only.

The owner app, which recommends:

```ts
import { Linking, Platform } from 'react-native';
import { AppRecommendationStore, recommendedByLink, storePageLink } from '@serfab/cadre-rn/app-link';

const recommendations = new AppRecommendationStore(phone.recommendationSlot());   // one per app

// The user picked `app` from the known list and allowed it.
await recommendations.approve({ scheme: app.scheme, appName: app.name, partyId });
const installed = await Linking.canOpenURL(`${app.scheme}://`);
const url = installed ? recommendedByLink(app, ownScheme) : storePageLink(app, Platform.OS === 'ios' ? 'ios' : 'android', ownScheme);

// Later, for a join request opened as a link, before prompting:
const approved = request.reply ? await recommendations.take(request.reply.scheme, partyId) : null;
// approved: mint the targeted machine invitation and answer by link, no prompt.
```

The recommended app reads the hint once, at first launch from the Play install referrer (through the app's own install-referrer module) or from a `recommended-by` link:

```ts
import { KNOWN_SEREUS_APPS, parseCadreLink, recommendedBySchemeFromReferrer } from '@serfab/cadre-rn/app-link';

const scheme = recommendedBySchemeFromReferrer(referrer) ?? (link?.kind === 'recommended-by' ? link.text : null);
const recommender = [...KNOWN_SEREUS_APPS, ...extraApps].find((app) => app.scheme === scheme);
// recommender: ask whether to join it, then send the join request to it as above, with recommender as ownerApp.
```

- **`AppRecommendationStore`** keeps the owner app's pre-approvals, one per scheme: `approve(entry)`, `live(partyId)`, `withdraw(scheme)` and `take(scheme, partyId)`. An entry lasts `RECOMMENDATION_TTL_MS` (one hour), is used up by one `take`, and is never returned for another party.
- **`storePageLink(app, platform, ownScheme)`** is the app's Play page on `'android'`, with the install referrer `sereus-recommended-by:1.<ownScheme>`, or its App Store page on `'ios'`, which has no referrer. It is `null` when the app has no store id for that platform.
- **`recommendedByLink(app, ownScheme)`** is `<app.scheme>://cadre-recommended-by/<ownScheme>`, for an app already installed.
- **`recommendedBySchemeFromReferrer(referrer)`** returns the scheme when the referrer is exactly that token, and `null` otherwise.

Trust neither hint: anyone can build a Play link with any referrer, and any app can open another with any link. Use a scheme only when the app's own known list has it, by exact equality, and show the name from that list.

### Adding an app to the known list

`KNOWN_SEREUS_APPS` has one entry per published Sereus app: `{ name, scheme }`, plus `androidPackage` and `iosAppStoreId` once it is in a store. A new app is added in `src/app-link/known-apps.ts` and in the copy in `app.plugin.cjs` (the plugin is CommonJS and cannot load the ESM build), and the kit is released. Until then the app passes itself as an extra, in the plugin's `appLinks.extraApps` and in the `apps` argument of `installedSereusApps`.

Every Sereus app needs a URL scheme of its own (`expo.scheme`). The answer comes back at it, and on iOS it is undefined which of two apps sharing a scheme opens a link.

## Provider

`@serfab/cadre-rn/provider` is what cadre-core's `provider/` module leaves to the app when it rents a node from a hosting provider: opening the system browser for the sign-in, keeping the tokens, and remembering which containers the app rented ([Renting a node from an app](https://github.com/gotchoices/sereus/blob/master/docs/hosting/provider.md#renting-a-node-from-an-app)).

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
const result = await rentNode(phone.node!, client);
```

- **`signInWithProvider({ descriptor, clientId, redirectUri, openAuthSession, scopes?, fetch? })`** runs the OAuth 2 with PKCE handshake and returns `ProviderTokens`, or `'cancelled'` when the browser closed without a redirect. It throws cadre-core's `ProviderAuthError` when the provider refuses, the redirect's state is not this sign-in's, or the token exchange fails.
- **`openAuthSession`** has the signature of `expo-web-browser`'s `openAuthSessionAsync`. A bare app passes an adapter that resolves `{ type: 'success', url }` on the redirect.
- **`redirectUri`** must be spelled exactly as the app registered it with the provider. With Expo Router, rewrite that path to a plain screen in `+native-intent`, so the single-use code is not kept in navigation state.
- **`providerTokensSlot(secureStore, providerId, options?)`** keeps one provider's token pair in the secure store, ungated: `load()` (`undefined` when none is stored or the record is unreadable; a denied read throws), `save(tokens)` and `clear()`.
- **`rentalStore(kv)`** over `phone.nodeLocalRecords()` is the app's record of its rentals by party: `list(partyId)`, `add(partyId, rental)`, `update(partyId, containerId, { peerId?, finished? })` and `remove(partyId, containerId)`.

cadre-core's `rentNode` persists nothing. An app records the container when the provider creates it (`finished: false`), marks it finished when `rentNode` or `finishRental` returns, and on its next launch offers to finish any record still unfinished, as `recordingClient` in `packages/reference-app-rn/src/rentals.ts` does.

## Key store and node-local records

These two subpaths are for an app that builds its node without `createPhoneNode`, which wires all of this itself.

cadre-core asks its host for a `KeyStore`, and for a `DurableSlot` behind each node-local store: `trustedOwners`, `bootstrapPeers`, `enrolledMachines` and `strandNetworkState`. Left out, each falls back to memory.

Both subpaths reach the secure store through `SecureStoreApi`: `getItemAsync`, `setItemAsync` and `deleteItemAsync` over string values. `expo-secure-store` is assignable to it. A bare React Native app passes an adapter that keeps the same contract: `null` for an absent key, a throw for a denied or failed read.

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

- **`SecureStoreKeyStore(secureStore, options?)`** throws cadre-core's `KeyStoreAccessError` for a read the store refuses, and returns `undefined` only for an absent slot.
- **`secureStoreSlot(secureStore, key, options?)`** is a `DurableSlot` over one secure-store entry, for the trusted-owner anchor. It throws at construction for a gated slot.
- **`kvStoreSlot(kv, key)`** is a `DurableSlot` over one key of a key-value store, flushed on each save. `nodeLocalKv` in the example is a `LevelDBKVStore` from `@optimystic/db-p2p-storage-rn` over a LevelDB database of the app's own.
- **Record keys**: `anchorSlotKey`, `bootstrapPeersKvKey`, `enrolledMachinesKvKey`, `strandNetworkKvKey` and `rentalsKvKey`, each a function of the party id.

A `LevelDBKVStore` holds each write in memory until it is flushed. Keep one per open database for every slot to share, and `close()` it before the database. [Where node state is kept](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md#where-node-state-is-kept) explains which record goes in which store and why the stores are ungated.

## Polyfills and boot check

Import the polyfill entry points before anything else, in the order shown under [First run](#first-run). [Polyfills](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md#polyfills) lists every global each one patches, which library needs it, and why each import has its position.

`/boot-check` acts only in development builds. It prints the table `[cadre-rn] polyfill audit`, warns with `[cadre-rn] MISSING globals` when a global is absent, and logs `[reload] <reason>` before any reload started from JavaScript.

## Metro

`withCadreMetro(config, options)` (`@serfab/cadre-rn/metro`, CommonJS) takes the config the app's toolchain produced, adds the Sereus settings and returns it.

| Option | Meaning |
|---|---|
| `projectRoot` | The app's directory (`__dirname`). The kit's peers and `@babel/runtime` resolve from here. |
| `linkedRoots` | Optional. Local checkouts whose packages are linked into the app (a monorepo root, sibling repositories). Each is watched, and its `node_modules` is searched after the app's own. |

It adds symlink support, aliases for the Node built-ins libp2p imports, and a `resolveRequest` that keeps one copy of each native module in the bundle and selects the libp2p variants that run on a phone. It keeps what the incoming config already set: lists are appended to, an alias the app already has wins, and an existing `resolveRequest` is called by the new one. It relies on the toolchain enabling package exports, which both do by default, and leaves condition names to the app.

[Metro configuration](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md#metro-configuration) describes each setting and its reason, and the requirement that `@babel/runtime` be 7.29.2 or newer.

## Config plugin (Expo)

An Expo app lists the kit under `plugins` in `app.json`. At prebuild the plugin sets `android:usesCleartextTraffic="true"` on the `<application>` element of the Android manifest, without which an Android release build can dial no `/ws` address ([Release builds need cleartext WebSocket](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md#release-builds-need-cleartext-websocket)).

- **It overrides `false`** in the app's own manifest.
- **Against another plugin, the one listed first wins**, as with `expo-build-properties`' `android.usesCleartextTraffic`, because Expo runs manifest changes in reverse order of the list.
- **A network security config takes precedence.** Android follows an `android:networkSecurityConfig` file over the manifest flag, so an app whose file forbids cleartext must permit it there. The plugin does not edit that file.

The plugin changes nothing on iOS, and installs nothing from Expo: it resolves `expo/config-plugins` from the app's project root.

A bare React Native app, with no prebuild, adds the attribute by hand:

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<application android:usesCleartextTraffic="true" ...>
```

### `appLinks`: links between Sereus apps

The native settings [App links](#app-links) needs. Without the option, the plugin sets only the cleartext attribute.

```json
{ "expo": { "scheme": "my-sereus-app", "plugins": [["@serfab/cadre-rn", { "appLinks": true }]] } }
```

`"appLinks": { "extraApps": [{ "name": "My Other App", "scheme": "my-other-app" }] }` adds Sereus apps not yet in the kit's known list. An extra may also carry `androidPackage` and `iosAppStoreId`.

- **Android.** The main activity gets a `VIEW` intent filter (`DEFAULT`, `BROWSABLE`) for the scheme `sereus-join-request`, so opening a join request lists the app in the system chooser. The manifest gets `<queries>` entries for that scheme and for each known and extra app's scheme, so that on Android 11 and later `canOpenURL` can see the other apps.
- **iOS.** The schemes of the known and extra apps are added to `LSApplicationQueriesSchemes`, keeping the entries already there. The prebuild fails when the list passes 50 schemes, the most iOS reads.
- **A misspelt option or a malformed extra app fails the prebuild.**

A bare React Native app adds the intent filter and the `<queries>` entries to `AndroidManifest.xml`, and the schemes to `Info.plist`, by hand.

## Noise crypto

`buildNoiseCrypto(mode)` (`@serfab/cadre-rn/noise-crypto`) returns an implementation of libp2p-noise's crypto interface backed by `react-native-quick-crypto`, in place of the pure-JavaScript one Metro otherwise bundles ([Native crypto](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md#native-crypto)). Pass it to `createPhoneNode` as `noiseCrypto: { build: buildNoiseCrypto, defaultMode }`. An app that builds its own config sets `network.noiseCrypto: buildNoiseCrypto(mode)`.

| Mode | Effect |
|---|---|
| `'off'` | Returns `undefined`: Noise keeps its pure-JavaScript default. |
| `'symmetric'` (`DEFAULT_NOISE_CRYPTO_MODE`) | Native SHA-256 and ChaCha20-Poly1305, the per-frame costs. X25519 stays pure JavaScript. |
| `'full'` | Also native X25519 key generation and Diffie-Hellman. |

- **The mode is read when the node is built.** Changing it means `phone.restart` with a new `noiseCryptoMode`.
- **`defaultMode` fills in a start that names no mode**, and the filled-in mode is saved with the start, so a device keeps its mode when a new build changes `defaultMode`.
- **Loading this subpath also installs the native digest**, with quick-crypto's `createHash`.

## Native digest and Ed25519

`@serfab/cadre-rn/polyfills/native-crypto` is the import most apps use: it installs both `installNativeDigest` and `installNativeEd25519` from `react-native-quick-crypto` at boot, before anything imports libp2p. The two functions are also exported separately; neither imports a native module.

- **`installNativeDigest(createHash, subtle?)`** (`/native-digest`) replaces the `crypto.subtle.digest` that `/polyfills` installed with one over a Node-style `createHash`, for SHA-256 and SHA-512, and leaves any other digest alone. It checks the hash against a known SHA-256 vector first and keeps the JavaScript digest, with a warning, if the check fails. It returns `'installed'`, `'already'`, `'not-polyfilled'` or `'check-failed'`.
- **`installNativeEd25519(nativeSubtle, subtle?)`** (`/native-ed25519`) installs `generateKey`, `importKey`, `exportKey`, `sign` and `verify` from a native WebCrypto when the global `crypto.subtle` lacks any of them. It installs the five as a set, because a `CryptoKey` from one implementation is unusable by another's `sign`. It returns `'installed'`, `'already'`, `'not-needed'` or `'unavailable'`.
- **`nativeDigestActive()`** and **`nativeEd25519Active()`** report whether each is in place.

## What it stores on the device

The LevelDB names are the defaults (`DEFAULT_PHONE_NODE_NAMES`), which the `names` platform option overrides.

| Where | Default name | Holds |
|---|---|---|
| Secure store | keys under `sereus.ks.` | The identity, the owner key, joined-strand and strand-move records |
| Secure store | `sereus.anchor.<party>` | The party's trusted-owner anchor |
| Secure store | `sereus.provider-tokens.<provider>` | One provider's tokens |
| LevelDB | `sereus-node-local` | The saved start and the other node-local records |
| LevelDB | `sereus-<scope>` | One per storage scope: the control database and each strand |

[Where node state is kept](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md#where-node-state-is-kept) lists every record and what survives a reinstall.

## Further reading

- [Running a node in a React Native app](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md)
- [Several apps in one cadre](https://github.com/gotchoices/sereus/blob/master/docs/cadre/apps.md)
- [cadre-core API guide](https://github.com/gotchoices/sereus/blob/master/docs/api.md)
- [The reference apps](https://github.com/gotchoices/sereus/blob/master/docs/platforms/reference-apps.md)
