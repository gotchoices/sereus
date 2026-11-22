# Closed-strand keys and what a joiner keeps

A party holds two keys for each closed strand it belongs to: the strand's read secret and the party's own membership key. This document explains why they are separate, where they are stored and the risk that storage accepts, how a party's membership key is replaced after one of its machines is removed, and what a node records about a strand it joined from another party. It is for app developers who handle closed strands and for maintainers of the key and join-record code.

Related: [Closed-strand membership](membership.md) · [Inviting and joining](formation.md) · [Removing a machine](../cadre/removing-machines.md) · [The cadre node](../cadre/node.md)

## Closed-strand member key handling

Both keys are Ed25519 private keys minted by `generateStrandMemberKey` and stored in the same encoding. They do different jobs.

| | Read secret | Membership key |
|---|---|---|
| Stored in | `Strand.MemberPrivateKey` in the founding party's control database; `JoinedStrand.MemberPrivateKey` in a joining party's | `StrandPartyKey.PrivateKey` in each party's own control database, one row per strand |
| Held by | Every member party | One party |
| Used for | Its presence in a formation result tells the joiner the strand is closed. Nothing encrypts or admits with it. | Signs the party's rows in the strand's membership tables; its public half is the party's `Member` key |
| Sent to other parties | Yes, in the formation result, after the invitation and disclosure are validated | Never |
| Replaced by | Forming a new strand | Removing a machine from the party's cadre |

**The read secret does not restrict reads.** cadre-core stores it, covers it with the owner signature on the `Strand` row and delivers it. No code encrypts strand data with it or checks it when a peer connects ([Limits and accepted tradeoffs](#limits-and-accepted-tradeoffs)).

**Why two keys.** A key that every member party holds cannot identify any one of them. If the founder's member and manager key were derived from the read secret, every joiner could compute the founder's private key and sign as the founding manager: admit anyone, remove anyone. So the read secret identifies nobody, and each party's identity in the strand is a key that never leaves that party.

The membership tables use the public half of the membership key. `strandMemberKeyPair` converts a stored key into the signing key pair that the [membership writers](membership.md#calling-the-membership-writers) take.

### Where each key comes from

- **The founder supplies the read secret** in `FoundStrandConfig.memberPrivateKey`. `foundStrand` writes the `Strand` row and the party's `StrandPartyKey` row in one control transaction under one owner approval, so a closed strand row is never stored without the party's membership key ([Founding a strand](lifecycle.md#founding-a-strand)).
- **A joiner receives the read secret** in the formation result, together with a single-use membership invitation ([The invite-to-join handshake](membership.md#the-invite-to-join-handshake)).
- **A joiner mints its own membership key** when the formation result arrives (`ensureStrandPartyKey`), or reuses the one its control database already stores for that strand. Reuse is what makes a second formation with the same strand keep the party's identity.
- **A stored membership key is never replaced by a founding or a join.** `ensureStrandPartyKey` returns the stored key and throws if the caller supplies a different one.

Writing a `StrandPartyKey` row requires an owner signature, and `ensureStrandPartyKey` requires an owner signer even to return a stored key. A machine with no owner signer therefore cannot complete a closed-strand join: the formation succeeds and spends its token, then `formStrand` throws `FormationPostApprovalError`, and the party needs a new invitation.

### Which key a machine launches a strand with

When a machine launches a closed strand, it takes the party's membership key from the first of these that exists: the key passed to the launch (`foundStrand` passes the one it just wrote), the key a join on this machine just stored, the replicated `StrandPartyKey` row. Only the machine that the `Strand` row names as founder mints a key when none is stored, so two machines of one party never mint different keys for the same strand.

A machine that launches the strand before the `StrandPartyKey` row has reached it runs without a membership key and writes no membership rows. When the row arrives, the node gives the running strand the key and starts its [membership loop](membership.md#how-the-runtime-completes-a-join).

### Both keys replicate to every machine of the party

Both keys are stored unencrypted in the party's control database, which replicates to every node the party owns. That is deliberate. Any node of the party then has what it needs to serve the strand and to sign the party's membership writes, including a node added to the cadre long after the strand was formed and a node that starts with no user present to unlock anything, such as one woken by a push notification.

The cost of that choice is stated under [Accepted residual risk](#accepted-residual-risk).

### A strand whose founder is the read-secret key is refused

In a closed strand founded by a release that derived the founder's identity from the read secret, every member can sign as the founder. Such a strand cannot be repaired in place, because any member may already have admitted or removed anyone, or could do so while the membership was being rewritten.

The runtime detects it by a `Member` or `Manager` row whose key is the public half of the read secret. Nothing writes that key in a correctly founded strand, so the check cannot match one. The consequences:

- **The founder's launch fails** with `PreSplitStrandIdentityError`, and `strand:error` is emitted on each retry.
- **A join is rejected and not retried.** The formation responder answers `'Host strand must be recreated'` (`HOST_STRAND_MUST_BE_RECREATED_REASON`) before the formation token is spent.

The remedy is to unpublish the strand and found a new one.

### Unpublishing a closed strand destroys both keys

`CadreNode.unpublishStrand` deletes the party's `Strand` row and its `StrandPartyKey` row in one transaction. Neither key is stored anywhere else, so the party can never again sign as the member it was. Publishing the same strand id again mints a new membership key that no row in the strand's membership tables matches. The party's rows in the strand stay behind ([limits in membership.md](membership.md#limits-and-accepted-tradeoffs)), and so does the strand's local storage ([limits in lifecycle.md](lifecycle.md#limits-and-accepted-tradeoffs)).

## Accepted residual risk

The node's identity key and the owner key are kept in the platform's secure store through the `KeyStore` interface ([Node key material and the KeyStore](../cadre/node.md#node-key-material-and-the-keystore)). The two closed-strand keys are not. They sit in the control database's storage, which on a phone is the app's own storage.

**The risk.** A compromised device (a stolen phone, a rooted operating system, an extraction of app storage) exposes both keys of every closed strand its party belongs to. The attacker gets the party's read secret for each strand and its membership identity, and can sign membership writes as that party.

**Why it is accepted:**

- **Encrypting these columns alone would protect little.** The keys sit behind the same app-storage boundary as the rest of the control database and the strand data the device has replicated.
- **The keys that are hard to replace are already protected.** The node's peer identity and the owner key each have a slot in the platform's secure store.
- **These keys are per strand and replaceable.** A membership key is replaced by removing the compromised machine from the cadre ([Replacing the party's key](#replacing-the-partys-key)). A read secret is replaced by forming a new strand.
- **A fix that keeps every node able to serve needs infrastructure that does not exist.** Encrypting the columns under a key held in each node's secure store requires distributing one secret to every node of a cadre, late joiners included. Nothing else in the system needs that, so it has not been built.

**What was declined.** Binding a strand's keys to one device's secure store, or to a chosen subset of nodes, was rejected. A node added later could not serve the strand, which is the problem that replicating the keys solves.

**Revisit when** something else needs a secret shared across a cadre, which would pay for building the distribution, or when the threat model changes so that a compromise of app storage must be survived. The open questions at that point are: provisioning a node that joins late, rotating the encrypting key across the replicated database, what a node does when its secure-store slot is wiped (biometric invalidation, an Android reinstall), cadres that mix file-based and secure-store key stores, and migrating the existing unencrypted rows.

## Replacing the party's key

A machine removed from a party's cadre still holds the party's membership key for every closed strand. Removing the machine therefore replaces that key in each closed strand the party holds a key for. [Removing a machine](../cadre/removing-machines.md) covers the removal itself; this section covers what happens in each strand.

The aim is to leave the removed machine with a [binding](membership.md#binding-the-partys-machines) under a key that is no longer a member, while every remaining machine has a binding under a key that is. Every machine in the strand then refuses the removed machine from the membership rows alone ([What removal does to the network](membership.md#what-removal-does-to-the-network)).

### The pending key

`CadreNode.removeMachine` writes a `PendingStrandPartyKey` row for each closed strand in the same control transaction as the machine's removal. The row holds the new key's public half in the clear and its private half encrypted to the identity keys of the machines that remain (`sealed-party-key.ts`). The removed machine receives that transaction too, and cannot open the row.

The `StrandPartyKey` row keeps the old key until the strand's rows have been changed. Seating the new key in the strand and then failing before the control row changed would otherwise leave a seat nobody holds, and changing the control row first would delete the only copy of the old key, which the next steps sign with.

### The succession in the strand

The replacement is carried out by an **owner machine** of the party (a machine that holds an enrolled owner key) that runs the strand and can open the pending key. It uses the ordinary membership writers (`strand-party-key-rotation.ts`). The old key admits the new key as a member, the new key binds every remaining machine, the old key promotes the new key to manager, and the old key resigns and leaves.

The control database is changed last: one transaction, under one owner approval, replaces the `StrandPartyKey` row and removes the pending row for every strand the run finished. That approval is separate from the one that removed the machine.

Each step reads the strand before it writes, so a run that is interrupted continues from the rows it finds, and two owner machines running it at once reach the same result. The order has two consequences:

- **No remaining machine is refused.** Each is bound under both keys before the old key leaves.
- **A machine of the party that reads the new key from the control database finds a member behind it**, because the strand's rows were changed first.

The other machines of the party follow the control database. When the new `StrandPartyKey` row replicates to a machine, its running strand switches to the new key and its membership loop starts again under it. A strand that was hibernating reads the row when it wakes.

### When the replacement runs

- **Inside `removeMachine`**, for each closed strand that runs on the removing machine. A strand hibernating there is woken first.
- **When an owner machine that can open the pending key launches the strand, wakes it, finishes its first sync or drains its offline queue.** A strand whose offline queue holds transactions stays pending until the queue drains, because the membership writers refuse while it holds any.
- **When the pending row replicates** to such a machine that already runs the strand.
- **When another machine of the party becomes reachable**, for a final control write that was deferred while the machine was alone ([Writes made while alone](../cadre/control-convergence.md#writes-made-while-alone)).

A machine that has itself been removed from the cadre never runs a replacement, whatever keys it holds.

### What the app sees

`removeMachine` returns one outcome per closed strand in `MachineRemovalResult.strands`: `rotated`, `pending`, or `needs-another-party` when the party holds no manager seat and cannot admit its own new key. `CadreNode.listPendingPartyKeyRotations` lists the replacements still waiting, on any machine of the party, each with the new key's public half and the machines that can open it (`sealedTo`). [Removing a machine](../cadre/removing-machines.md#what-the-plan-the-result-and-the-pending-list-say) defines each outcome and each value of the list's `waitingOn` field.

The machine that completes a replacement emits `strand:party-key-rotated`. A replacement that needs another party emits `strand:party-key-rotation-blocked` once per pending key.

### A strand the party does not manage

Where the party is a member and not a manager, its old key cannot admit the new one. The new key stays pending and the removed machine keeps being served in that strand until a manager of the strand seats the new key. There are two ways:

- **The host re-invites the party.** The host's owner creates a formation invitation bound to the strand, as for any new party, and gives it to the rotating party's owner outside the system. That owner redeems it with `formStrand` or `requestJoin`. The host's node issues a membership invitation as for every closed-strand join. The redeeming node's membership loop, which would otherwise find the party already a member and spend the invitation unused, redeems it under the pending key.
- **A manager admits the key by hand** with `addMemberByManager`, using the public half from `listPendingPartyKeyRotations`.

Either way, the party's membership loop notices the new member row on its next pass and resumes the replacement. It finishes with fewer steps: no promotion, since the party holds no manager seat, and the old key simply leaves.

One rule protects this path: while a pending key exists for a strand, the membership loop never seats the party's current key, because the removed machine holds that key. A machine of the party that cannot open the pending key (one admitted after the removal, or one with no stored identity key) leaves the invitation for a machine that can.

The host is not told that a party replaced its key. In the strand's rows it is an ordinary join under a new key followed by an ordinary departure of the old one.

### A second removal during a replacement

Removing another machine while a replacement is pending writes a new pending key, because the first one may already have reached the machine now being removed. The new row lists the replaced key as superseded, and the next run revokes any seat that key already holds before it seats the new one.

## What a joiner's node remembers

A party's own strands return after a restart because their `Strand` rows are in its control database. A strand joined from another party has its `Strand` row in the founding party's control database, so the joiner needs a record of its own. cadre-core keeps two (`joined-strand-store.ts`), and an app keeps no list of joined strands itself.

- **The party-wide record** is a `JoinedStrand` row in the joining party's control database: the strand's id, its type and, for a closed strand, the read secret. Once it exists it is the authority. Every machine of the party offers the strand, a node that hosts storage replicas launches it, and deleting the row is how the party leaves.
- **The machine-local record** holds joins this machine made that the party's control database does not yet name. `formStrand` writes one, and so does an `addStrand` without `founder: true` for a strand the control database names neither as the party's own nor as a party-wide join. A local record is deleted as soon as the control database names the strand, so it always means "joined here, not yet published".

### Where the local record is kept

The local record holds the read secret, so it is kept in the node's `KeyStore`: one slot per strand, `cadre/joined-strand/<base64url party id>/<strand id>`. The party segment separates two parties that share one key store.

A node configured with `privateKey` and no `keyStore` falls back to memory, warns once, and loses its unpublished joins at restart. Such an embedder supplies a store in `CadreNodeConfig.joinedStrands`:

```ts
import { KeyStoreJoinedStrandStore } from '@serfab/cadre-core';
import { FileKeyStore } from '@serfab/cadre-core/key-store-file';

const joinedStrands = { store: new KeyStoreJoinedStrandStore(new FileKeyStore(dir), partyId) };
```

### Publishing a join to the party

The node's reconcile pass for its control cohort ([Cohort auto-connect](../cadre/control-convergence.md#cohort-auto-connect)) writes each local record as a `JoinedStrand` row and then deletes the local record. Two conditions apply:

- **The machine holds a control connection.** A control write committed while alone stays local and can diverge from the party's copy ([Writes made while alone](../cadre/control-convergence.md#writes-made-while-alone)).
- **The machine is an owner machine.** The row is owner-signed, because every always-on machine of the party downloads the strands it names. A machine with no enrolled owner key never publishes; its joins stay local and are offered on that machine only.

Recording a join does not start a pass. The join is published on the next one: when the party's machines change, when a sibling connects, or within the pass's 2-minute interval. If another machine of the party published the same strand first, the local record is deleted and the existing row stands.

A party with one machine publishes once that machine holds any control connection, since the check counts connections without asking whose they are. Moving a party's strands into another party exports both kinds of record ([Moving the app's strands](../cadre/apps.md#moving-the-apps-strands)).

### Offering joined strands at start

On every run the strand watcher offers one row per strand id, in this order of precedence: the party's own `Strand` rows, the party-wide joins, this machine's unpublished joins. A joined strand is offered as `strand:discovered` with null founder columns and the read secret, or is launched directly when the app has already registered the strand's sApp. A node that hosts storage replicas launches a party-wide join as a replica, so the party's always-on machine keeps a copy of a strand that its phone joined.

The party's other devices receive `strand:discovered` for a party-wide join too. An app may claim such a row without a second formation, because the row exists only as the result of one.

If the read of the party-wide table fails, the watcher offers the last list that was read successfully. A local record is deleted only after a read that succeeded.

### Leaving a joined strand

`CadreNode.forgetJoinedStrand` leaves for the whole party. It deletes the `JoinedStrand` row (owner-signed, with a tombstone), then the local record, the addresses the formation carried and the strand's saved network state, and stops the strand on this machine. Every other machine's watcher sees the row gone and stops the strand, emitting `strand:stopped`; a machine that was offline deletes its stale row when the tombstone reaches it.

- **On a machine that is not an owner**, `forgetJoinedStrand` throws when a party-wide row exists. `stopStrand` stops the strand on that machine only.
- **For a join that is still local**, it deletes the local record and stops the strand.
- **`stopStrand` alone keeps both records.** The strand is offered again after a restart.
- **The strand is not told.** The party's `Member` row stays, and a later formation with the same strand reuses the same membership key.

It refuses while the strand's offline queue on this machine holds transactions, unless the caller passes `discardQueued` ([Offline mode](writes.md#offline-mode)).

### When the party is removed from the strand

A machine that emits `strand:revoked` for a joined strand keeps offering the strand for the rest of its session, as that event promises, and queues the `JoinedStrand` row for deletion by its next reconcile pass as a connected owner machine. The next start of any machine of the party then does not launch the strand. Redeeming a new invitation for the same strand, or attaching it again with `addStrand`, cancels the queued deletion.

The queue is in memory. If the process ends first, the next start launches the strand, the node finds itself revoked again, and the deletion is queued again.

### The records restore the strand, not its addresses

The two records say which strands to launch. The other parties' addresses are in the strand node's saved network state ([Saved network state and redial](../network/strand-addressing.md#saved-network-state-and-redial)). A restarted joiner reconnects only if both are durable: the embedder supplies `strandNetworkState.store` as well as a `keyStore` or `joinedStrands.store`. With the join record in memory, a local join is not offered after a restart. With the network state in memory, the strand launches with no address to dial.

A machine that launches a party-wide join it did not form itself, such as a replica host or a second phone, has neither saved state nor formation addresses for it. The machines of its own party that run the strand supply addresses ([Strand-address resolution](../network/strand-addressing.md#strand-address-resolution)).

## Limits and accepted tradeoffs

- **Both keys are stored unencrypted on every machine of the party.** See [Accepted residual risk](#accepted-residual-risk).
- **Nothing checks the read secret when a peer connects or reads.** cadre-core never gives it to the strand's network node or its storage, and no code encrypts strand data with it or authenticates a peer by it. It is used to tell a joiner that the strand is closed and to detect [a founder that is the read-secret key](#a-strand-whose-founder-is-the-read-secret-key-is-refused). A peer can read a closed strand if it knows the strand id and reaches a machine that serves it ([Network isolation](lifecycle.md#network-isolation)), unless that machine holds a record of it as a removed member's machine ([limits in membership.md](membership.md#limits-and-accepted-tradeoffs)).
- **The read secret is never replaced in a running strand.** A removed party and a removed machine keep it, and keep the data they replicated. Only forming a new strand changes it.
- **A membership key is replaced only when its party removes a machine.** A manager removing a party does not change that party's key, and there is no call that replaces a key on request.
- **The new key is unencrypted once it is current.** The pending row is encrypted to the remaining machines; the `StrandPartyKey` row that replaces it is not, because a machine admitted later must be able to read it. The removed machine could receive that row only from a sibling that holds it and has not yet received the removal. Revisit if such a sibling is observed.
- **A pending replacement cannot be withdrawn.** The pending row records the decision to cut the removed machine off, and only the final control write ends it. `unpublishStrand` removes it together with the strand's `StrandPartyKey` row. `forgetJoinedStrand` keeps both rows, so a later formation with the same strand finishes the replacement.
- **A sealed strand cannot take a replacement key.** With no manager, nobody can admit the new key. `listPendingPartyKeyRotations` reports `waitingOn: 'sealed'`, and the removed machine's key stays a member until a new strand is formed.
- **A party that loses every machine the pending key was encrypted to cannot finish.** The old key stays a member and the removed machine stays served. A manager of the strand revokes the old key with `revokeMember`, and the party joins again with a new invitation after deleting its own `StrandPartyKey` row, since `ensureStrandPartyKey` would otherwise reuse it.
- **A pending key written while the removing machine was alone can be lost.** A tombstone committed alone is issued again when the cohort grows; a pending row is not. If the machine is lost before its replacements finish, the rows are lost with it.
- **Only the founding party can re-invite through formation.** In a strand whose founder has left and whose manager belongs to another party, admitting the new key by hand is the only path ([limits in membership.md](membership.md#limits-and-accepted-tradeoffs)).
- **The re-invitation is a credential for whoever holds it.** Whoever redeems it seats a key of their choosing, so it must reach the rotating party's owner and not the machine that was removed.
- **A replacement cannot bind a machine whose `StrandPeer` row has not reached the party.** The succession binds the peer ids it reads from those rows, so a machine that has not published one yet, or whose write was deferred while it was alone, is left bound under the old key alone and refused once that key leaves. No operator action is needed: the row's arrival wakes every sibling's membership loop, and a sibling binds the machine under the current key ([Binding the party's machines](membership.md#binding-the-partys-machines)).
- **A strand founded with the read secret as its founder key cannot be migrated.** It must be recreated.
- **A machine that is not an owner can neither publish a join nor leave for the party.** Its joins stay on that machine. Whether such a machine may write these rows is undecided (ticket `decide-non-owner-machine-completes-a-pending-join`).
- **A sibling of a revoked machine stops the strand instead of keeping it.** When the queued deletion of the `JoinedStrand` row reaches a sibling that has not itself emitted `strand:revoked`, that sibling stops the strand with `strand:stopped`. The alternative was a party-wide record that relaunches a revoked strand on every start of every machine. An app that needs a "you were removed" screen on every device would need the sibling to check its own revocation state before stopping.
- **A revoked strand can stay recorded party-wide.** Only an owner machine can delete the row. If no owner machine observes the revocation, the row stays until an owner leaves the strand.
- **A join published late can bring back a strand the party left.** If a second device joined the same strand and has not yet published when the leave happens, its next pass publishes the join again.
