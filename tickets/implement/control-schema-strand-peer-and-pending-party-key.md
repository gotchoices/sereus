description: Add two bookkeeping tables to the cadre's shared control record. One remembers which network identity each machine uses inside each private workspace, so the cadre's other machines can act on that machine's behalf. The other holds a replacement workspace membership key while the cadre is moving onto it, so a crash mid-way loses nothing. Nothing in this ticket writes them from the running node yet.
architecture: docs/architecture.md#control-schema-versions-and-migrations
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts (`CONTROL_SCHEMA_VERSION`), packages/cadre-core/test/fixtures/control-schema/v4.qsql (new), packages/cadre-core/test/control-schema-versions.spec.ts, packages/cadre-core/src/control-database.ts (`RevocableTable`, the row-key map near line 515, `deleteGuardedRow`, `queryStampId`, `signStrandPartyKeyInsert` as the idiom), packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/peer-record.ts (the self-signature idiom), packages/cadre-core/src/strand-transport-key.ts (what `StrandPeerId` is), docs/architecture.md (Deletes made while alone: the guarded-table list)
difficulty: medium
----
# Control schema v4: `StrandPeer` and `PendingStrandPartyKey`

First of four tickets that make `removeMachine` rotate the party's membership key in each closed strand (the maintainer's decision of 2026-11-03, option A of `decide-removed-machine-strand-access`). The chain is this ticket → `strand-peer-rows-and-sibling-binding` → `machine-removal-rotates-party-member-key` → `scenario-machine-removal-rotates-party-key`, with `party-key-rotation-across-parties` planned after it. This ticket is the schema and database layer only.

## Why two tables

**A machine's strand peer id is not derivable by anyone else.** `strandTransportKey` derives a strand node's libp2p identity from the machine's private identity seed and the strand id, on purpose (the module comment: no third party can enumerate a member's strand peer ids). So when a machine is removed from the cadre, the remover cannot tell which `Strand.MemberPeer` binding is the removed machine's and which belong to the party's other machines. The rotation needs that distinction twice: to bind every remaining machine under the new key before the old key leaves the strand, and to leave the removed machine's binding behind as the orphan the closed-strand gate denies on. `StrandPeer` is each machine's own signed statement of its strand peer id, replicated party-wide, that nothing else can supply. The sibling plan ticket `offline-mode-holds-writes-for-party-machines-it-cannot-reach` names the same gap ("a control row cannot name it") and can read this table once it exists.

**The new key must be durable before it is used.** Seating a fresh key as a member and manager in the strand, then crashing before the control row is swapped, would leave a manager seat nobody holds. Worse, swapping the control row first would delete the only copy of the old key, which is the manager key the seating needs. So the new key is written to the control database as a pending row first, and the `StrandPartyKey` row is swapped only after the strand-side work is done. `StrandPartyKey` is keyed on the strand id alone and `NoUpdate`, so the pending key cannot share its table.

## `StrandPeer`

```
table StrandPeer (
    StrandId text,              -- the strand (own Strand.Id or JoinedStrand.Id)
    PeerId text,                -- the machine's CONTROL peer id (CadrePeer.PeerId)
    StrandPeerId text,          -- that machine's strand transport peer id for StrandId (strand-transport-key.ts)
    Sig text,                   -- the machine's own signature over the 'add' digest
    primary key (StrandId, PeerId),
    constraint Immutable check on update, delete (false),
    constraint Authorized check on insert (
        exists (select 1 from CadrePeer P where P.PeerId = new.PeerId
            and verify(digest('CadreControl.StrandPeer', 'add', party_id(), new.StrandId, new.PeerId, new.StrandPeerId), new.Sig, P.PublicKey, 'ed25519'))
    )
)
```

- Self-signed like `CadrePeer.AuthorizedUpdate`'s publish branch, verified against the machine's stored `PublicKey`. A deferred check (it has a subquery), so a machine whose own `CadrePeer` row is written in the same transaction passes. On a node where the machine's row is absent the insert is refused; the writer (next ticket) treats that as "retry later".
- No stamp, no tombstone, no delete: a row is a permanent fact (the derivation is deterministic, versioned by `STRAND_TRANSPORT_KEY_DOMAIN`), and the rows of a removed machine must stay, because they are how its orphaned strand bindings are attributed to it after removal. Not in `REAPABLE_TABLES` and not in `Revocation.RowIsGone`, since nothing retires it.
- A reader judges a row by two things the schema cannot: that the `PeerId` is a live or tombstoned cadre machine (the membership views, as `describeMachines` does) and that `Sig` verifies against the key derived from `PeerId` (`ed25519PublicKeyB64FromPeerId`), as `verifyRevocationSigner` re-verifies a replicated tombstone. A replicated row is never re-checked by the constraint.
- If the transport derivation is ever bumped to `.v2`, every row here is stale at once; note that at `STRAND_TRANSPORT_KEY_DOMAIN`.

## `PendingStrandPartyKey`

```
table PendingStrandPartyKey (
    Id text primary key,        -- the strand id
    PrivateKey text,            -- the key the party is moving to, as StrandPartyKey.PrivateKey
    Superseded text null,       -- comma-joined PUBLIC keys (base64url) of earlier pending keys this one replaced
    StampId text unique,
    NotRevoked / RevocationRecorded / NoUpdate as StrandPartyKey,
    AuthorizedInsert: owner-signed over digest('CadreControl.PendingStrandPartyKey', 'add', party_id(), new.Id, new.PrivateKey, coalesce(new.Superseded, ''), new.StampId),
    AuthorizedDelete: owner-signed over digest('CadreControl.PendingStrandPartyKey', 'remove', party_id(), old.Id, old.StampId)
)
```

- Guarded exactly like `StrandPartyKey`: a one-off stamp, a tombstone in the same transaction as the delete, no reap branch (the row carries a private key stored nowhere else). `Revocation.TableName`'s comment and `RowIsGone` gain `'PendingStrandPartyKey'`.
- `Superseded` exists for a second removal that lands while a rotation is still pending: the removal replaces the pending key (the old pending key may have reached the newly removed machine) and records the replaced key's public half, so the rotation driver can revoke a member or manager seat it may already have given that key. `Superseded` is bound into the add digest, as every column that changes meaning is.
- `NOTE:` at the table: there is no re-issue path for a pending row committed while the remover was alone (the `Revocation.ReissuedAt` idiom would give one); a remover that removes alone and is then lost before its rotations finish loses the pending rows with it. Document, do not build.

## Version bump

`CONTROL_SCHEMA_VERSION` 3 → 4. Add `v4.qsql` as a copy of the edited `schemas/control.qsql`; `control-schema-versions.spec.ts` must classify both statements `additive` (two `create table`s) and pass without touching `CHANGED_DIGESTS` (no existing digest changes). `CONTROL_SCHEMA_BASELINE_VERSION` stays 3.

## `ControlDatabase`

- `RevocableTable` and the row-key map gain `PendingStrandPartyKey: 'Id'`; `queryStampId` and `deleteGuardedRow` work for it unchanged. The guarded-table list under "Deletes made while alone" in `docs/architecture.md` names it, with `StrandPartyKey`, among the deliberately unreaped tables.
- `insertStrandPeer({ strandId, strandPeerId })`: signs with the node's identity key (the libp2p private key `peer-record.ts` signs self records with) and inserts; insert-if-absent by reading the row first, so a repeat is a quiet no-op. Rejections propagate.
- `queryStrandPeers(strandId): Promise<StrandPeerRow[]>`: every row for the strand with `Sig` re-verified against the key derived from `PeerId`; rows that fail verification are dropped with a log. Attribution to live or removed machines is the caller's (next ticket), through the existing membership views.
- `queryPendingStrandPartyKey(strandId): Promise<{ privateKey, superseded: string[], stampId } | null>` and `queryPendingStrandPartyKeyStampId`.
- `insertPendingStrandPartyKey(strandId, privateKey, superseded, ownerKey, sign)` and `deletePendingStrandPartyKey(strandId, ownerKey, sign)` on the `signStrandPartyKeyInsert` / `deleteGuardedRow` idioms, through `lockedWithRetry` like their siblings. The combined writers the rotation needs (the pending rows riding `removeMachine`'s transaction, and the swap of `StrandPartyKey` for the pending key in one transaction) belong to `machine-removal-rotates-party-member-key`; this ticket only has to leave the statement pairs composable the way `deleteStrandAndPartyKey` composes `deleteGuardedRow`'s.
- `control-authorization.ts`: the two new digest builders beside the `StrandPartyKey` ones, and `signGuardedRemoval` accepting the new table.

## Edge cases & interactions

- **Machine's own `CadrePeer` row absent on the writing node** (a solo founder before `registerSelf`, or a joiner whose admission row has not replicated to it): the insert is refused by `Authorized`. Verified by the control-database spec below; the writer's retry is the next ticket's.
- **Mixed releases.** A machine on release 3 ignores both tables and writes nothing to them. Its self-publish rewrites only `CadrePeer`, so it cannot clear anything here. By inspection against the mixed-versions rules in the architecture doc.
- **Forged `StrandPeer` row by a rogue party machine naming a sibling's `PeerId`** cannot pass `Authorized` through the engine (wrong signer), and a row planted by direct block writes fails the reader's re-verification. A rogue machine binding a bogus peer id under the party key is already possible without this table, so the table adds no power. By inspection.
- **`Revocation.RowIsGone`** for the pending table binds on the stamp, as for `StrandPartyKey`; a tombstone whose row never existed is harmless (random stamps). By inspection.
- **The versions spec** fails if the fixture is forgotten or the version tag disagrees; that is the check, not a new test.

## Tests

- `control-schema-versions.spec.ts`: passes with `v4.qsql` (existing spec; no new test).
- `control-database-strand-peer.spec.ts` (one database, one engine): a `StrandPeer` row signed by the machine whose `CadrePeer` row is present inserts and reads back verified; the same row signed by another key is refused; a `PendingStrandPartyKey` row inserts under an owner, is refused on re-insert under its retired stamp after a tombstoned delete. Two tests pin the two constraints; the retired-stamp refusal is the shared idiom, so one assertion inside the second test, not a third test.

## TODO

- Edit `schemas/control.qsql`: the two tables with their comments, `Revocation.TableName` comment and `RowIsGone` branch, the header's guarded-table list.
- Bump `CONTROL_SCHEMA_VERSION`, add `test/fixtures/control-schema/v4.qsql`, run `control-schema-versions.spec.ts`.
- `control-authorization.ts`: digest builders for both tables.
- `control-database.ts`: `RevocableTable` map, `insertStrandPeer`, `queryStrandPeers`, `queryPendingStrandPartyKey`, `queryPendingStrandPartyKeyStampId`, `insertPendingStrandPartyKey`, `deletePendingStrandPartyKey`, composable statement pairs.
- `docs/architecture.md`: Deletes made while alone, the guarded-table list and the unreaped pair; Control schema versions, nothing beyond what the version rules already say.
- `control-database-strand-peer.spec.ts`.
- `yarn lint`, `yarn workspace @serfab/cadre-core test`.
