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
export const CONTROL_SCHEMA = `-- This manages a Sereus party's cadre, or set of nodes, and their participation in strands (networks)
declare schema CadreControl {
    -- A key that can authorize various control changes
    table AuthorityKey (
        Key text primary key,
        StampId text not null unique,   -- single-use authorization nonce (anti-replay)
        constraint Authorized check (
            -- Bootstrap: first authority key needs no existing authorization
            (select count(1) from AuthorityKey) <= 1

                -- Old authority authorizes by signing over THIS row (Key, StampId); single-use via unique StampId
                or (old.Key is not null and old.Key = context.AuthorityKey and verify(digest(new.Key, new.StampId), context.Signature, old.Key, 'ed25519'))

                -- or other authorities authorize by signing over THIS row (Key, StampId); single-use via unique StampId
                or exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.Key, new.StampId), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text null, Signature text null);

    -- A key that can validate a strand formation disclosure
    table ValidationKey (
        Key text primary key,
        StampId text not null unique,   -- single-use authorization nonce (anti-replay)
        constraint Authorized check (
            -- Authorities authorize by signing over THIS row (Key, StampId); single-use via unique StampId
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.Key, new.StampId), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text, Signature text);

    -- A network of members sharing an sApp database, each contributing peer nodes (their cadre) to the overall cohort
    -- Cadre peers should participate in each of these strands
    table Strand (
        Id text primary key,    -- UUID
        MemberPrivateKey text null unique,   -- Our private key as a member of this strand
        Type text, -- Types: 'o' = Open, 'c' = Closed -- Open can still control writes in the sApp, but only Closed controls reads
        StampId text not null unique,   -- single-use authorization nonce (anti-replay)
        constraint Authorized check (
            -- Authorized by an authority signing over THIS row (Id, Type, MemberPrivateKey, StampId); single-use via unique StampId
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.Id, new.Type, coalesce(new.MemberPrivateKey, ''), new.StampId), context.Signature, A.Key, 'ed25519'))

                -- or authorized by a cadre peer who has received a valid formation invitation.
                -- That path has no signed writer yet; when one is built it must still supply a
                -- fresh, unique StampId to satisfy the not-null/unique anti-replay column.
                or exists (select 1 from FormationUsage FU where FU.StrandId = new.Id)
        ),
        constraint MemberKeyClosedOnly check (
            -- An open strand ('o') has no membership gate, so it must not carry a
            -- member key. A non-null MemberPrivateKey requires a closed strand ('c').
            new.MemberPrivateKey is null or new.Type = 'c'
        )
    ) with context (AuthorityKey text, Signature text);

    -- A peer (node) that is part of the cadre, carrying a self-published,
    -- freshness-stamped, self-signed address record (see PeerAddressRecord in cadre-core).
    -- The row IS the peer-address record: a resolver reads it, re-verifies Sig against
    -- PublicKey, checks freshness (UpdatedAt) and trust, then dials the addrs.
    table CadrePeer (
        PeerId text primary key,
        PublicKey text null,            -- ed25519 (base64url) whose libp2p identity == PeerId (null if non-Ed25519)
        Multiaddr text,                 -- comma-joined current addrs (signaling / p2p-circuit first)
        UpdatedAt int null,             -- epoch ms; strictly increases per self-update (replay/rollback guard)
        Sig text null,                  -- ed25519 self-signature over the signed payload (base64url); null until self-published
        StampId text not null unique,    -- single-use authorization nonce (anti-replay), bound into the voucher/remove digests; rotates on (re)insert
        VouchAuthority text null,        -- ed25519 (base64url) authority key that vouched this membership (== insert context.AuthorityKey)
        VouchSig text null,              -- that authority's signature over digest(PeerId, StampId) (== insert context.Signature). A reader checks VouchAuthority against its NODE-LOCAL trusted-authority anchor (not this replicated table, which a self-authority can pollute) to decide authorized membership.
        constraint AuthorizedInsert check on insert (
            -- Authorized by an authority key, which vouches both membership and the
            -- PublicKey<->PeerId binding (cadre-core derives PublicKey from PeerId before insert).
            -- The digest binds PeerId + the single-use StampId nonce (two TEXT fields),
            -- matching cadre-core peer-authorization.ts:cadrePeerVoucherDigest.
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.PeerId, new.StampId), context.Signature, A.Key, 'ed25519'))
            -- Persist the vouching (authority, signature) onto the row so a reader can later
            -- re-check VouchAuthority against its node-local anchor. The stored pair MUST equal
            -- the pair the verify above validated, so a writer cannot store a voucher it did
            -- not actually receive a signature for.
            and new.VouchAuthority = context.AuthorityKey
            and new.VouchSig = context.Signature
        ),
        constraint AuthorizedDelete check on delete (
            -- Delete is authorized by a signature over a DISTINCT 'remove'-scoped digest bound
            -- to the row's StampId (cadre-core peer-authorization.ts:cadrePeerRemoveDigest), so
            -- the stored voucher (a signature over digest(PeerId, StampId)) can NEVER be replayed
            -- to authorize a delete. The remove signature rides in context and is never stored.
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(old.PeerId, old.StampId, 'remove'), context.Signature, A.Key, 'ed25519'))
        ),
        constraint AuthorizedUpdate check on update (
            -- Peer self-updates its own addrs + freshness, signing with its OWN ed25519 key
            -- (the key behind PeerId). PeerId/PublicKey/StampId/voucher are immutable on
            -- self-update, UpdatedAt must strictly increase (replay guard), and Sig is verified
            -- against the stored PublicKey over the same payload the publish path signs
            -- (cadre-core peer-record.ts:peerRecordSignedPayload).
            (
                new.PeerId = old.PeerId
                and new.PublicKey = old.PublicKey
                and new.StampId = old.StampId
                and new.VouchAuthority = old.VouchAuthority
                and new.VouchSig = old.VouchSig
                and new.UpdatedAt > coalesce(old.UpdatedAt, 0)
                and verify(
                        digest(new.PeerId || '|' || new.Multiaddr || '|' || cast(new.UpdatedAt as text)),
                        new.Sig, new.PublicKey, 'ed25519')
            )
                -- or an authority re-authorizes (rotation / correction): re-vouches the row over
                -- its current StampId, so the stored voucher is re-bound to the re-authorizing authority.
                or (
                    exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.PeerId, new.StampId), context.Signature, A.Key, 'ed25519'))
                    and new.VouchAuthority = context.AuthorityKey
                    and new.VouchSig = context.Signature
                )
        )
    ) with context (AuthorityKey text null, Signature text);

    -- A mobile cadre peer's platform push token (FCM/APNs), self-published so a
    -- server peer can deliver a push-wake to a suspended app over the platform push
    -- channel (a control-network dial cannot reach an OS-suspended process). The row
    -- mirrors CadrePeer: a resolver re-verifies Sig against the CadrePeer.PublicKey for
    -- this PeerId (see device-token.ts:deviceTokenSignedPayload), checks freshness, then
    -- hands the token to the push sender.
    table DeviceToken (
        PeerId text primary key,        -- the CadrePeer this token belongs to
        Platform text not null,         -- 'fcm' | 'apns'
        Token text not null,            -- opaque platform device/registration token
        UpdatedAt int null,             -- epoch ms; strictly increases per self-update (replay guard)
        Sig text null,                  -- ed25519 self-sig over (PeerId|Platform|Token|UpdatedAt)
        constraint AuthorizedInsert check on insert, delete (
            -- Authorized by an authority key (membership vouch), exactly like CadrePeer.
            -- The single-field digest frames the base58btc PeerId as TEXT.
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(coalesce(new.PeerId, old.PeerId)), context.Signature, A.Key, 'ed25519'))
        ),
        constraint AuthorizedUpdate check on update (
            -- Peer self-updates its own token, signing with its OWN ed25519 key (the key
            -- behind PeerId). PeerId is immutable, UpdatedAt must strictly increase (replay
            -- guard), and Sig is verified against the stored CadrePeer.PublicKey over the
            -- signed payload (cadre-core device-token.ts:deviceTokenSignedPayload). Platform
            -- and Token may change on self-update (platform switch / reinstall / rotation).
            (
                new.PeerId = old.PeerId
                and new.UpdatedAt > coalesce(old.UpdatedAt, 0)
                and exists (select 1 from CadrePeer P where P.PeerId = new.PeerId and verify(
                        digest(new.PeerId || '|' || new.Platform || '|' || new.Token || '|' || cast(new.UpdatedAt as text)),
                        new.Sig, P.PublicKey, 'ed25519'))
            )
                -- or an authority re-authorizes (rotation / correction)
                or exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.PeerId), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text null, Signature text);

    -- An open invitation to form a strand with this party
    table FormationInvite (
        Token text primary key, -- Just a random string
        sAppId text, -- The app for the strand that will be formed
        ExpiresAt datetime null,
        TotalUses int null check (TotalUses >= 0),
        ValidationUrl text null,   -- Web hook - send disclosure, IP address...
        StrandId text null,   -- Host strand this invite binds to (provision-then-record). Non-null => the responder records consent against this pre-existing strand; null => legacy responder-provisions path.
        StampId text not null unique,   -- single-use authorization nonce (anti-replay)
        constraint AuthorizedAddOrRemove check on insert, delete (
            -- Authorized by an authority signing over THIS row
            -- (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId); single-use via unique StampId.
            -- coalesce(new.F, old.F) binds the NEW row on insert and the OLD row on delete (cf. CadrePeer).
            -- StrandId is a nullable bound field: it signs as '' when absent (cf. ValidationUrl).
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(
                digest(
                    coalesce(new.Token, old.Token),
                    coalesce(new.sAppId, old.sAppId),
                    coalesce(cast(coalesce(new.ExpiresAt, old.ExpiresAt) as text), ''),
                    coalesce(cast(coalesce(new.TotalUses, old.TotalUses) as text), ''),
                    coalesce(coalesce(new.ValidationUrl, old.ValidationUrl), ''),
                    coalesce(coalesce(new.StrandId, old.StrandId), ''),
                    coalesce(new.StampId, old.StampId)
                ),
                context.Signature, A.Key, 'ed25519'))
        ),
        -- Invites are insert/delete only: forbid in-place mutation so the row-bound
        -- AuthorizedAddOrRemove signature cannot be sidestepped by updating consent
        -- parameters (TotalUses/ExpiresAt/...) after a legitimate insert. A bare check
        -- defaults to insert+update; the check on insert, delete above excludes update,
        -- so this guard is required. Mirrors FormationUsage.InsertOnly.
        constraint Immutable check on update (false)
    ) with context (AuthorityKey text, Signature text);

    table FormationUsage (
        Token text,
        UseNumber int,
        Disclosure text,
        StrandId text,
        primary key (Token, UseNumber),
        constraint InsertOnly check on update, delete (false),
        constraint Monotonic check (
            -- Read the PRE-transaction snapshot (committed.*): this CHECK auto-defers
            -- to commit (it has a subquery), by which point the row being inserted is
            -- live, so a plain from-FormationUsage would count this row itself and make
            -- UseNumber = max+1 unsatisfiable. committed.* excludes the in-flight row,
            -- giving sequential 1,2,3... per token (cross-transaction; concurrent
            -- redemptions of the same token collide on the (Token, UseNumber) PK).
            new.UseNumber = coalesce((select max(UseNumber) from committed.FormationUsage U where U.Token = new.Token), 0) + 1
        ),
        constraint Authorized check on insert (
            -- Satisfies an invitation
            exists (
                select 1 from FormationInvite FI
                    where FI.Token = new.Token
                        and (FI.TotalUses is null or FI.TotalUses >= new.UseNumber)
                        and (FI.ExpiresAt is null or FI.ExpiresAt > context.Now)
                        and (FI.ValidationUrl is null or verify(digest(new.Token || new.Disclosure), context.ValidationSignature, context.ValidationKey, 'ed25519'))
            )
        ),
        constraint StrandExists check (exists (select 1 from Strand S where S.Id = new.StrandId)),
    ) with context (PeerId text, PeerSignature text, Now datetime, ValidationKey text null, ValidationSignature text null);
}

apply schema CadreControl;`;
