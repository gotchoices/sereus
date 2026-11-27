# @serfab/cadre-client

Cadre management for a Sereus app, without UI: the person's **cadrons** (the machines of their
cadre), claiming a node by its code, removing one, backing up the owner key, relays, whether
anybody can reach this device, and which cadrons an invitation names. Every operation returns a
result instead of throwing; each piece of screen state is a store any UI framework binds to.

The model behind it: [The cadre client](https://github.com/gotchoices/sereus/blob/master/docs/cadre/cadre-client.md).

## Install

```sh
yarn add @serfab/cadre-client @serfab/cadre-core
```

`@serfab/cadre-core` is a peer dependency: the app brings its own, one copy.

## Entry points

- **`@serfab/cadre-client`** loads no cadre-core code. Types (`Cadron`, `CadreStatus`,
  `Reachability`, `CadronPreferences`, `BootstrapPlan`, `InvitationText`, …), results
  (`CadreResult`, `cadreOk`, `cadreFail`), node-code text (`isNodeCode`, `nodeCodeFromUrl`),
  address judgement (`addressKind`, `nodeReach`), the pure planner (`planBootstrap`,
  `describeInvitation`) and stores (`cadreStore`, `reachabilityStore`,
  `invitationReadinessStore`, `writable`, `loader`).
- **`@serfab/cadre-client/sereus`** works over a running node: `createCadreClient(host)`,
  `edgeNodeHost(edge, options)`, `readNodeCode`, `classifyClaimFailure`.

## Using it

On cadre-core's edge node (React Native with `@serfab/cadre-rn`'s `createPhoneNode`, the web or
NativeScript with `createEdgeNode`) the host is ready-made:

```ts
import { createCadreClient, edgeNodeHost } from '@serfab/cadre-client/sereus';
import { cadreStore, reachabilityStore } from '@serfab/cadre-client';

const client = createCadreClient(edgeNodeHost(phone, { ownerKeyStore, preferences: mySlot }));

const cadrons = cadreStore(client);           // { state, value: CadreStatus, error }
const reach = reachabilityStore(client);      // { state, value: Reachability, error }

await client.cadre.inspectNodeCode(scanned);  // preview, for the person to approve
await client.cadre.claimNode(scanned);        // after they approve
const who = await client.invitable();         // before minting a strand invitation
```

`preferences` is any `{ load(): Promise<string | undefined>; save(text): Promise<void> }`; without
it, cadron preferences last for the session. An app with its own node service implements
`CadreHost` itself.

### Invitations

```ts
await client.invitations.setPreferences({ preferred: [homePeerId], names: { [homePeerId]: 'home' }, maxAddrs: 2 });

const inv = await node.createOpenInvitation(sAppId, validForMs);
const token = node.encodeInvitation(await client.invitations.withBootstrap(inv));

const ready = invitationReadinessStore(client, strandId, { newStrand: true }); // 'waiting' → 'ready'
const words = await client.invitations.describe(token, link);               // per address: cadron, kind, host, port
const plan = await client.invitations.bootstrapPlan();                      // the list and its warnings, before minting
```

`CadronPreferences`: `preferred` (peer ids, in order), `names`, `maxAddrs` (1–8, default 2),
`thisDevice` (`'fallback'` default, `'always'`, `'never'`), `allowPrivate` (default false).

### Binding a store

A store follows the Svelte store contract plus `get()`, and is reference-counted (it reads,
subscribes and polls only while something is subscribed):

- **Svelte:** `$cadrons`.
- **React / React Native:** `useSyncExternalStore(store.subscribe, store.get)`.
- **NativeScript:** copy each value into an `Observable` from `subscribe`.

Errors carry a stable `kind` (and sometimes a `reason`) for an app's own string catalog, and an
English `message` for logs.

## Using it from source before a release

From a clone of this repository, build it (`yarn workspace @serfab/cadre-client build`), then:

- **Node or web app:** `"@serfab/cadre-client": "portal:../sereus/packages/cadre-client"`. A
  `portal:` honours the peer dependency, so the app's own cadre-core is used.
- **React Native app:** Metro does not follow links outside the project. Add the package folder to
  `watchFolders`, and resolve `@serfab/cadre-core` (and the libp2p packages) from the app's own
  `node_modules` so one copy is bundled; or install a packed tarball (`npm pack`, then a `file:`
  dependency), repacking after each change.

## Rules the package keeps

- Imports only `@serfab/cadre-core`, `@multiformats/multiaddr` and its own files; the stack-free
  entry point imports no cadre-core (`test/standalone.spec.ts`).
- No UI, no platform module, no host globals beyond timers and `console` (`src/globals.d.ts`).
- English only in `message`; everything a UI shows comes from a code.
