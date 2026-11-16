# Owner keys

An owner key is the signing key that authorizes changes to a cadre's control database. This document covers what the key decides, how an app lets a node sign with one, how a key is exported and imported, how an owner grant seats a new key, and how a key is removed. App developers need the calls and what they promise; maintainers need the reasons.

See also: [Who a node trusts and admits](control-security.md) for how a machine decides which owner keys to believe, [Adding and removing machines](membership.md), [Removing a machine](removing-machines.md), [The control schema](control-schema.md), and the [cadre-core API guide](../api.md).

## What an owner key is

An **owner key** is an Ed25519 key a person holds. Its signature authorizes the control-database writes that change who and what belongs to the party: admitting or inviting a machine, publishing the party's strands and joins, and adding or removing other owner keys. The control schema verifies each such signature against the `OwnerKey` table ([How a row proves it belongs](control-schema.md#how-a-row-proves-it-belongs)).

- **Independent of machines.** A machine's network identity (its libp2p key, behind its peer id) is never an owner key, and no owner key is derived from one. No code finds an owner key from a peer id, or a peer id from an owner key.
- **Several per person.** A user typically holds one on the phone plus backups. Each is an `OwnerKey` row with an optional label the user chose ("phone", "paper backup"). The label is bound into the signature that adds the key, so the control database records what the user called the key and never where it is kept.
- **Kept by the embedding app.** The private key lives in the `KeyStore` the app supplies, in a slot of its own (`cadre/owner`) beside the node identity slot (`cadre/identity`). On a phone that store is the platform vault; on a cadre-cli server it is the owner key file.
- **Servers do not normally hold one.** An always-on node holds an owner key only when the user deliberately gives it one (`cadre start --owner` or `--owner-grant`). cadre-host and cadre-provider never hold one.
- **One key, several cadres.** Every owner signature binds the party id, so an approval for one cadre never verifies in another. Every signing request names the cadre, so a prompt can show it.

## What an owner key decides, and what it does not

- **Machine admission.** A machine is a member because an owner signed its `CadrePeer` row (**vouched** it) or because it redeemed a cadre invitation, never because its own key is an owner. A phone that holds an owner key vouches its own machine's row with that key, as it would any other machine's.
- **Becoming an owner is its own credential.** An [owner grant](#owner-grants) seats a key as an owner and admits no machine. A [cadre invitation](membership.md#cadre-invitations) admits a machine and grants no ownership. No credential makes a machine's identity key an owner.
- **Machine removal leaves owner keys alone.** A lost phone that held an owner key can still sign after `removeMachine`, including a fresh invitation for itself. An app therefore offers removing the phone's owner key next to removing the machine ([Removing a machine](removing-machines.md)).
- **Strand founding belongs to a machine.** `Strand.FounderOwnerKey` records which owner key signed the strand's row. `Strand.FounderPeerId`, bound into the same signature, names the machine that runs the founder bootstrap, so two machines holding one owner key never both found the strand ([Strand membership bootstrap](../strands/membership.md#strand-membership-bootstrap)).
- **Dial preference is not ownership.** Seeds and the control cohort prefer always-on machines and the machine that minted the seed. Neither preference says who is an owner.
- **Trust anchors hold keys, not machines.** A machine's trusted-owner anchor, an invitation's `ownerKeys` and an operator's `--pin-owner-key` are owner keys, and nothing maps them to peer ids ([The trusted-owner anchor](control-security.md#the-trusted-owner-anchor)).
- **A machine with no owner key is a full member.** Always-on nodes and member phones sync, serve strands and redeem invitations without one. Only the owner-signed writes need a signer.

## The owner signer

An app gives a started node an `OwnerSigner` with `CadreNode.useOwnerSigner(signer)`. From then on the node can make owner-signed writes, and `isOwner()` is true while the signer's key is a live `OwnerKey` row. A node with no signer refuses every owner action. An app built on the edge node (`createEdgeNode`) does none of this itself: the edge node wires the owner slot's key at start.

cadre-core needs owner signatures, never an owner private key. An `OwnerSigner` ([`owner-signer.ts`](../../packages/cadre-core/src/owner-signer.ts)) is the key's public half plus `approve(request, body)`. The node calls `approve` once per owner action: `request` names the party and the action in plain words, and `body` receives a function that signs message bytes. A machine removal that signs many rows is still one call, so a backend that asks the user (a hardware key that signs on touch, a vault behind biometrics) prompts at most once per action. A declined prompt rejects with `OwnerSigningDeclinedError`.

This example is adapted from the edge node's start (`enrollFoundedOwner` in [`edge-node/config.ts`](../../packages/cadre-core/src/edge-node/config.ts)):

```typescript
import { createOwnerKey, loadOwnerSigner } from '@serfab/cadre-core';

const controlDb = node.getControlDatabase()!;
const held = await loadOwnerSigner(keyStore);
if (await controlDb.hasOwnerKey()) {
	// The party has an owner already: wire this device's key only if the party lists it.
	if (held) await node.wireOwnKeyIfOwner(held);
} else {
	// Founding: seat the first owner key, then sign with it.
	const founding = held ?? (await createOwnerKey(keyStore));
	if (await controlDb.ensureOwnerKey(founding.publicKey, 'phone')) {
		await node.useOwnerSigner(founding);
	}
}
```

### Wiring rules

- **One signer per node.** A second `useOwnerSigner` call throws. `getOwnerSigner()` returns the wired signer or null.
- **Wiring anchors the key.** `useOwnerSigner` records the signer's key in the node's trusted-owner anchor as `genesis`, whether or not the party lists it. Call it directly only for a key the node has just seated as the founding row. Everywhere else call `wireOwnKeyIfOwner(signer)`, which wires the key only when it is a live `OwnerKey` row and otherwise changes nothing, so a machine that joined someone else's cadre never anchors its own key.
- **Not on a node waiting to be claimed.** A node started with `claim` refuses `useOwnerSigner`: its claimant owns it ([Claiming a node](membership.md#claiming-a-node)).
- **`initializeSeedBootstrap(privateKeyB64)`** is `useOwnerSigner` over a software signer, for an embedder that holds the key as a base64url seed.

### Signer backends

- **Software** (`softwareOwnerSigner`) signs with a private key held in memory and never prompts. The key-store backend is built on it.
- **Key store** (`createOwnerKey`, `importOwnerKey`, `loadOwnerSigner` in [`owner-key-store.ts`](../../packages/cadre-core/src/owner-key-store.ts)) keeps the key in the owner slot of a `KeyStore` ([Node key material and the KeyStore](node.md#node-key-material-and-the-keystore)). Reading an empty owner slot never creates a key, unlike the identity slot: an owner key exists because the user made or imported one.
- **Owner key file.** cadre-cli reads the key from `owner.keyFile` (default `owner.key` in the node-state directory) and refuses a path that is also the identity key file ([cadre-cli README](../../packages/cadre-cli/README.md)).

Nothing replaces a key the slot already holds, because losing that key loses every cadre that lists it. Creating over an occupied slot, or importing a different key, throws `OwnerKeySlotOccupiedError`. Importing the key already in the slot changes nothing.

The algorithm is Ed25519 on every platform. The iOS Secure Enclave signs only P-256, so an iPhone keeps the Ed25519 key in the Keychain under hardware-backed encryption instead of changing the owner-key algorithm.

### Composing several writes into one approval

A caller that makes several owner writes as one user action opens one approval on `getOwnerSigner()` and passes the resulting `sign` function to the methods that accept one (`publishStrand`, `ensureStrandPartyKey`, `publishFormationInvite`). `adoptStrandBundle` does this for a whole bundle.

## Listing and adding owner keys

`CadreNode.listOwnerKeys()` returns one `CadreOwnerKey` per live owner key: its label, which owner vouched it, whether this node's signer holds it (`heldHere`) and whether this node's anchor trusts it (`trusted`).

An owner adds a key in one of two ways:

- **`addOwner(publicKey, { label })`** when the owner already has the new key's public half. It returns `false` when the key is already a live owner. It throws `OwnerKeyAddRefusedError` with code `alone` when the node reaches none of the party's other machines while the party has other members ([Limits and accepted tradeoffs](#limits-and-accepted-tradeoffs)).
- **An owner grant** when the new key does not exist yet, or is on a device the owner cannot reach directly.

## Exporting and importing an owner key

On an edge node, `exportOwnerKey({ label?, passphrase? })` returns the owner slot's key as text with its public key, and `importOwnerKey(text, passphrase?)` stores a key from such text. With a bare `CadreNode` the same actions are `exportOwnerKey(keyStore, options)` and `importOwnerKeyInto(keyStore, node, text, passphrase?)` in [`owner-key-flows.ts`](../../packages/cadre-core/src/owner-key-flows.ts).

An export is the private key, so whoever holds a plain export is an owner. Apps should say so and offer a passphrase. The text is a versioned prefix followed by base64url canonical JSON, short enough for one QR code:

- **Plain**: `sereus-owner-key:1.` then the 32-byte Ed25519 seed and an optional label of at most 64 characters.
- **Locked**: `sereus-owner-key-locked:1.` then the plain form sealed with XChaCha20-Poly1305 under a key that scrypt derives from the passphrase. The scrypt parameters and salt are part of the text, so a build with different defaults still reads an old export.

Importing stores the key in the device's owner slot, and the device is then an owner of every cadre whose `OwnerKey` table lists the key. Given a running node, the import also wires the key when it is a live owner of that node's party (`wired: true`). A node that already signs with another key keeps it, and the imported key is wired at the next start. One key imported on two devices may sign on both at once; two writes of the same row conflict as any two owners' writes do.

The decoders refuse with `OwnerKeyExportError`, whose `code` an app can switch on (`OwnerKeyExportErrorCode` in [`owner-key-export.ts`](../../packages/cadre-core/src/owner-key-export.ts)). Two codes have a reason behind them. A wrong passphrase and an altered text both fail the same authentication check and refuse as `wrong-passphrase`, so a garbled key is never returned. A locked text that asks for more scrypt work than the decoder allows is refused `cost-too-high` before any derivation, so a hostile file cannot keep a device busy for minutes.

The kinds of text a user pastes refuse each other by name: the owner-key decoder refuses an invitation, a grant, a join request and a node's claim code, and each of those decoders refuses an owner key. A private key pasted into the wrong field is therefore refused locally and never sent to a member.

An export is a copy of the device's own key and needs no network to use. A [backup grant](#backup-grants) is different: it holds no owner key, and whoever redeems it becomes an owner with a key of their own, through a machine of the cadre.

## Owner grants

An owner calls `CadreNode.createOwnerGrant({ label?, expiresInMs?, uses? })` and gets back a bundle, its encoded text (`sereus-owner-grant:1.` then base64url JSON) and `reach`. Whoever holds the text can seat an owner key of their own through any member machine of the party, whether or not the owner that minted it is online.

An **owner grant** is an Ed25519 key pair, as a cadre invitation is ([How a row proves it belongs](control-schema.md#how-a-row-proves-it-belongs)). The owner-signed `OwnerGrant` row holds the public half, and the bundle carries the private half as proof of possession. A grant admits no machine and names no peer id: the key it seats is whatever key the holder brings, a fresh one or one the holder already has.

### The bundle

`OwnerGrantBundle` ([`owner-grant-protocol.ts`](../../packages/cadre-core/src/owner-grant-protocol.ts)) has the shape of a cadre invitation. `encodeOwnerGrant` and `decodeOwnerGrant` are standalone, so a client without a node can decode one. The bundle carries:

- **The signed row**, exactly as issued. A member that has not yet received the row by replication seats it from the bundle under the issuer's stored signature. That signature covers every column, so an altered row cannot be seated anywhere.
- **`ownerKeys`**, taken from the issuer's trusted-owner anchor and never from the replicated `OwnerKey` table, because the holder anchors whatever arrives here.
- **`members`**, at most six member addresses with the issuer's first, chosen as a cadre invitation chooses them. The cap keeps the text inside one QR code. `reach` says where a holder could redeem once the issuing machine is gone, as it does for an invitation.

### Minting, listing, withdrawing

- **Defaults.** A grant lasts 15 minutes (`OWNER_GRANT_DEFAULT_TTL_MS`) and has one use. Whoever holds the bundle can become an owner, so it should live only long enough to be pasted or scanned by the device it was minted for.
- **Label.** The issuer chooses the label, and it goes on every key the grant seats, so recovery on a fresh device needs no naming prompt.
- **`listOwnerGrants()`** reports each grant this node holds with its standing: `live`, `withdrawn`, and the redemptions recorded.
- **`withdrawOwnerGrant(key)`** files an owner-signed tombstone over the grant. The row stays, because it is the proof behind every key the grant seated. Those keys stay owners.

### Backup grants

`expiresInMs: null` mints a grant with no expiry, and must be passed explicitly. It is the way back into a cadre after every device that held an owner key is lost. Whoever holds it can become an owner until it is used or withdrawn, so it is kept as carefully as an owner key, on paper or in a file.

Recovery has three steps. The owner starts a fresh device in the party and joins with the grant ([Joining with a grant](#joining-with-a-grant)), which makes the device a machine and an owner. The owner then removes the lost machine (`removeMachine`), and last removes the lost machine's owner key (`removeOwner`), re-vouching the machines that key had vouched.

### Redeeming

`CadreNode.redeemOwnerGrant(bundle, signer, options?)` seats `signer`'s key as an owner and returns `{ ownerKey, alreadyOwner, memberPeerId }`. The signer's one approval names the party and says the key becomes an owner of it. A bundle for another party is refused before anything is pinned, dialed or written. The call takes one of two paths, by whether this node is already a live member of the party or an enrolled owner of it.

**Local path, on a member machine.** The node seats the grant row from the bundle when it holds none, then writes the redemption in its own control database, and the rows replicate like any other write. The bundle's `ownerKeys` are not pinned: a member judges the issuer by its own `OwnerKey` table, and pasted text must not widen a member's anchor. Every refusal comes before the approval, so a prompting signer never asks for a redemption the node would refuse:

- `OwnerKeyAddRefusedError` `alone`, under `addOwner`'s rule. Connect to another machine of the party, then try again.
- `OwnerGrantRejectedError` `grant-spent` when the grant is not live here, unless the key is already an owner; `conflict` (retryable) when the cadre holds the grant row and this node has not synced it yet.
- `OwnerGrantIssuerUnknownError` when the issuer is not an owner here.

**Protocol path, everywhere else**: a device with no machine in the cadre, or a node started in the party on an empty store. The node pins the bundle's `ownerKeys` into its anchor with `invite` provenance, then dials the bundle's members over `/sereus/owner-grant/1.0.0`. `options` are the invitation's: `waitForMember` keeps making passes over the addresses while every answer is retryable, `signal` cancels, and `onProgress` reports each pass.

Neither path wires the signer. The caller calls `wireOwnKeyIfOwner(signer)` once the `OwnerKey` row is present locally: at once on the local path, and after the control store syncs on the protocol path. A key that is already a live owner is answered `alreadyOwner` with no use spent, on both paths.

On an edge node, `redeemOwnerGrant(text)` does all of it: it decodes the text, refuses another party's grant with `party-mismatch` before any key is made, redeems for the owner slot's key (created when the slot is empty) and wires it. `EdgeNode.joinCadre` accepts a grant for a party the app is not in ([An app joins an existing cadre](apps.md#an-app-joins-an-existing-cadre)).

On a server, `cadre enroll owner-grant` mints a grant and `cadre start --owner-grant` redeems one for the key in the server's owner key file, which makes a server an owner without copying an existing owner key onto it ([cadre-cli README](../../packages/cadre-cli/README.md)).

### Joining with a grant

`CadreNode.joinWithOwnerGrant(bundle, signer, options?)` makes a node both a machine and an owner. It is for a node started in the grant's party that is not a member: a fresh install recovering with a backup grant, or an app joining as an owner. The node needs a stable identity key.

Under one approval of `signer`, made before any dial so a prompt does not span the network, the node signs the grant request and a **self-invitation**: a `CadreInvite` row targeted at its own peer id, with one use and a 15-minute expiry. It then:

1. Redeems the grant over the protocol path. The member that accepts seats the new owner key.
2. Redeems the self-invitation, trying first the member that accepted the grant. That member holds the new key as a live owner, seats the invitation row from the bundle and admits the node as a machine. A member the new `OwnerKey` row has not reached yet answers `issuer-unknown`, which is retried.
3. Wires the key once its `OwnerKey` row has synced to this node, checking every 2 seconds for up to 60 seconds.

The result's `ownerWired` says whether the key was wired within that time. When it is false, a later `wireOwnKeyIfOwner(signer)` wires the key.

### The redemption protocol

The exchange on `/sereus/owner-grant/1.0.0` is one frame each way, capped at 64 KiB (`OwnerGrantRedeemRequest` and `OwnerGrantRedeemReply` in `owner-grant-protocol.ts`). The member-side handler base and the holder's dialing in passes are shared with the cadre-invitation protocol ([Cadre invitations](membership.md#cadre-invitations)).

**The request** carries the party id, the grant row, the key to seat, a nonce the holder minted, and two signatures over the grant key, the nonce and the seated key: one by the grant's private key (possession) and one by the key being seated (consent). The holder sends the same request, with the same nonce, to every address on every pass. Redemptions are keyed by the nonce, so a member the holder gave up on that was still committing cannot spend a second use, and a retry after a lost reply is answered `alreadyOwner`.

**The member checks** shape, party and both signatures before any database work. It does not check the connecting peer's identity: the holder's peer id has nothing to do with the key it seats, and both signatures already bind the grant, the nonce and the key. The member can verify the possession signature but cannot produce it, so a member cannot seat an owner for itself.

**The member admits the holder to its control replication** for the length of the write, when the grant is live there: it pushes its control store to the holder and counts the holder as a cluster member until the writes settle. The holder is not a machine, but a member alone with the holder (the issuer's phone offline, the only always-on node answering) would otherwise commit the `OwnerKey` row only to itself, and that row has no re-issue path.

**The holder verifies the reply** against its pinned keys: same party, same grant key, and a row signed by a pinned issuer. How a member's connection gate treats a grant holder is described under [The connection gate](control-security.md#the-connection-gate).

### Rejection codes

`OWNER_GRANT_REJECTION_RETRYABLE` is the one place that says which refusals the holder retries at the next address. `OwnerGrantRejectedError` exposes `code` and `retryable`. A code this build does not know is reported as `unrecognized` and counts as retryable.

| Code | Retried | Sent when |
| --- | --- | --- |
| `issuer-unknown` | yes | The issuer's `OwnerKey` row is not on this member yet, or the issuer was removed. The member cannot tell which. |
| `grant-invalid` | no | A signature does not verify, or the request or row is malformed. |
| `grant-spent` | no | The grant is expired, withdrawn or used up, or its issuer is no longer an owner here. |
| `party-mismatch` | no | This machine serves another cadre. |
| `busy` | yes | The member is at its cap on concurrent redemptions. |
| `conflict` | yes | The write failed transiently, or this member has not synced the grant row the cadre holds. Nothing was recorded. |
| `internal` | yes | An unexpected member-side failure, or a request frame the member could not read. |

Two more errors come from the holder's side. `OwnerGrantUnreachableError` (retryable) means every address was tried and none accepted; its `outcomes` say what each address did. `OwnerGrantReplyInvalidError` (final) means a member accepted but its reply failed the check, so that machine is not a member of the cadre the grant names. With `waitForMember`, a holder whose clock passes the grant's expiry stops with `grant-spent`.

## Removing an owner key

`CadreNode.planOwnerKeyRemoval(key)` returns the read-only plan for an app's confirmation step, and `CadreNode.removeOwner(key, { revouch? })` performs the removal and returns `{ removed, revouched }`. The removal deletes one `OwnerKey` row and files its tombstone, signed by a different owner key. The machines the key was used on stay members.

### Re-vouching first

Every `CadrePeer` and `OwnerKey` row the removed key vouched is judged, on every machine, against that machine's anchor through the voucher. Once the key is gone, such a `CadrePeer` row stops counting as a member everywhere, and such an `OwnerKey` row keeps its place only in anchors that had already derived it ([The trusted-owner anchor](control-security.md#the-trusted-owner-anchor)).

The plan lists those rows as `dependents`, and the app chooses which to keep by passing them in `revouch`. An entry outside the plan's dependents is refused before any write, and omitting `revouch` removes the key alone. `removeOwner` re-vouches the chosen rows under the remover's key before the removal, so no reader ever judges them against an owner that is gone. The re-vouches and the removal are one owner approval. A re-vouch that fails stops the call before the removal; re-vouches already made stay, and the caller retries.

The remover's own rows are handled separately:

- **Its own `CadrePeer` row**, when the removed key vouched it, is re-vouched without being asked (`revouchesOwnRow`). Left on the removed key, every other machine would drop the remover.
- **Its own `OwnerKey` row** is reported as `ownDependency` and not touched, because re-vouching it would mean signing its own removal. It keeps its place in every anchor that already derived it, and another owner can re-vouch it afterwards.

The plan also lists the live owner grants the key issued (`grants`). A redemption needs a live issuer, so those grants stop working with the removal, and an app can say "the backup made with this key stops working". `removeOwner` does not withdraw them: a tombstone over a grant nobody can redeem adds nothing.

### Refusals

`removeOwner` throws `OwnerKeyRemovalRefusedError` before any write. The plan's `refusal` carries the same code, except `alone`, which is decided at call time.

| Code | Meaning |
| --- | --- |
| `not-an-owner` | This node holds no enrolled owner key. |
| `unknown` | No live row names the key here. |
| `last-owner` | The key is the only live owner key. Checked before `self`, so a sole owner asking to remove its own key is not told to ask another owner when there is none. |
| `self` | The key is this node's own. The schema requires a signer other than the removed key, so another owner key has to remove it. |
| `alone` | A row would be re-vouched, the remover's own included, while the node reaches none of the party's other machines and the party has other members. |

A removal with nothing to re-vouch still commits while alone, and its tombstone is re-issued when another machine connects ([Deletes made while alone](control-convergence.md#deletes-made-while-alone)). A re-vouch also commits alone once the party has no other members. That is how a device whose only other machine is a lost phone proceeds: remove that machine, then its key.

## Limits and accepted tradeoffs

- **An owner-key add or re-vouch made while alone would be lost.** A committed `OwnerKey` row has no re-issue path ([Writes made while alone](control-convergence.md#writes-made-while-alone)), and a `CadrePeer` re-vouch written alone can fork its collection, leaving the other machines with the removal's tombstone and no new voucher. `addOwner`, the local redemption path and any re-vouch are therefore refused `alone`. The check runs before the approval, so a connection that drops while the user approves can still commit alone; that case is logged and not rolled back.
- **Two holders can both redeem a single-use grant.** The use cap counts committed usage, so two holders redeeming at two machines at once may both be seated, and both rows stand after the machines merge. Serializing would need cross-machine coordination the control database does not have. The mitigations are the defaults (one use, 15 minutes) and the owner seeing the extra key in the owner-key list and removing it. Recorded at `OwnerGrantUsage.Authorized` in `schemas/control.qsql`.
- **Mutual removal can leave no owners.** Two owners removing each other while partitioned both commit locally. `MinOneOwner` counts only the rows a node holds and is not re-checked on merge, so the table can converge to zero owners. Each machine's anchor refuses the removal that would empty it, but no owner-signed write is possible afterwards. Recovery from that state is undecided (ticket `decide-owner-recovery`).
- **A removed key may not be re-seatable everywhere at once.** A machine that holds a removed key's tombstone without the row's delete (a removal committed while the remover was alone) refuses a signed add or a grant that re-seats that key.
- **The reply check does not detect a forged member.** It catches an answer for the wrong party or the wrong row. A machine that forges an acceptance is exposed only when the holder's control store syncs and its anchor judges the rows.
- **A holder whose redemption fails keeps a copy of the control store.** The member pushes its store before the write. Accepted, as for a cadre invitation: the holder is someone an owner chose to make an owner.
- **A backup grant can go stale.** Its member addresses are fixed at mint time. If every member's address changes, the grant names no reachable machine, so a party should mint a fresh backup after its machines change.
- **A key created for a redemption that then fails stays in the owner slot.** A later import of a different exported key is refused `OwnerKeySlotOccupiedError` until a grant seats the slot's key.
- **A node founding on an unsynced store anchors its own key.** An embedder judges "the party has no owner" from local rows, so a node started on an empty store for a party founded elsewhere inserts a founding row and anchors its key as `genesis`. Other machines do not come to trust that key, because an anchor never derives a founding row. The `NOTE:` at `CadreNode.useOwnerSigner` records when this would need a stricter check.
- **A removed owner's node keeps running.** A node whose own key is removed drops it from its anchor, so its vouches stop verifying locally, but nothing stops the node. An embedder that wires the key again at the next start re-anchors it until the first membership refresh. The kits and cadre-cli wire a key only while it is a live owner.
- **Hardware-held owner keys are not supported.** The `OwnerSigner` interface allows a prompting backend, but the node's background writers (re-issues of writes made while alone, the first self-record and push-token rows, joined-strand rows, the pending-join retry loop) each open their own approval per write, which such a backend would turn into repeated prompts (ticket `feat-owner-key-on-a-hardware-key`).
