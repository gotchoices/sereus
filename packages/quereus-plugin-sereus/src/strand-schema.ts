/**
 * Embedded strand membership/RBAC schema for cross-platform compatibility.
 *
 * This is the authoritative runtime copy of the `Strand` membership schema. It
 * is duplicated from `schemas/strand.qsql` so that React Native and other
 * filesystem-less environments get the schema without a runtime file read —
 * the same pattern `CONTROL_SCHEMA` (cadre-core) uses for the control schema.
 *
 * `STRAND_SCHEMA` holds only the *body* (the inner table declarations). The
 * shared composition (`composeStrand`) wraps it in
 * `declare schema Strand { ... } apply schema Strand;`, mirroring how the sApp
 * schema is wrapped in `declare schema App { ... }`.
 *
 * Drift discipline: the table declarations here MUST stay byte-equivalent to the
 * body of `schemas/strand.qsql` (the on-disk canonical copy). Any edit here must
 * be mirrored there and vice versa — the same invariant the planned
 * `control-schema-drift-guard` enforces for the control schema.
 *
 * Crypto idiom (matches `schemas/control.qsql` and the sApp RBAC fixture
 * `packages/integration-tests/fixtures/simple-sapp.qsql`): every signed write
 * proves itself with `verify(digest(<single joined payload>),
 * <signature>, <pubkey>, 'ed25519')`. Member keys are ed25519, so the explicit
 * curve arg is REQUIRED (verify() otherwise defaults to secp256k1).
 *
 * Population note: this ticket applies the schema and makes its constraints
 * active — it does NOT write membership rows at runtime. Inserting the `Header`,
 * the founding `Manager`/`Member`, and the invite/peer flows is owned by
 * `strand-membership-lifecycle-population`.
 */
export const STRAND_SCHEMA = `    table Header (
        Id text,    -- UUID of this network - generated at inception - immutable

        -- Types: 'o' = Open, 'c' = Closed
        -- Any peers can join an open network, but only members can join a closed network
        -- Open can still control writes in the app, but only Closed prevents reads
        Type text check (Type in ('o', 'c')),

        -- The app that this strand faciliates - public key from author to prevent tampering
        sAppId text,

        -- The version of the sApp that this strand faciliates
        sAppVersion text,

        -- The schema of the sApp that this strand faciliates
        sAppSchema text,

        -- The author's signature on the schema to guarantee authorship
        sAppSignature text,

        -- The engine (rules logic system) that is assumed to manage this strand
        Engine text,

        -- The version of the engine that is assumed to manage this strand
        EngineVersion text,

        primary key (/* empty - singleton */),
        constraint InsertOnly check on update, delete (false),  -- One-time insert only for now - TODO: revisit for versioning
    );

    -- An invitation to join a strand as a member
    table Invite (
        Key text primary key,
        Expiration datetime null,
        -- TODO: ability to deactivate?
        constraint InsertOnly check on update, delete (false),
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        constraint InviteValid check on insert (
            -- Can only be inserted by a manager,
            exists (select 1 from Manager A
                where A.MemberKey = context.ManagerKey
                    and verify(digest(new.Key || '|' || coalesce(new.Expiration, '')), context.ManagerSignature, A.MemberKey, 'ed25519')
            )
                -- and must also prove invite private key held by issuing manager
                and verify(digest(new.Key || '|' || coalesce(new.Expiration, '')), context.InviteSignature, new.Key, 'ed25519')
        )
    ) with context (ManagerKey text null, ManagerSignature text null, InviteSignature text null);

    -- Invite [InviteKey] has been used to add [MemberKey] as a member
    table ConsumedInvite (
        InviteKey text primary key,
        MemberKey text,
        constraint InsertOnly check on update, delete (false),
        constraint InviteExists check (exists (select 1 from Invite I where I.Key = new.InviteKey)),
        constraint MemberExists check (exists (select 1 from Member M where M.Key = new.MemberKey)),
        constraint ValidUsage check on insert (
            exists (select 1 from Invite I where I.Key = new.InviteKey and verify(digest(new.InviteKey || '|' || new.MemberKey), context.InviteSignature, new.InviteKey, 'ed25519'))
        ),
        -- An invite with a non-null Expiration may only be consumed while it is still
        -- in the future. context.Now is the canonical-datetime "now" supplied by the
        -- consumeInvite writer (same canonicalDatetime() transform used to store
        -- Invite.Expiration), so both sides of the comparison are byte-identical
        -- canonical strings and the lexical ">" comparison orders chronologically. A
        -- null Expiration never expires. Mirrors CadreControl.FormationUsage's
        -- "FI.ExpiresAt is null or FI.ExpiresAt > context.Now" gate.
        constraint NotExpired check on insert (
            exists (select 1 from Invite I where I.Key = new.InviteKey and (I.Expiration is null or I.Expiration > context.Now))
        ),
        constraint MemberValid check (exists (select 1 from Member M where M.Key = new.MemberKey))
    ) with context (InviteSignature text null, Now datetime null);

    -- A party in the closed strand network
    table Member (
        Key text primary key,
        constraint NoUpdate check on update (false),
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        constraint Authorized check on insert (
            -- There are no other records - first member needs no authorization
            (select count(1) from Member) <= 1

                -- or added directly by manager
                or exists (
                    select 1 from Manager A
                        where A.MemberKey = context.ManagerKey
                            and verify(digest(new.Key), context.ManagerSignature, A.MemberKey, 'ed25519')
                )

                -- or added by invite
                or exists (
                    select 1 from ConsumedInvite CI where CI.MemberKey = new.Key
                )
        ),
        -- TODO: handle member revocation constraint
    ) with context (ManagerKey text null, ManagerSignature text null);

    -- A member-associated peer (node)
    table MemberPeer (
        MemberKey text,
        PeerId text,
        primary key (MemberKey, PeerId),
        constraint MemberExists check (exists (select 1 from Member M where M.Key = new.MemberKey)),
        constraint Authorized check on insert, update, delete (
            verify(
                digest(coalesce(new.MemberKey, old.MemberKey) || '|' || coalesce(new.PeerId, old.PeerId)),
                context.Signature,
                coalesce(new.MemberKey, old.MemberKey),
                'ed25519'
            )
        ),
    ) with context (Signature text null);

    -- A manager is a member that can issue invites, authorize members, and rotate managers
    table Manager (
        MemberKey text primary key,
        -- Lineage ordering. The founding manager is generation 0; every later manager is
        -- seated strictly after (greater than) the manager that appointed it. This is what
        -- makes same-transaction mutual promotion impossible: a deferred CHECK sees only
        -- the post-image, so "did my authorizer exist before this transaction?" is not
        -- directly askable — but the minimum-generation row of any inserted set must find
        -- its authorizer among rows of strictly smaller generation, which can only be a
        -- pre-existing one. Generation is NOT a privilege level: a generation-5 manager
        -- has exactly the same powers as a generation-1 manager.
        Generation integer not null,
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        -- Rotation is insert + delete only. An update would let a resignation signature
        -- (which proves only that old.MemberKey consented) double as a hand-off: the
        -- former-manager branch would accept re-pointing the row at any new key.
        constraint NoUpdate check on update (false),
        -- A closed strand must never lose its last manager. Every admit path (Invite,
        -- addMemberByManager, addManager) requires an existing Manager row, so an
        -- admin-less strand can never admit anyone again. Deferred (subquery), so the
        -- count it sees is the POST-delete count.
        -- NOTE: this is a per-transaction check against locally visible rows. Two nodes
        -- that concurrently remove different managers can each see a surviving one and
        -- still converge to zero; if partitioned rotation ever becomes a real workflow,
        -- the floor needs a cross-node guard, not a local count.
        constraint MinOneManager check on delete (
            (select count(1) from Manager) >= 1
        ),
        constraint Authorized check on insert, delete (
            -- Bootstrap: the founding manager is seated with no prior signer, at
            -- generation 0. Gated to INSERT (old.MemberKey is null) AND to the founding
            -- state — at most one Member, and this manager IS that member. Deferred
            -- checks see post-image state, so an ungated count test is also true for a
            -- DELETE that drops the count to <= 1, and for the INSERT half of a
            -- same-transaction swap of the sole manager.
            (old.MemberKey is null
                and new.Generation = 0
                and (select count(1) from Manager) <= 1
                and (select count(1) from Member) <= 1
                and exists (select 1 from Member M where M.Key = new.MemberKey))

                -- or authorized by this former manager (self-resignation)
                or (
                    old.MemberKey is not null
                        and old.MemberKey = context.ManagerKey
                        and verify(digest(old.MemberKey), context.Signature, old.MemberKey, 'ed25519')
                )

                -- or a promotion signed by an EARLIER-generation manager. The strict
                -- A.Generation < new.Generation is what closes same-transaction mutual
                -- promotion: this subquery runs at commit against the post-insert row
                -- set, so sibling rows inserted in the same transaction are visible —
                -- but the minimum-generation row of any inserted set cannot find its
                -- authorizer among its siblings (that would contradict minimality), so
                -- that authorizer must be a pre-existing manager who really signed.
                -- A mutual pair or ring needs each generation strictly below another's
                -- in a cycle; impossible. Nothing sits below the founder's 0, so a
                -- chain cannot duck underneath either. The <> is subsumed by the
                -- ordering (a row's generation is never below its own) but kept to
                -- state the no-self-promotion intent locally.
                or (old.MemberKey is null and exists (
                    select 1 from Manager A
                        where A.MemberKey = context.ManagerKey
                            and A.MemberKey <> new.MemberKey
                            and A.Generation < new.Generation
                            and verify(digest(new.MemberKey || '|' || new.Generation), context.Signature, A.MemberKey, 'ed25519')))

                -- or a removal authorized by ANOTHER existing manager. Deliberately no
                -- generation condition here: deletes are safe once inserts are (every
                -- accepting branch requires a Manager row in the post-image, and no
                -- attacker row can get there), and a generation gate would break a
                -- later-generation manager removing an earlier-generation one. The
                -- payload stays digest(old.MemberKey) — distinct from the insert
                -- payload, which also carries the generation.
                or (new.MemberKey is null and exists (
                    select 1 from Manager A
                        where A.MemberKey = context.ManagerKey
                            and A.MemberKey <> old.MemberKey
                            and verify(digest(old.MemberKey), context.Signature, A.MemberKey, 'ed25519')))
        )
    ) with context (ManagerKey text null, Signature text null);
`;
