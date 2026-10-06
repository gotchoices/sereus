/**
 * Embedded control schema for cross-platform compatibility.
 *
 * This is the authoritative runtime copy of the CadreControl authorization
 * schema. It is duplicated from `schemas/control.qsql` so that React Native and
 * other filesystem-less environments get the schema without a runtime file read.
 *
 * The two copies MUST stay identical — `control-schema-drift.spec.ts` fails the
 * build if they drift. Any edit here must be mirrored in `schemas/control.qsql`
 * and vice versa.
 */
export const CONTROL_SCHEMA = `-- A Sereus party's cadre (its nodes) and their participation in strands (networks).
--
-- Every write is authorized by a check: an owner signs an action-tagged digest of the row
-- (cadre-core control-authorization.ts), or a peer signs its own record. Each digest leads
-- with a 'CadreControl.<Table>' domain tag and an action tag, so an approval verifies only
-- against the one rule it was minted for.
--
-- Rows of the guarded tables (OwnerKey, ValidationKey, Strand, StrandPartyKey, JoinedStrand,
-- JoinRequest, CadrePeer, DeviceToken) carry a one-off StampId bound into their add and
-- remove digests. \`unique\` holds over live rows only, so a delete retires the stamp into
-- Revocation in the same transaction (RevocationRecorded) and an insert refuses a retired
-- stamp (NotRevoked): the never-expiring add approval cannot re-seat a removed row. A
-- legitimate re-add mints a fresh stamp and a fresh signature.
--
-- A check with a subquery defers to commit, so a sibling row written in the same transaction
-- is visible to it; \`committed.<Table>\` reads the pre-transaction snapshot instead. Every
-- check reads the rows this node holds: a node that has not converged on a Revocation row
-- still accepts the replayed add, and the resurrected row then coexists with its tombstone.
-- ControlDatabase drops retired stamps on the reads that matter (queryCadrePeers,
-- queryPendingJoins).
declare schema CadreControl {
    -- A key that can authorize control changes.
    table OwnerKey (
        Key text primary key,
        StampId text unique,
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'OwnerKey' and R.StampId = new.StampId)
        ),
        -- The tombstone must name the removed row, not just its stamp (Revocation.RowKey).
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'OwnerKey' and R.StampId = old.StampId and R.RowKey = old.Key)
        ),
        -- Every other table's checks require an owner, so an empty table is a permanent denial of
        -- the party's control plane. Counted post-delete, on this node's rows only: two partitioned
        -- nodes removing different owners can still converge to zero.
        constraint MinOneOwner check on delete (
            (select count(1) from OwnerKey) >= 1
        ),
        -- Rotation is add-then-remove. An update branch would let the sole owner be re-pointed at
        -- another key under a post-image count of one.
        constraint NoUpdate check on update (false),
        -- The authorizer is read from the pre-transaction snapshot: the check defers to commit, by
        -- which point the inserted row (and any sibling) is live, so a plain OwnerKey read would let
        -- a row authorize itself or two strangers seat each other. The founding transaction, whose
        -- pre-transaction owner set is empty, needs no authorization; gating on the pre-transaction
        -- count keeps a same-transaction swap of the sole owner off that branch. An owner cannot
        -- sign its own removal. The domain tag scopes an approval to a table and an action, not to
        -- a party: two parties sharing an owner key would accept each other's approvals.
        constraint Authorized check on insert, delete (
            (old.Key is null and (select count(1) from committed.OwnerKey) = 0)
                or (old.Key is null and exists (select 1 from committed.OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.OwnerKey', 'add', new.Key, new.StampId), context.Signature, A.Key, 'ed25519')))
                or (new.Key is null and exists (select 1 from committed.OwnerKey A where A.Key = context.OwnerKey and A.Key <> old.Key and verify(digest('CadreControl.OwnerKey', 'remove', old.Key, old.StampId), context.Signature, A.Key, 'ed25519')))
        )
    ) with context (OwnerKey text null, Signature text null);

    -- A key that can validate a strand formation disclosure (FormationUsage.Authorized).
    table ValidationKey (
        Key text primary key,
        StampId text unique,
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'ValidationKey' and R.StampId = new.StampId)
        ),
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'ValidationKey' and R.StampId = old.StampId and R.RowKey = old.Key)
        ),
        constraint NoUpdate check on update (false),
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.ValidationKey', 'add', new.Key, new.StampId), context.Signature, A.Key, 'ed25519'))
        ),
        -- Owner-signed over the stored row, or a reap: a committed tombstone naming this exact row
        -- incarnation lets a node that was offline at removal time delete the stale row unsigned
        -- (ControlDatabase.reapRevokedRow). committed.*, so a tombstone filed in this transaction
        -- cannot stand in for the signature; the stamp clause, so a tombstone of an earlier
        -- incarnation cannot remove the current one.
        constraint AuthorizedDelete check on delete (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.ValidationKey', 'remove', old.Key, old.StampId), context.Signature, A.Key, 'ed25519'))
                or exists (select 1 from committed.Revocation R where R.TableName = 'ValidationKey' and R.RowKey = old.Key and R.StampId = old.StampId)
        )
    ) with context (OwnerKey text, Signature text);

    -- A network of members sharing an sApp database, each contributing its cadre's peers. This
    -- party's own strands; a strand joined from another party is a JoinedStrand row.
    table Strand (
        Id text primary key,                -- UUID
        MemberPrivateKey text null unique,  -- the strand's shared read secret; closed strands only
        Type text,                          -- 'o' open | 'c' closed: open gates writes in the sApp, only closed gates reads
        FounderOwnerKey text null,          -- owner key of the machine that published the row, the founding machine
                                            -- (cadre-node.ts launchStrand); null on a consent-seated strand, whose
                                            -- insert carries no signature. Provenance, not content (strandRowMismatches).
        StampId text unique,
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'Strand' and R.StampId = new.StampId)
        ),
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'Strand' and R.StampId = old.StampId and R.RowKey = old.Id)
        ),
        -- The consent branch below carries no signature, so an update rule would let anyone rewrite
        -- a consent-seated strand.
        constraint NoUpdate check on update (false),
        -- Owner-signed, with FounderOwnerKey pinned to the verified signer; or consent-seated by a
        -- FormationUsage row naming this exact row (id and stamp), written in the same transaction
        -- (ControlDatabase.redeemInvitation). Binding the stamp is what makes a removal stick:
        -- the usage row outlives the strand, and keyed on the id alone it would re-authorize an
        -- unsigned re-seat under a fresh stamp. The consent branch is narrow, each clause closing
        -- one door:
        --   * open and keyless: a closed strand with a caller-chosen read secret has no legitimate
        --     producer;
        --   * through an unbound invite only: a bound invite's host strand is owner-provisioned,
        --     and consent-seating its id would downgrade the real row on a node it has not reached;
        --   * no usage row under another stamp, and no tombstone for the id: an id is consent-seated
        --     once, ever, and never after any removal. Re-joining a removed id is owner-signed.
        -- A standalone tombstone (no accompanying delete, Revocation.Authorized) lets an owner
        -- foreclose consent-seating of an id that never existed: owner-only, and ids are random.
        constraint AuthorizedInsert check on insert (
            (exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.Strand', 'add', new.Id, new.Type, coalesce(new.MemberPrivateKey, ''), new.StampId), context.Signature, A.Key, 'ed25519'))
                and new.FounderOwnerKey = context.OwnerKey)
                or (
                    new.Type = 'o'
                    and new.MemberPrivateKey is null
                    and new.FounderOwnerKey is null
                    and exists (
                        select 1 from FormationUsage FU
                            where FU.StrandId = new.Id
                                and FU.StrandStampId = new.StampId
                                and exists (select 1 from FormationInvite FI where FI.Token = FU.Token and FI.StrandId is null)
                    )
                    and not exists (
                        select 1 from FormationUsage FU2
                            where FU2.StrandId = new.Id and FU2.StrandStampId <> new.StampId
                    )
                    and not exists (
                        select 1 from Revocation R
                            where R.TableName = 'Strand' and R.RowKey = new.Id
                    )
                )
        ),
        -- No consent branch (an invitation forms a strand, never destroys one) and no reap branch:
        -- MemberPrivateKey is stored nowhere else, so this delete is unrecoverable
        -- (tickets/backlog/debt-strand-tombstone-reap.md owns any change).
        constraint AuthorizedDelete check on delete (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.Strand', 'remove', old.Id, old.StampId), context.Signature, A.Key, 'ed25519'))
        ),
        -- An open strand has no membership gate, so no member key.
        constraint MemberKeyClosedOnly check (
            new.MemberPrivateKey is null or new.Type = 'c'
        )
    ) with context (OwnerKey text, Signature text);

    -- This party's own membership identity for one strand: the private key whose public half
    -- seats its Strand.Member / Strand.Manager rows. Separate from Strand.MemberPrivateKey, which
    -- every joining party receives and so could forge (gotchoices/sereus#4). A side table because
    -- a joiner holds no Strand row. Replicated in plaintext to every machine the party owns
    -- (docs/strands.md → "Closed-Strand Member Key Handling") but never put on the formation wire.
    table StrandPartyKey (
        Id text primary key,        -- the strand id
        PrivateKey text,            -- ed25519, base64 protobuf, as Strand.MemberPrivateKey (cadre-core strandMemberKeyPair)
        StampId text unique,
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'StrandPartyKey' and R.StampId = new.StampId)
        ),
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'StrandPartyKey' and R.StampId = old.StampId and R.RowKey = old.Id)
        ),
        constraint NoUpdate check on update (false),
        -- Binding PrivateKey means a captured approval can only reproduce the key it approved.
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.StrandPartyKey', 'add', new.Id, new.PrivateKey, new.StampId), context.Signature, A.Key, 'ed25519'))
        ),
        -- No reap branch: the key is stored nowhere else (as Strand.AuthorizedDelete).
        constraint AuthorizedDelete check on delete (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.StrandPartyKey', 'remove', old.Id, old.StampId), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (OwnerKey text, Signature text);

    -- A strand this party joined from another party, whose control database holds the Strand
    -- row. Every machine of the party reads it, so a replica host keeps a copy and the party's
    -- other machines can attach. A separate table because every reader of Strand takes it to
    -- mean this party's own strand. MemberPrivateKey is held by the founding party and every
    -- member, so a removed row is recoverable by re-forming, which is why this table has a reap
    -- branch (unlike Strand and StrandPartyKey).
    table JoinedStrand (
        Id text primary key,            -- the founder's Strand.Id
        Type text,                      -- 'o' | 'c', as Strand.Type
        MemberPrivateKey text null,     -- the closed strand's shared read secret
        StampId text unique,
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'JoinedStrand' and R.StampId = new.StampId)
        ),
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'JoinedStrand' and R.StampId = old.StampId and R.RowKey = old.Id)
        ),
        constraint NoUpdate check on update (false),
        -- Readers cast Type (ControlDatabase.queryJoinedStrands).
        constraint KnownType check (new.Type = 'o' or new.Type = 'c'),
        constraint MemberKeyClosedOnly check (new.MemberPrivateKey is null or new.Type = 'c'),
        -- Owner-signed only: every always-on machine of the party downloads the strands named
        -- here, so a machine that is not an owner keeps its joins machine-local.
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.JoinedStrand', 'add', new.Id, new.Type, coalesce(new.MemberPrivateKey, ''), new.StampId), context.Signature, A.Key, 'ed25519'))
        ),
        constraint AuthorizedDelete check on delete (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.JoinedStrand', 'remove', old.Id, old.StampId), context.Signature, A.Key, 'ed25519'))
                or exists (select 1 from committed.Revocation R where R.TableName = 'JoinedStrand' and R.RowKey = old.Id and R.StampId = old.StampId)
        )
    ) with context (OwnerKey text, Signature text);

    -- A join this party asked for by redeeming another party's invitation, kept party-wide so
    -- the request outlives the device that asked and any owner machine can carry it on
    -- (docs/strands.md → "Joining while the inviter is offline"). The row is the request alone
    -- and never changes; its outcome is a JoinSuccess or JoinFailure row keyed by this row's
    -- stamp, so asking again (a fresh stamp) starts clean and a dismissal's tombstone retires
    -- the outcome with the request. Invitation is a bearer credential, replicated in plaintext
    -- to every machine the party owns, under the same accepted risk as JoinedStrand.
    -- Owner-signed only; whether a machine that is not an owner may write here is
    -- tickets/blocked/decide-non-owner-machine-completes-a-pending-join.md.
    -- The three tables reference only tables declared before them, so an apply that fails
    -- midway can drop them in reverse order. The two rules that would close a cycle are the
    -- writer's (ControlDatabase): a request's delete takes its outcome row with it, and a join
    -- recorded over a failure deletes the failure. An outcome row left behind is unreadable,
    -- since readers start from the request.
    table JoinRequest (
        Id text primary key,            -- base64url sha256 of the invitation token (cadre-core pendingJoinId),
                                        -- so the token never reaches Revocation
        Invitation text,                -- CadreNode.encodeInvitation
        Disclosure text,                -- canonicalJson of the disclosure the requester gave
        RequestedAt integer,            -- epoch ms
        ExpiresAt integer,              -- epoch ms; no attempt starts at or after it
        StampId text unique,
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'JoinRequest' and R.StampId = new.StampId)
        ),
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'JoinRequest' and R.StampId = old.StampId and R.RowKey = old.Id)
        ),
        constraint NoUpdate check on update (false),
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(
                digest('CadreControl.JoinRequest', 'add', new.Id, new.Invitation, new.Disclosure, cast(new.RequestedAt as text), cast(new.ExpiresAt as text), new.StampId),
                context.Signature, A.Key, 'ed25519'))
        ),
        -- Reapable: the inviting party and the user hold the invitation too.
        constraint AuthorizedDelete check on delete (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.JoinRequest', 'remove', old.Id, old.StampId), context.Signature, A.Key, 'ed25519'))
                or exists (select 1 from committed.Revocation R where R.TableName = 'JoinRequest' and R.RowKey = old.Id and R.StampId = old.StampId)
        )
    ) with context (OwnerKey text null, Signature text null);

    -- The outcome of a JoinRequest that joined: the strand the formation returned and, for a
    -- closed strand, the single-use membership invitation it delivered. Keyed by the request's
    -- stamp, so it names one request incarnation and a replayed approval can only re-seat the
    -- row it approved, against the request it approved. A join is final: it may be recorded
    -- over a failure (whose row the writer deletes with it), and nothing is recorded over it.
    table JoinSuccess (
        RequestStampId text primary key,
        RecordedAt integer,             -- epoch ms
        StrandId text,
        MembershipInvite text null,     -- JSON {inviteKey, invitePrivateKey}, the StrandMembershipInvite; closed strands only
        constraint RequestExists check on insert (
            exists (select 1 from JoinRequest R where R.StampId = new.RequestStampId)
        ),
        constraint NoUpdate check on update (false),
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(
                digest('CadreControl.JoinSuccess', 'add', new.RequestStampId, cast(new.RecordedAt as text), new.StrandId, coalesce(new.MembershipInvite, '')),
                context.Signature, A.Key, 'ed25519'))
        ),
        -- Removed only with its request: the tombstone retiring the request's stamp (owner-signed,
        -- or already committed for a reap) authorizes this delete.
        constraint AuthorizedDelete check on delete (
            exists (select 1 from Revocation R where R.TableName = 'JoinRequest' and R.StampId = old.RequestStampId)
        )
    ) with context (OwnerKey text null, Signature text null);

    -- The outcome of a JoinRequest that failed for good. Keyed as JoinSuccess is.
    table JoinFailure (
        RequestStampId text primary key,
        RecordedAt integer,             -- epoch ms
        Code text,                      -- a FormationRejectionCode, 'expired' or 'local'
        Reason text,                    -- human-readable
        constraint RequestExists check on insert (
            exists (select 1 from JoinRequest R where R.StampId = new.RequestStampId)
        ),
        -- A join is final: nothing records a failure over it.
        constraint NotJoined check on insert (
            not exists (select 1 from JoinSuccess S where S.RequestStampId = new.RequestStampId)
        ),
        constraint NoUpdate check on update (false),
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(
                digest('CadreControl.JoinFailure', 'add', new.RequestStampId, cast(new.RecordedAt as text), new.Code, new.Reason),
                context.Signature, A.Key, 'ed25519'))
        ),
        -- Removed with its request (JoinSuccess.AuthorizedDelete), or superseded by a join
        -- recorded in the same transaction.
        constraint AuthorizedDelete check on delete (
            exists (select 1 from Revocation R where R.TableName = 'JoinRequest' and R.StampId = old.RequestStampId)
                or exists (select 1 from JoinSuccess S where S.RequestStampId = old.RequestStampId)
        )
    ) with context (OwnerKey text null, Signature text null);

    -- A node of the cadre, carrying its self-published, freshness-stamped, self-signed address
    -- record (cadre-core PeerAddressRecord): a resolver re-verifies Sig against PublicKey,
    -- checks UpdatedAt and trust, then dials Multiaddr.
    table CadrePeer (
        PeerId text primary key,
        PublicKey text null,            -- ed25519 (base64url) behind PeerId; null if not ed25519
        Multiaddr text,                 -- comma-joined current addrs (signaling / p2p-circuit first)
        UpdatedAt int null,             -- epoch ms; strictly increases per self-update
        Sig text null,                  -- self-signature over the 'publish' digest; null until self-published
        StampId text unique,
        VouchOwner text null,           -- the owner key that vouched this membership (== insert context.OwnerKey)
        VouchSig text null,             -- that owner's 'vouch' signature (== insert context.Signature). A reader checks
                                        -- VouchOwner against its node-local trusted-owner anchor, not against this
                                        -- replicated table, which a self-owner can pollute.
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'CadrePeer' and R.StampId = new.StampId)
        ),
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'CadrePeer' and R.StampId = old.StampId and R.RowKey = old.PeerId)
        ),
        -- The owner vouches membership and the PublicKey<->PeerId binding (cadre-core derives
        -- PublicKey from PeerId) over (PeerId, StampId); the stored voucher must be the pair
        -- verified here. The same 'vouch' digest serves the owner branch of AuthorizedUpdate:
        -- both mean "this owner vouches this membership row".
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.CadrePeer', 'vouch', new.PeerId, new.StampId), context.Signature, A.Key, 'ed25519'))
            and new.VouchOwner = context.OwnerKey
            and new.VouchSig = context.Signature
        ),
        -- The stored 'vouch' voucher never authorizes a delete; the 'remove' signature rides in
        -- context and is never stored. Or a reap (ValidationKey.AuthorizedDelete).
        constraint AuthorizedDelete check on delete (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.CadrePeer', 'remove', old.PeerId, old.StampId), context.Signature, A.Key, 'ed25519'))
                or exists (select 1 from committed.Revocation R where R.TableName = 'CadrePeer' and R.RowKey = old.PeerId and R.StampId = old.StampId)
        ),
        -- A peer re-publishes its own addrs and freshness under its own key (cadre-core
        -- peer-record.ts); everything else is immutable and UpdatedAt must increase. Or an owner
        -- re-vouches the row over its current stamp. StampId never changes on update: an update
        -- that rotated it would leave the old stamp free and untombstoned, so retiring a stamp is
        -- delete plus tombstone.
        constraint AuthorizedUpdate check on update (
            (
                new.PeerId = old.PeerId
                and new.PublicKey = old.PublicKey
                and new.StampId = old.StampId
                and new.VouchOwner = old.VouchOwner
                and new.VouchSig = old.VouchSig
                and new.UpdatedAt > coalesce(old.UpdatedAt, 0)
                and verify(
                        digest('CadreControl.CadrePeer', 'publish', new.PeerId, new.Multiaddr, cast(new.UpdatedAt as text)),
                        new.Sig, new.PublicKey, 'ed25519')
            )
                or (
                    new.StampId = old.StampId
                    and exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.CadrePeer', 'vouch', new.PeerId, new.StampId), context.Signature, A.Key, 'ed25519'))
                    and new.VouchOwner = context.OwnerKey
                    and new.VouchSig = context.Signature
                )
        )
    ) with context (OwnerKey text null, Signature text);

    -- A mobile peer's platform push token, self-published so a server peer can push-wake a
    -- suspended app. A resolver re-verifies Sig against the CadrePeer.PublicKey for PeerId
    -- (cadre-core device-token.ts), checks freshness, then hands the token to the push sender.
    table DeviceToken (
        PeerId text primary key,
        Platform text,                  -- 'fcm' | 'apns'
        Token text,                     -- opaque platform device/registration token
        UpdatedAt int null,             -- epoch ms; strictly increases per self-update
        Sig text null,                  -- self-signature over the 'publish' digest
        StampId text unique,
        -- A resurrected token has no freshness ceiling to retire it (resolveDeviceToken defaults
        -- maxAgeMs to infinity), so stamp retirement is what makes a clear stick.
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'DeviceToken' and R.StampId = new.StampId)
        ),
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'DeviceToken' and R.StampId = old.StampId and R.RowKey = old.PeerId)
        ),
        -- The owner signs the whole row, nullable columns as '', so a replayed approval can only
        -- reproduce the row it approved (cadre-core peer-authorization.ts deviceTokenAddDigest).
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(
                digest(
                    'CadreControl.DeviceToken', 'add',
                    new.PeerId,
                    new.Platform,
                    new.Token,
                    coalesce(cast(new.UpdatedAt as text), ''),
                    coalesce(new.Sig, ''),
                    new.StampId
                ),
                context.Signature, A.Key, 'ed25519'))
        ),
        constraint AuthorizedDelete check on delete (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.DeviceToken', 'remove', old.PeerId, old.StampId), context.Signature, A.Key, 'ed25519'))
                or exists (select 1 from committed.Revocation R where R.TableName = 'DeviceToken' and R.RowKey = old.PeerId and R.StampId = old.StampId)
        ),
        -- Self-update only: Platform and Token may change, PeerId and StampId may not, UpdatedAt
        -- must increase. No owner re-touch branch: one outside the monotonicity rule would let a
        -- captured approval roll UpdatedAt back; an owner correcting a row deletes and re-inserts.
        constraint AuthorizedUpdate check on update (
            new.PeerId = old.PeerId
            and new.StampId = old.StampId
            and new.UpdatedAt > coalesce(old.UpdatedAt, 0)
            and exists (select 1 from CadrePeer P where P.PeerId = new.PeerId and verify(
                    digest('CadreControl.DeviceToken', 'publish', new.PeerId, new.Platform, new.Token, cast(new.UpdatedAt as text)),
                    new.Sig, P.PublicKey, 'ed25519'))
        )
    ) with context (OwnerKey text null, Signature text);

    -- An open invitation to form a strand with this party.
    table FormationInvite (
        Token text primary key,     -- a random string
        sAppId text,                -- the app of the strand to be formed
        ExpiresAt datetime null,
        TotalUses int null check (TotalUses >= 0),
        ValidationUrl text null,    -- web hook sent the disclosure; a ValidationKey then signs off each redemption
        StrandId text null,         -- bound invite: the host strand consent is recorded against;
                                    -- null: the responder provisions a fresh open strand per redemption
        StampId text unique,
        -- The owner signs the whole row, nullable columns as ''.
        constraint AuthorizedInsert check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(
                digest(
                    'CadreControl.FormationInvite', 'add',
                    new.Token,
                    new.sAppId,
                    coalesce(cast(new.ExpiresAt as text), ''),
                    coalesce(cast(new.TotalUses as text), ''),
                    coalesce(new.ValidationUrl, ''),
                    coalesce(new.StrandId, ''),
                    new.StampId
                ),
                context.Signature, A.Key, 'ed25519'))
        ),
        constraint AuthorizedDelete check on delete (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(
                digest(
                    'CadreControl.FormationInvite', 'remove',
                    old.Token,
                    old.sAppId,
                    coalesce(cast(old.ExpiresAt as text), ''),
                    coalesce(cast(old.TotalUses as text), ''),
                    coalesce(old.ValidationUrl, ''),
                    coalesce(old.StrandId, ''),
                    old.StampId
                ),
                context.Signature, A.Key, 'ed25519'))
        ),
        -- Insert and delete only, so the consent parameters cannot change under a signature.
        constraint Immutable check on update (false)
    ) with context (OwnerKey text, Signature text);

    -- Append-only record of formation invite redemptions, one row per redemption.
    table FormationUsage (
        Token text,                 -- the FormationInvite redeemed
        UsageStampId text,          -- single-use nonce minted by the joining peer, signed into its 'consent' digest
                                    -- and the approver's 'vouch' digest. The primary key: this table never
                                    -- deletes, so the key alone makes a nonce permanent and there is no
                                    -- NotRevoked pair here. Two nodes that have not converged can each admit
                                    -- the same nonce: a duplicated audit row, never a join nobody approved.
        PeerKey text,               -- the joining peer's ed25519 public key (base64url); its peer id derives from it
        PeerSig text,               -- the joiner's signature over the 'consent' digest (PeerConsented)
        Disclosure text,
        StrandId text,
        StrandStampId text,         -- the Strand.StampId this consent names: one strand row, not an id forever
                                    -- (Strand.AuthorizedInsert). Not unique: a bound invite's redeemers share
                                    -- a host strand.
        primary key (UsageStampId),
        constraint InsertOnly check on update, delete (false),
        -- The use cap counts the pre-transaction snapshot, so concurrent redeemers on separate
        -- nodes can over-admit by their number; both rows survive and removal is owner-gated. A
        -- strict per-token sequence was rejected: a lost race would silently drop a consented
        -- join. Two usage rows for one token in one transaction read the same count; no writer
        -- does that.
        -- A ValidationUrl invite needs a sign-off verified against a STORED ValidationKey row;
        -- context.ValidationKey only selects which row, so a redeemer cannot approve itself with
        -- a throwaway key. The sign-off covers (Token, UsageStampId, StrandId, PeerKey,
        -- Disclosure), so it buys exactly one row; StrandStampId is not bound because the
        -- unbound path mints it inside the redeeming transaction. Removing the key later does
        -- not revisit rows it approved.
        -- A bound invite may only name its own host strand. An unbound invite may name any
        -- existing strand, which burns a use and forecloses that id's consent-seating: harmless.
        constraint Authorized check on insert (
            exists (
                select 1 from FormationInvite FI
                    where FI.Token = new.Token
                        and (FI.TotalUses is null or FI.TotalUses > (select count(1) from committed.FormationUsage U where U.Token = new.Token))
                        and (FI.ExpiresAt is null or FI.ExpiresAt > context.Now)
                        and (FI.ValidationUrl is null or exists (
                            select 1 from ValidationKey VK
                                where VK.Key = context.ValidationKey
                                    and verify(digest('CadreControl.FormationUsage', 'vouch', new.Token, new.UsageStampId, new.StrandId, new.PeerKey, new.Disclosure), context.ValidationSignature, VK.Key, 'ed25519')))
                        and (FI.StrandId is null or FI.StrandId = new.StrandId)
            )
        ),
        -- A usage row may only name a strand row that exists, so a consent record cannot be held
        -- in reserve to re-seat an id after its removal.
        constraint StrandExists check (exists (select 1 from Strand S where S.Id = new.StrandId and S.StampId = new.StrandStampId)),
        -- The joiner proves it agreed. PeerKey is its own key, so there is nothing for a writer to
        -- substitute; stored on the row so any reader can re-check it (verifyFormationConsent).
        -- StrandId is not signed: the joiner cannot know it when it signs.
        constraint PeerConsented check on insert (
            verify(digest('CadreControl.FormationUsage', 'consent',
                          new.Token, new.UsageStampId, new.PeerKey, new.Disclosure),
                   new.PeerSig, new.PeerKey, 'ed25519')
        )
    ) with context (Now datetime, ValidationKey text null, ValidationSignature text null);

    -- Serves the per-token reads (the cap count above; cadre-core's countFormationUsage,
    -- isTokenUsed and hasOutstandingFormationInvite) on an append-only table. Its cross-machine
    -- convergence is guarded by the integration scenario strand-formation-concurrent-redemption.
    index FormationUsageByToken on FormationUsage (Token);

    -- Append-only retirement record for the stamps of removed rows of every guarded table, with
    -- the removed row's key. Every append is owner-signed, so the growth surface is the owner
    -- keys. One singleton marker row, ('Revocation', 'ledger', 'opened'), retires nothing: an
    -- owner's connected reconcile pass files it (ControlDatabase.openRevocationLedger) so this
    -- table is never a never-written block, which the storage layer would consult the cohort
    -- for on every guarded insert and membership lookup. Readers filter on their own guarded
    -- TableName, and queryRevocations skips it.
    table Revocation (
        TableName text,             -- 'OwnerKey' | 'ValidationKey' | 'Strand' | 'StrandPartyKey' | 'JoinedStrand' |
                                    -- 'JoinRequest' | 'CadrePeer' | 'DeviceToken', or 'Revocation' for the marker
        RowKey text,                -- primary key of the removed row
        StampId text,               -- the retired stamp
        ReissuedAt integer default 0,   -- bumped by an owner-signed re-issue so a tombstone committed while the
                                        -- node was alone can be re-written and so re-broadcast; nothing reads it
        -- Keyed on the stamp: one row key may carry several tombstones over its life.
        primary key (TableName, StampId),
        -- Retirement is permanent.
        constraint NoDelete check on delete (false),
        -- Pinned at 0 so an owner cannot seat a tombstone at a counter its own re-issues cannot pass.
        constraint FreshTombstone check on insert (new.ReissuedAt = 0),
        -- A re-issue moves nothing but the counter, and only upward.
        constraint ReissueOnly check on update (
            new.TableName = old.TableName and new.RowKey = old.RowKey
                and new.StampId = old.StampId and new.ReissuedAt > old.ReissuedAt
        ),
        -- A stamp is retired only once its row is gone (deferred, so the same-transaction delete
        -- counts). Keyed on the stamp, not RowKey: a node that converges on a re-admission before
        -- the earlier removal's tombstone must still accept that tombstone. Retiring a stamp that
        -- never existed is harmless: stamps carry 128 random bits (generateStampId). The last
        -- branch admits the marker row and nothing else under 'Revocation'.
        constraint RowIsGone check on insert (
            (new.TableName = 'OwnerKey' and not exists (select 1 from OwnerKey K where K.StampId = new.StampId))
                or (new.TableName = 'CadrePeer' and not exists (select 1 from CadrePeer P where P.StampId = new.StampId))
                or (new.TableName = 'ValidationKey' and not exists (select 1 from ValidationKey V where V.StampId = new.StampId))
                or (new.TableName = 'Strand' and not exists (select 1 from Strand S where S.StampId = new.StampId))
                or (new.TableName = 'StrandPartyKey' and not exists (select 1 from StrandPartyKey K where K.StampId = new.StampId))
                or (new.TableName = 'JoinedStrand' and not exists (select 1 from JoinedStrand J where J.StampId = new.StampId))
                or (new.TableName = 'JoinRequest' and not exists (select 1 from JoinRequest J where J.StampId = new.StampId))
                or (new.TableName = 'DeviceToken' and not exists (select 1 from DeviceToken D where D.StampId = new.StampId))
                or (new.TableName = 'Revocation' and new.RowKey = 'ledger' and new.StampId = 'opened')
        ),
        -- Owner-signed over the whole row under its own domain tag, so the delete's 'remove'
        -- signature filed in the same transaction never doubles as the tombstone's. Ungated, any
        -- writer could evict a peer party-wide and block its re-admission. RowKey is not checked
        -- against the retired row here (that would reject a tombstone re-issued later, or filed on
        -- a node that never held the row); each guarded table's RevocationRecorded binds it
        -- instead. Reads live OwnerKey like the sibling tables. The marker is signed under this
        -- rule too, over ('Revocation', 'ledger', 'opened').
        constraint Authorized check on insert (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(digest('CadreControl.Revocation', 'remove', new.TableName, new.RowKey, new.StampId), context.Signature, A.Key, 'ed25519'))
        ),
        -- Distinct 'reissue' tag, binding ReissuedAt, so neither approval replays as the other.
        constraint AuthorizedReissue check on update (
            exists (select 1 from OwnerKey A where A.Key = context.OwnerKey
                and verify(digest('CadreControl.Revocation', 'reissue',
                                  new.TableName, new.RowKey, new.StampId, cast(new.ReissuedAt as text)),
                           context.Signature, A.Key, 'ed25519'))
        )
    ) with context (OwnerKey text, Signature text);
}

apply schema CadreControl;
`;
