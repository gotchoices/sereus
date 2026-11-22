# The control schema

This document describes the tables of a cadre's control database, how a row in them is authorized and removed, and how the schema changes between releases. It is for maintainers who change `schemas/control.qsql`, and for app developers and operators whose node refuses to open a control store.

Related: [who a node trusts and admits](control-security.md), [owner keys](owner-keys.md), [adding and removing machines](membership.md), [control database replication](control-replication.md), [how a party's machines converge](control-convergence.md).

The schema is `CadreControl`, declared in `schemas/control.qsql`. The comments in that file own every column and constraint: what a check verifies, which fields a signature covers, and why. This document gives the model those comments assume.

## Tables

Every table is replicated to every node of the party. The table groups related tables; the schema file declares them in a different order. A method named without a class is on `CadreNode`. "Owner node" means a node with an owner signer wired.

| Table | What it records | Written by | Read by |
|---|---|---|---|
| `OwnerKey` | The party's owner keys, each with the proof that seated it and an optional label. | Owner genesis (`ControlDatabase.ensureOwnerKey`), `addOwner`, `removeOwner`, and a member machine redeeming an owner grant. | Every owner-signature check in the schema; `ControlDatabase.getOwnerKeys`; each machine's anchor, which follows the table through the stored proofs. |
| `OwnerGrant` | Owner-signed grants of ownership: the grant's public key, the label a seated key will carry, an expiry and a use cap. | `createOwnerGrant`. A member machine re-seats the holder's signed copy when replication has not delivered the row. | Grant redemption; readers verifying a grant-seated owner key; `ControlDatabase.listOwnerGrantStatuses`. |
| `OwnerGrantUsage` | One row per grant redemption: the key seated and the two signatures that prove the redemption. | The member machine that redeems the grant (`ControlDatabase.redeemOwnerGrant`). | The grant's use-cap count; readers verifying a grant-seated owner key. |
| `CadrePeer` | The machines of the cadre: each one's proof of membership, its self-signed address record and whether it is always on. | An owner node (`authorizePeer`), a member machine redeeming a cadre invitation, and each machine for its own address record. Removed by `removeMachine`. | `listAuthorizedMembers`, which feeds the connection gate; sibling address lookup (`ControlDatabase.queryPeerRecord`); seed minting. |
| `CadreInvite` | Owner-signed invitations for a machine to join the cadre: the invitation's public key, an optional target machine, an expiry and a use cap. | `createCadreInvitation`. A member machine re-seats the holder's signed copy when replication has not delivered the row. | Invitation redemption; `ControlDatabase.hasLiveCadreInvite`, for the connection gate; readers verifying an invitation-admitted machine. |
| `CadreInviteUsage` | One row per invitation redemption: the machine admitted and the two signatures that prove the redemption. | The member machine that redeems the invitation (`ControlDatabase.redeemCadreInvite`). | The invitation's use-cap count; readers verifying an invitation-admitted machine. |
| `DeviceToken` | A phone's FCM or APNs push token, signed by the phone. | `registerDeviceToken` and `clearDeviceToken` on the phone. The first insert and an explicit delete need an owner signature; a refresh is signed by the phone alone. | `resolveDeviceToken`, for the push sender that wakes a suspended app. |
| `Strand` | The party's own strands: id, open or closed, a closed strand's read secret, and the owner key and machine that founded it. | `publishStrand` and `unpublishStrand`. The machine that answers a formation seats a row when the invitation is not bound to a strand. | The strand watcher on every machine, which starts and stops strand instances. |
| `StrandPartyKey` | The party's own membership private key for one closed strand. | `publishStrand` for a closed strand; `unpublishStrand` removes it with the strand row; a key rotation replaces it. | A node signing strand membership rows as the party. |
| `PendingStrandPartyKey` | The key the party's membership in one closed strand is moving to during a rotation, sealed to the machines that remain. | `removeMachine`, in the transaction that removes the machine. The rotation deletes the row when it finishes. | The remaining machines, which finish the rotation. |
| `StrandPeer` | Each machine's signed statement of the peer id it uses in one strand, and of whether it serves the strand or runs it as a client. | Each machine, at every strand launch and resume. | The reconciler that binds the party's machines in a closed strand; machine removal; the offline write queue. |
| `JoinedStrand` | Strands the party joined from another party: id, type and a closed strand's read secret. | Owner nodes, which publish a join after recording it on the machine. Removed by `forgetJoinedStrand`. | The strand watcher on every machine. |
| `JoinRequest` | A join the party asked for through another party's invitation: the invitation, the disclosure and a deadline. | `requestJoin` and `dismissPendingJoin`. | The pending-join retry loop on every owner node; `listPendingJoins`. |
| `JoinSuccess`, `JoinFailure` | The outcome of one `JoinRequest`, keyed by the request's stamp. | The owner node whose retry loop finished the join (`ControlDatabase.recordJoinOutcome`). | `listPendingJoins`; the retry loop. |
| `FormationInvite` | The party's invitations for other parties to form or join a strand. | `publishFormationInvite`. | The machine that answers a formation; `ControlDatabase.hasOutstandingFormationInvite`, for the connection gate. |
| `FormationUsage` | One row per formation redemption: the joining peer's key, its consent signature and the disclosure. | The machine that answers the formation. | The invitation's use-cap count; the consent branch of the `Strand` insert check. |
| `ValidationKey` | Keys allowed to approve a formation disclosure, for invitations that name a validation URL. | `enrollValidationKey` and `removeValidationKey`. | The `FormationUsage` insert check; `listValidationKeys`. |
| `Revocation` | Tombstones: one row per retired stamp, naming the table and key of the row it retired and carrying the owner signature that filed it. | Every removal and withdrawal, in the same transaction. An owner re-issue rewrites a row's counter. | Every guarded insert check; the read-side filters; the reap sweep; each machine's anchor. |

Mechanisms that use these tables are described where they belong: [owner grants](owner-keys.md#owner-grants), [cadre invitations](membership.md#cadre-invitations), [formation invitations](../strands/formation.md#formation-invitations), [pending joins](../strands/formation.md#joining-while-the-inviter-is-offline), [party key rotation](../strands/keys.md#replacing-the-partys-key), [binding the party's machines](../strands/membership.md#binding-the-partys-machines) and [push wake](../strands/hibernation.md#push-wake).

## How a row proves it belongs

A check runs where a write is committed: on the writing node and on the cluster members that validate its transaction. A node that receives the row later, by replication, does not run the check. Two consequences shape the schema:

- **Rows carry their proof.** Where a reader later has to decide whether to trust a row, the signature or the reference that authorized it is stored on the row, so any node can verify it again.
- **Readers judge against the anchor.** A reader that makes a trust decision checks the stored proof against the [trusted-owner anchor](control-security.md#the-trusted-owner-anchor), not against the replicated `OwnerKey` table, which a hostile writer could have filled.

Three kinds of proof recur across the tables.

### Owner signature

The writer passes an owner key and a signature in the statement's `with context` clause. The check requires a live `OwnerKey` row for that key (one whose stamp is not retired) and verifies the signature over a digest of this shape:

```sql
digest('CadreControl.<Table>', '<action>', party_id(), <row fields>, StampId)
```

The table tag and the action tag (`add`, `remove`, `vouch` and the others listed in `control-authorization.ts`) limit an approval to one rule. Without them two rules could sign identical bytes, and an approval to enrol a validation key would also be an approval to add an owner. `buildAuthorizationMessage` in `control-database.ts` is the one function that builds the signed message; `control-authorization.ts` holds the field order.

Tables whose rows are verified again after replication store the signer and the signature, and the check pins the stored pair to the pair it verified: `VouchOwner` and `VouchSig` on `OwnerKey` and `CadrePeer`, `IssuerKey` and `IssuerSig` on `CadreInvite` and `OwnerGrant`, `SignerKey` and `SignerSig` on `Revocation`. Elsewhere the signature exists only in the write's context.

`OwnerKey` has rules of its own, because it is the table every other check reads: the founding row needs no signature, an added key is authorized by an owner that existed before the transaction, an owner cannot sign its own removal, and the table cannot be emptied. [Owner keys](owner-keys.md) describes them.

### Redeemed invitation or grant

Three tables accept an insert authorized by a redeemed credential instead of an owner signature: `CadrePeer` through a cadre invitation, `OwnerKey` through an owner grant, and `Strand` through a formation invitation. The schema comments call this the consent branch. In each case:

1. An owner signs the credential row (`CadreInvite`, `OwnerGrant`, `FormationInvite`) ahead of time.
2. The redemption writes a usage row and the seated row in one transaction. The usage row names the exact row it seats, by key and stamp.
3. The usage row's own check applies the credential's conditions: not withdrawn, not expired, uses left and, for a cadre invitation or owner grant, the issuer still an owner.

Two rules close the ways around this. The check reads the credential from the pre-transaction snapshot (`committed.<Table>`), so nobody can seat a credential and redeem it in one transaction. The usage row must name a row that exists at commit, so nobody can write a usage row now and seat a row with it later.

A cadre invitation or owner grant is a key pair, not a bearer token. The credential row holds the public half. The usage row stores a signature by the private half (`redeem`) and one by the admitted machine's key or the seated owner key (`consent`). The member machine that writes the redemption can verify the first signature and cannot produce it, so it cannot admit a machine of its own choosing or seat an owner key for itself.

A row seated this way has no owner signature of its own. A reader verifies the chain from the seated row to the usage row to the credential row to an anchored issuer (`verifyInvitationAdmission` and `verifyOwnerGrantAdmission` in `peer-authorization.ts`). The credential rows and usage rows are therefore never deleted. An owner ends a machine's dependence on its invitation by re-vouching its `CadrePeer` row, which replaces the reference with a signature.

Formation consent is narrower. It seats only an open strand with no read secret, only through an invitation that is not bound to a strand, once per strand id, and never after that id was removed. The comment on `Strand.AuthorizedInsert` gives the reason for each condition.

### A machine's own signature

A machine signs what only it can know with its identity key: its address record and always-on declaration in `CadrePeer`, its push token in `DeviceToken`, its strand peer id in `StrandPeer`. The check verifies against the `PublicKey` stored in the machine's `CadrePeer` row. The schema cannot confirm that this key is the one behind `PeerId`, so readers derive the key from the peer id and verify again. A `StrandPeer` row is signed over its role when it has one and over the three older fields when it has none, so rows from before version 5 still verify.

## Party binding

The third element of every owner and machine digest is `party_id()`, the party this machine is configured for. `ControlDatabase` registers it as a zero-argument SQL function on its own engine. It is not a context value, because the writer chooses context values, and it is not a table, because a table is replicated data. Every TypeScript signer and verifier passes the same configured id.

An approval signed for one party therefore fails verification in every other party, even when both have the same owner key, which happens whenever one owner key owns several cadres.

`FormationUsage` is the exception. The joining peer signs its consent before it learns the inviting party's id, and the outside approver behind a validation URL is never told it. Both digests bind the invitation token instead, a random secret seated in one party's `FormationInvite` table. Replaying either signature in another party would need that party's owner to seat the same token, and would harm only that party's own database.

## Stamps and tombstones

An owner's approval to add a row never expires, and on some tables it is stored on the replicated row. Without further protection, anyone holding a copy could re-insert a row after the owner removed it.

The tables that allow an owner-signed delete prevent this with stamps. This document calls them the **guarded tables**, and [How rows leave each table](#how-rows-leave-each-table) lists them. Each row carries a `StampId` minted at insert (`generateStampId`, 128 random bits), and the add and remove signatures cover it. A delete must file a `Revocation` row for the stamp in the same transaction (the `RevocationRecorded` check), and an insert refuses a stamp that has a `Revocation` row (the `NotRevoked` check). Adding the row again takes a new stamp and a new signature.

Filing a tombstone is an owner action with its own digest, so the delete's signature cannot be reused as the tombstone's. If tombstones were unsigned, any writer could evict a machine from the whole party and block its re-admission. The tombstone stores its signer, so a node that receives it by replication verifies who filed it (`verifyRevocationSigner`) against its anchor.

Closed strands apply the same idea to their membership tables, with their own tombstone table: see [single-use approvals in strands](../strands/membership.md#single-use-approvals-stamps-and-tombstones).

### How rows leave each table

| Tables | Removal | Reaped | Reason |
|---|---|---|---|
| `CadrePeer`, `DeviceToken`, `ValidationKey` | Owner-signed delete with a tombstone | Yes | The row holds public data that can be written again. |
| `JoinedStrand`, `JoinRequest` | Owner-signed delete with a tombstone | Yes | Others hold the same secret (a joined strand's founding party and members; a request's inviter and user), so a lost row can be written again. |
| `OwnerKey` | Owner-signed delete with a tombstone | No | An automated delete could empty the table, after which every control write is refused. |
| `Strand`, `StrandPartyKey`, `PendingStrandPartyKey` | Owner-signed delete with a tombstone | No | The row holds a key stored nowhere else. |
| `CadreInvite`, `OwnerGrant` | A tombstone withdraws the credential; the row stays | No | The row is part of the proof of every row it seated. |
| `JoinSuccess`, `JoinFailure` | Deleted with their request; a failure is also deleted when a success replaces it | With the request | They have no stamp; the request's tombstone authorizes the delete. |
| `FormationInvite` | The schema allows an owner-signed delete; no cadre-core writer issues one | No | Not a guarded table: it has no tombstone checks. |
| `CadreInviteUsage`, `OwnerGrantUsage`, `FormationUsage`, `StrandPeer`, `Revocation` | Never | No | Each is a permanent record. A usage row's primary key is its nonce, so a nonce cannot be used twice. |

### Reaping

A machine can hold a removed row together with the tombstone that retires it. This happens when the tombstone arrives without the delete, which is the case for [a removal committed while the remover was alone](control-convergence.md#deletes-made-while-alone), or when a replayed add reached the machine before the tombstone did.

Readers already ignore such a row: `queryCadrePeers`, `queryPendingJoins` and `getOwnerKeys` drop rows with a retired stamp, and every owner lookup in the schema's checks does the same. A removal takes effect on a machine when the tombstone arrives, with or without the delete.

Reaping removes the stale row itself. The delete check on a reapable table accepts, in place of an owner signature, a tombstone that names the same row key and stamp and was committed before the delete's transaction. A tombstone written in the same transaction does not count, so it cannot replace the owner signature of the removal that files it. Any node can therefore delete its own stale copy, including a node with no owner key. `REAPABLE_TABLES` in `control-database.ts` lists the tables, and [the reap sweep](control-convergence.md#the-reap-sweep) describes when a node reaps.

A node does not reap its own `CadrePeer` or `DeviceToken` row. Its heartbeat would try to insert the row again, which needs an owner signature over a new stamp, and a removed machine cannot produce one. Reaping would replace one stale row that no other machine reads with a failed write on every heartbeat. A removed machine learns of its removal through the `cadre:removed` event ([The removed machine learns of it](removing-machines.md#the-removed-machine-learns-of-it)).

## Schema versions and migrations

A party's phones take an app update one at a time, so machines on different releases share one control database until the last one updates. The control schema is therefore the one place where the project's "no backwards compatibility yet" rule does not apply: every schema version is kept, and each new version is checked against the one before.

A warm start migrates the control store in place, and the migration is the ordinary schema apply. `ControlDatabase.loadSchema` declares this build's schema, checks the store (see [the start-time check](#the-start-time-check)), then runs `apply schema CadreControl`. The apply compares the declaration with the catalog the store holds and runs the difference as DDL. Because consecutive versions differ only by changes that rewrite no row, the difference from a store at version K is the changes of every version from K+1 to the build's, in order.

There is no per-version migration code. A start-time step holds no owner key, so it could not write a signed row, and any change that would need one is refused when the schema is edited.

### Where the version is recorded

`CONTROL_SCHEMA_VERSION` in `control-schema.ts` is the version of the declared schema. The schema text carries it as the `sereus.controlSchemaVersion` tag on the `OwnerKey` table, and the apply writes that tag to the store, so a migrated store records the migrating build's version. A store with no tag reads as version 0.

`CONTROL_SCHEMA_BASELINE_VERSION` is the oldest version a store can be migrated from. A store below it is refused and must be recreated, because version 0 covers several schemas that nothing stored tells apart, and rows signed under those schemas no longer verify.

### What a new version may change

`classifyControlSchemaChange` in `control-schema-version.ts` sorts each statement of a schema difference into one of three kinds:

| Kind | Statements | Effect on a store |
|---|---|---|
| `additive` | `create table`, `create index`, `alter table … set tags` | Applied; touches no row. |
| `catalog-only` | `drop index`; add or drop a CHECK constraint; add a column declared `null` with no default or other column constraint; drop a column that no index, unique constraint or primary key covers | Applied to the table's catalog record; rewrites no row. |
| `unmigratable` | Everything else, including `drop table`, any rename, `alter column`, `alter primary key`, a `not null` or `unique` column, and any constraint other than a CHECK | Refused. |

A changed CHECK body appears as a drop and an add. Four cautions apply to changes the classifier accepts:

- **A rule on a new column** goes in a named table-level CHECK, as `CadrePeer.KnownProfile` does, so the column stays a plain nullable add.
- **An added CHECK over existing columns** is tested against stored rows by the apply, and fails the start on a store with a row that breaks it. Show that existing rows satisfy it before adding it.
- **A unique index on a table that holds rows** fails the apply on a store whose rows repeat the key.
- **A new column on a table whose rows are updated** is cleared by machines still on the older release, as [mixed versions in one party](#mixed-versions-in-one-party) explains.

A version that needs existing rows rewritten would add a new table and a pass that owner nodes run after start through the ordinary signed writers.

### Changing the schema

1. Edit `schemas/control.qsql` and make the same edit in the embedded copy, `CONTROL_SCHEMA_DECLARATION` in `packages/cadre-core/src/control-schema.ts`. React Native and browsers read the embedded copy. `control-schema-drift.spec.ts` fails when the two differ.
2. Raise `CONTROL_SCHEMA_VERSION`. The tag in `schemas/control.qsql` is a literal and must match. Every change to the declared schema raises the version, including additive ones. A comment-only edit does not.
3. Copy `schemas/control.qsql` to `packages/cadre-core/test/fixtures/control-schema/v<N>.qsql` for the new version. A fixture is never edited once a release has shipped it.
4. Run `control-schema-versions.spec.ts`. It requires a fixture for every version from the baseline to the build's, and fails on any `unmigratable` statement between consecutive fixtures.
5. If the change alters the arguments of a signed digest, keep the old form verifiable. Stored rows were signed over it, so readers accept the old form for rows whose new fields are null, and writers sign the new form. Record the change in that spec's `CHANGED_DIGESTS` list.

### The start-time check

On a warm start `refuseIncompatibleControlStore` reads the store's version, lists the DDL the apply would run without running it, and throws `ControlStoreIncompatibleError` for the first of these reasons that holds:

| `reason` | Condition | What to do |
|---|---|---|
| `newer-release` | The store's version is above the build's. A newer release migrated this store. | Update the app or node. Do not recreate: the store is intact and holds rows written since. |
| `before-migrations` | The store's version is below the baseline. | [Recreate the control store](#recreating-a-control-store). |
| `not-migratable` | A pending statement is `unmigratable`. Reachable only from a development or hand-made store. | Run a build whose schema matches the store, or recreate it. |

A `newer-release` store is refused even when the pending DDL only adds, because what it would add is what the newer release removed. The error carries `reason`, `partyId`, `storeVersion`, `buildVersion`, `pendingDdl` and `storageScope`. `CadreNode.start()` rejects with it, and an edge node reports it as the `error` of its `failed` status, so an app can branch on `reason`.

### Every machine migrates its own catalog

No machine is designated to migrate. A node holds off every control connection while it brings up its control database, so the start-time apply commits on that machine alone. Each machine also holds its own copy of the schema catalog, committed alone at its first start, and a restart loads that copy. So each machine migrates its own catalog when it first starts on the new release. All machines reach the same catalog because the version fixtures fix the statements each version runs.

This is deliberate. A catalog describes the tables one machine runs, and the row data is what the party shares. The `newer-release` reason guards the remaining case, a build asked to apply an older declaration over a catalog a newer release migrated, which arises on a machine that was downgraded.

### Mixed versions in one party

Between the first machine's update and the last:

- **An older machine keeps working.** It runs on its own catalog. Rows are stored by column name, so the newer machines read its rows with null in each new column, and it ignores columns it does not know.
- **An older machine's update drops new columns.** An update rewrites the row with only the columns the writer knows. The only control rows that are updated are `CadrePeer` (address republish and re-vouch), `DeviceToken` and the `Revocation` re-issue counter. A version that adds a column to such a table must be able to derive the value again, or must store it in a table that is never updated.
- **An older machine can restart.** It loads its own catalog, which no other machine migrated, and continues on the older release.

## Recreating a control store

Recreate a control store only when a start fails with reason `before-migrations` or `not-migratable`. Recreating deletes every row of every control table.

1. Stop the node on every machine of the party and delete each machine's control store. The store is the storage scope `controlStorageScope(partyId)`, which the error reports as `storageScope`.
   - cadre-cli with file storage: delete the directory of that name under `storage.path`.
   - An edge node: call `destroyScope` on the platform storage the app supplied (`EdgeNodeStorage`), with that scope.
2. Start the founding machine with its owner key. A party with no `OwnerKey` row is founded again by that key: `cadre start --owner` on a server, the owner step of the edge node's start in an app.
3. Admit the other machines again with new [cadre invitations](membership.md#cadre-invitations).

Delete the store on every machine, not only the one that was refused. Collection ids are fixed by table name, so a recreated store and a surviving old one would hold different blocks under the same ids.

**What is lost.** All owner keys beyond the founding one, the machine list, push tokens, validation keys, invitations and grants, pending joins, tombstones, and the party's lists of its own and joined strands. The read secrets and party keys of the party's own closed strands are stored nowhere else in the party, so it cannot act as their member again: it has no key with which to bind a machine or admit another party. A joined strand's read secret is also held by its founding party and every member, so the party can join that strand again.

**What survives.** Everything stored outside the control scope: the strand stores (each strand's storage scope is its strand id), each machine's identity key, the owner key (in the app's key store or cadre-cli's owner key file), and each machine's trusted-owner anchor.

## Limits and accepted tradeoffs

- **A check sees only the rows its node holds.** A node that has not received a tombstone accepts a replayed add, and the row then exists beside its tombstone after the two merge. Enforcing this at write time would need every node to hold every tombstone first. The read-side filter and reaping contain it.
- **Partitioned owner removals can empty `OwnerKey`.** `MinOneOwner` counts the rows on the writing node. Two nodes that cannot reach each other can each remove a different owner and merge to no owners, after which no control write is authorized and the store must be recreated.
- **Use caps can be exceeded by concurrent redemptions.** A cap counts committed usage rows, so redeemers on different machines can each take the last use of a cadre invitation, owner grant or formation invitation, and all their rows stand after merge. Serializing would need cross-machine coordination that the control database does not have, and for formation it would silently drop a join the joiner consented to. Mitigations are single-use defaults, invitations targeted at one machine, a 15-minute default grant expiry, and the owner removing the extra machine or key. Revisit if the control database gains a cross-machine sequencer.
- **Several tables only grow.** `Revocation`, the three usage tables, `CadreInvite`, `OwnerGrant`, `FormationInvite` and `StrandPeer` are never pruned. The reap sweep and the connection gate's invitation checks scan them in full. This is acceptable while removals and invitations are rare for a party's size. Revisit with a node-local mark of tombstones already reaped, or an expiry-ordered index.
- **`Strand` rows are not reaped.** A machine that was offline when a strand was unpublished keeps the row and may keep running the strand, because deleting the row automatically would destroy a key stored nowhere else (ticket `debt-strand-tombstone-reap`).
- **`OwnerKey` rows are not reaped.** A machine that received a removal's tombstone without its delete keeps the row. The row authorizes nothing, but adding the same key again on that machine is refused. Add it from a machine the delete reached. Revisit with a reap branch that cannot take the table below one owner, if re-adding removed owners becomes routine.
- **An isolated machine may not know of revocations.** A machine that never received the `Revocation` block and can reach no other machine reads the table as empty instead of failing every membership lookup. A machine holding an old copy of the block has the same exposure, so this adds none. Other read failures still fail the lookup. Revisit if Optimystic reports a held but old block distinctly, or if revocation must fail closed under partition.
- **A pending party key written alone is not re-broadcast.** Unlike a tombstone, a `PendingStrandPartyKey` row has no re-issue path. A machine that removes another while alone and is lost before the rotations finish takes those rows with it.
- **Secrets are replicated in plaintext to every machine of the party.** Closed-strand read secrets, party keys, pending join invitations and delivered membership invitations are readable by any machine in the cadre. [Closed-strand keys](../strands/keys.md#accepted-residual-risk) states the risk.
- **Migration cannot rewrite rows.** A start-time step holds no owner key, so a store below the baseline version is recreated, not migrated, with the losses listed under [Recreating a control store](#recreating-a-control-store).
- **The `CadrePeer.Profile` column does not record a node's class.** It records only the machine's `alwaysOn` [role](node.md#node-classes): `storage` says yes, `transaction` says no, and no value says the machine has not published one yet. The column cannot be renamed and no third value can be added, because a rename is [unmigratable](#what-a-new-version-may-change) and a party's machines update one at a time, so a value an un-updated sibling's `KnownProfile` check does not know would be rejected there. One cadre-core module writes and decodes these values, and nothing else compares them. Revisit if the control schema gains a way to rewrite stored rows.
- **Only owner nodes publish joins.** `JoinedStrand` and `JoinRequest` inserts are owner-signed, so a machine without an owner key cannot record a pending join for the party, and a strand it joins is known only to that machine (ticket `decide-non-owner-machine-completes-a-pending-join`).
