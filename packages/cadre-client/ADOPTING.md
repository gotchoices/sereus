# Adopting @serfab/cadre-client in an app

For whoever wires cadre management into a Sereus app (a person or an agent). The model behind it
is [The cadre client](https://github.com/gotchoices/sereus/blob/master/docs/cadre/cadre-client.md);
the API summary is the [README](README.md); screens to copy are in [examples/](examples/README.md).

## 1. Install

**After a sereus release that includes the package:** `yarn add @serfab/cadre-client`, at the
same version as the app's `@serfab/cadre-core`. Nothing below applies any more.

**Until then**, the package exists only in the sereus repository (`packages/cadre-client`, on
`master`). It is a peer of cadre-core, so the one rule is: **the app's cadre-core and
cadre-client's cadre-core must be the same copy.** Which way satisfies it depends on where the
app takes the rest of the stack from.

| The app takes cadre-core, Optimystic, Quereus… from | Take cadre-client from | Spec |
|---|---|---|
| **Local clones** (a "local stack" mode: `portal:` or `link:` to `ser/sereus/packages/cadre-core` and the rest) | the same sereus clone, linked like the others | `"@serfab/cadre-client": "portal:../sereus/packages/cadre-client"` |
| **npmjs.org** (published versions) | a tarball packed from a sereus clone | `"@serfab/cadre-client": "file:.local-packages/serfab-cadre-client.tgz"` |
| — | or wait for the release | — |

**Never mix them**: cadre-client linked from the clone while cadre-core comes from npm. Through
a link, cadre-client's own `import '@serfab/cadre-core'` resolves from where its files really are,
the clone's workspace, so the app ends up with two copies: TypeScript sees two `CadreNode` types,
and at run time `instanceof` fails across them (a refused claim is no longer recognised as one).

### Linked, with a local stack

- Keep the sereus clone pulled and **built**: the link points at its `dist`
  (`yarn workspace @serfab/cadre-client build` in the clone, or the whole repo's `yarn build`).
- Link it the way the app links cadre-core. In a React Native app that means whatever its Metro
  config already does for the local stack (watch folders, source aliases): add cadre-client to the
  same lists.
- A change in the clone shows up after a rebuild there; no reinstall.

### A tarball, with the stack from npm

```sh
(cd ../sereus/packages/cadre-client && yarn build && yarn pack --out "$OLDPWD/.local-packages/serfab-cadre-client.tgz")
```

- In `package.json`: `"@serfab/cadre-client": "file:.local-packages/serfab-cadre-client.tgz"`,
  then `yarn install`. Add `.local-packages/` to `.gitignore`.
- Installed by copy, its peer resolves from the app's own `node_modules`: one cadre-core. React
  Native needs no Metro changes.
- `yarn pack` rewrites the `workspace:^` peer range to the released one (`^1.25.0`).
- After a change to the package: repack, then `yarn install` again.

## 2. Create the client

**On cadre-core's edge node** (React Native with `@serfab/cadre-rn`'s `createPhoneNode`, or
`createEdgeNode` on the web and NativeScript):

```ts
import { createCadreClient, edgeNodeHost } from '@serfab/cadre-client/sereus';

const client = createCadreClient(edgeNodeHost(phone, {
	ownerKeyStore,                       // the kit's SecureStoreKeyStore: lets the person back up the owner key
	preferences: {                       // where cadron preferences live; AsyncStorage on React Native
		load: async () => (await AsyncStorage.getItem('cadronPreferences')) ?? undefined,
		save: text => AsyncStorage.setItem('cadronPreferences', text),
	},
}));
```

**With a node service of the app's own** (a hand-built `CadreNode`), implement `CadreHost` from
`@serfab/cadre-client/sereus`: `node` (the running node or null), `on` (node events, re-attached
across restarts), `getRelayAddrs` / `applyRelays`, `partyId`, `ownerEnrolled`, `relayStatus`,
`onReachabilityChange`, and optionally `ownerKeyStore` and `preferences`. Each member is a line or
two over the service. Create the client once, for the app's lifetime.

## 3. The cadre screen

| Show or do | Call | Store |
|---|---|---|
| This device and its cadrons, with a status dot each | `client.cadre.status()` | `cadreStore(client)`; `cadronPresence(machine)` per row |
| Add a cadron from its code (scanned or pasted) | `cadre.inspectNodeCode(text)`, then after the person approves `cadre.claimNode(text)` | |
| Remove a cadron | `cadre.removeMachine(peerId)` | |
| Back up the owner key (behind a confirmed, private reveal) | `cadre.exportOwnerKey()` | |
| Relays | `client.relays.get()` / `set(addrs)` | |
| Whether anybody can reach this device | `client.reachability.get()` | `reachabilityStore(client)` |
| Preferred cadrons, their names, addresses per invitation | `client.invitations.preferences()` / `setPreferences(changes)` | re-read on `client.changes.invitations` |

Rules for the screen:

- **Never claim on a code alone.** A link or QR code can come from anyone: show what
  `inspectNodeCode` says (the cadron's short id, whether it is reachable from anywhere) and claim
  only after the person approves.
- **Never log a node code or an invitation link**; they carry secrets. Log peer ids.
- **The status dot:** connected (green) means this device holds a connection to the cadron now;
  recent (amber) that it is running elsewhere. Another phone usually shows recent, not connected.

## 4. Invitations

Wherever the app mints a strand invitation, route it through the client, and show its readiness
and details beside it:

```ts
const who = await client.invitable();                      // somebody must be able to answer
if (!who.ok) return explainUnreachable(who.error);          // kind 'unreachable': suggest a relay or a cadron

const invitation = await node.createOpenInvitation(sAppId, validForMs);
await node.publishFormationInvite(invitation.token, sAppId, { expiresAtMs, strandId, totalUses: 1 });
const token = node.encodeInvitation(await client.invitations.withBootstrap(invitation));
// the link the app shares carries `token`
```

- **`withBootstrap`** replaces cadre-core's address list with the person's cadrons that reach from
  anywhere (preferred first, at most their `maxAddrs`). It never fails: on any problem it returns
  the invitation as it came.
- **Readiness:** `invitationReadinessStore(client, strandId, { newStrand })`, with `newStrand: true`
  when this invitation founded the strand just now. Show "ready to hand out" only on `ready`; on
  `no-cadron`, say only this device can answer.
- **The readable invitation:** `client.invitations.describe(token, link)`, behind a "What's in this
  invitation" control.
- **The QR code:** let a tap open it full screen, dark on white.

## 5. Errors

Every operation returns `CadreResult<T>`; render `error.kind` (and `reason` where given) through
the app's own strings, and fall back to `error.message`. `CADRE_ERROR_KINDS` lists every kind for a
catalog: `unreachable`, `unavailable`, `invalid-node-code` (`reason`: `not-node-code`,
`newer-version`, `damaged`), `node-unreachable` (`reason`: `anywhere`, `home-network`),
`claim-refused`, `claim-failed` (`reason` `busy`), `not-supported`, `unexpected`. `retryable` says
whether trying again can help.

## 6. Checklist

- [ ] One `@serfab/cadre-core` in the app (the package is a peer, not a second copy).
- [ ] The client created once, with `ownerKeyStore` and `preferences`.
- [ ] The cadre screen: status dots, add with approval, remove, owner key backup, relays.
- [ ] Invitations minted through `withBootstrap`; readiness shown with the right `newStrand`.
- [ ] Error kinds in the app's string catalog.
- [ ] No node code or invitation link in logs.

## Not covered yet

Joining an existing cadre from a second app (`EdgeNode.joinCadre`, strand move, dissolving the
former party), cadre invitations and join approvals, owner keys beyond backup, and machine removal
through `planMachineRemoval`. Each is cadre-core API the package does not wrap yet; see
[Several apps in one cadre](https://github.com/gotchoices/sereus/blob/master/docs/cadre/apps.md).
