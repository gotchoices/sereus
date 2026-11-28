# @serfab/cadre-client

Cadre management for a Sereus app, without UI: the person's **cadrons** (the machines of their
cadre), claiming a node by its code, removing one, backing up the owner key, relays, whether
anybody can reach this device, and which cadrons an invitation names. Every operation returns a
result instead of throwing; each piece of screen state is a store any UI framework binds to.

The model behind it: [The cadre client](https://github.com/gotchoices/sereus/blob/master/docs/cadre/cadre-client.md).
Wiring it into an app, step by step: [ADOPTING.md](ADOPTING.md). Screens to copy (React Native,
Svelte, NativeScript): [examples/](examples/README.md).

## Install

```sh
yarn add @serfab/cadre-client @serfab/cadre-core
```

`@serfab/cadre-core` is a peer dependency: the app brings its own, one copy.

## Entry points

- **`@serfab/cadre-client`** loads no cadre-core code. Types (`Cadron`, `CadreStatus`,
  `Reachability`, `CadronPreferences`, `BootstrapPlan`, `InvitationText`, …), results
  (`CadreResult`, `cadreOk`, `cadreFail`), node-code text (`isNodeCode`, `nodeCodeFromUrl`) and the
  one-slot `nodeCodeInbox`,
  address judgement (`addressKind`, `nodeReach`), the pure planner (`planBootstrap`,
  `describeInvitation`) and stores (`cadreStore`, `reachabilityStore`,
  `invitationReadinessStore`, `writable`, `loader`; `cadreStore(view, { pollMs })`).
- **`@serfab/cadre-client/sereus`** works over a running node: `createCadreClient(host)`,
  `edgeNodeHost(edge, options)`, `readNodeCode`, `classifyClaimFailure`.
- **`@serfab/cadre-client/app-link`**: two Sereus apps on one device handing a join request and its
  answer to each other by link, and recommending an app: the link builders and parser, the
  response codec, `installedSereusApps(canOpenURL)`, `LinkRequestStore`, `AppRecommendationStore`.
  The platform registers the URL schemes and listens for links (on React Native, `@serfab/cadre-rn`).
- **`@serfab/cadre-client/lifecycle`**: `createBackgroundRunner`, hibernating the node in the
  background and resuming it on return, over the platform's app-state events (`AppStateLike`).

## Using it

On cadre-core's edge node (React Native with `@serfab/cadre-rn`'s `createPhoneNode`, the web or
NativeScript with `createEdgeNode`) the host is ready-made:

```ts
import { createCadreClient, edgeNodeHost } from '@serfab/cadre-client/sereus';
import { cadreStore, reachabilityStore } from '@serfab/cadre-client';

const client = createCadreClient(edgeNodeHost(phone, { ownerKeyStore, preferences: mySlot }));

const cadrons = cadreStore(client);           // { state, value: CadreStatus, error }; each cadron's
                                              // `connected`, `lastSeenAt` → cadronPresence(m): a status dot
const reach = reachabilityStore(client);      // { state, value: Reachability, error }

await client.cadre.inspectNodeCode(scanned);  // preview (peer, reach, this cadre's id and owner fingerprint) to approve
await client.cadre.claimNode(scanned);        // after they approve
const who = await client.invitable();         // before minting a strand invitation
```

### Adding and removing cadrons

```ts
await client.cadre.connectNode('/dns4/node.example.com/tcp/443/wss/p2p/<peerId>'); // a node listening for seeds:
                                              // authorized, seed delivered (or returned to hand over another way)
await client.cadre.createSeed();              // for a node not created yet; authorizes nothing

const plan = await client.cadre.planRemoval(peerId);     // invitations it closes, closed strands re-keyed
await client.cadre.removeMachine(peerId);                // the complete removal; `removal-refused` for self / no owner key
client.changes.removed(peerId => forgetSavedAddresses(peerId)); // here, or found gone on a re-read

const inbox = nodeCodeInbox();                // hold a code that arrives before the screen can show it
linking.onUrl(url => inbox.offer(url));       // the app's link listener
```

`preferences` is any `{ load(): Promise<string | undefined>; save(text): Promise<void> }`; without
it, cadron preferences last for the session. The text is opaque to the app (it carries its own
format version). An app with its own node service implements `CadreHost` itself
([ADOPTING.md](ADOPTING.md) has one over a plain `CadreNode`); `CadreHost.exportOwnerKey` serves an
app that keeps the owner key its own way.

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

Until a sereus release includes it, take it from a sereus clone. The app's cadre-core and this
package's must be the same copy, so:

- **The app runs the whole stack from local clones** (a local-stack mode: cadre-core, Optimystic,
  Quereus by `portal:` / `link:`): link this package from the same clone,
  `"@serfab/cadre-client": "portal:../sereus/packages/cadre-client"`, built (`yarn build` there).
- **The app takes the stack from npm:** install a packed tarball (`yarn build && yarn pack --out
  <app>/.local-packages/serfab-cadre-client.tgz` here, then `"file:.local-packages/serfab-cadre-client.tgz"`
  in the app). Repack and reinstall after each change.
- **Never link it while cadre-core comes from npm:** its cadre-core import would resolve to this
  repository's copy, a second one (two `CadreNode` types, `instanceof` failing across them).

Step by step: [ADOPTING.md](ADOPTING.md), "1. Install".

## Rules the package keeps

- Imports only `@serfab/cadre-core`, `@multiformats/multiaddr` and its own files; the stack-free
  entry point imports no cadre-core (`test/standalone.spec.ts`).
- No UI, no platform module, no host globals beyond timers and `console` (`src/globals.d.ts`).
- English only in `message`; everything a UI shows comes from a code.
