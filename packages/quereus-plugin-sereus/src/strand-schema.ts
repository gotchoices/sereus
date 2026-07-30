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
        -- Deactivation is a CancelledInvite tombstone (below), not a delete of this row
        -- or a state column on it — rationale on that table.
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
    -- No StampId here or on Invite: both tables are insert-only and their primary keys are
    -- minted fresh per issuance/consumption, so a replayed insert collides on the PK.
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
        -- A cancelled invitation may never be consumed. Blocking the ConsumedInvite
        -- insert is sufficient to block the JOIN: Member.Authorized's invite branch
        -- requires a same-transaction FRESH ConsumedInvite row, and consumeInvite writes
        -- both rows in one transaction, so the whole join rolls back. The rule lives here
        -- alone rather than being duplicated into Member.Authorized. Reads only stored
        -- rows — no caller-supplied context decides admission (unlike NotExpired's Now).
        constraint NotCancelled check on insert (
            not exists (select 1 from CancelledInvite C where C.InviteKey = new.InviteKey)
        )
    ) with context (InviteSignature text null, Now datetime null);

    -- A manager has cancelled invitation [InviteKey]: it may never be consumed.
    --
    -- A monotone TOMBSTONE, not a delete of the Invite row and not a state column on it:
    --   1. Deleting the Invite row would re-open a replay surface. InviteValid signs only
    --      (Key, Expiration) — there is no per-row StampId on Invite — so a deleted Invite
    --      row can be re-created by replaying the captured issue signatures. Closing that
    --      would mean adding Invite.StampId and widening Revocation.RowIsGone to a fourth
    --      table. (CadreControl.FormationInvite IS deletable — it carries a StampId for
    --      exactly this reason.)
    --   2. A state column needs an UPDATE, and Invite is insert-only on purpose.
    --   3. Insert-only converges: a growing set of dead markers merges cleanly across
    --      nodes, a delete/re-insert pair does not. Same rationale as Strand.Revocation.
    -- No StampId here: the table is insert-only and its primary key IS the invite key, so
    -- a replayed insert collides on the PK — the argument the comment above ConsumedInvite
    -- makes for Invite/ConsumedInvite.
    -- Deliberately NO InviteExists gate: a node that has not yet converged on the Invite
    -- row must still be able to record the cancellation. Refusing it would fail OPEN on a
    -- security control, which is strictly worse than accepting a junk row.
    -- NOTE: this table only grows — one row per cancellation, plus any junk a manager
    -- chooses to file, and Immutable means rows never go away (the tradeoff
    -- Revocation.RowIsGone already documents for junk stamps). Fine at strand scale; if
    -- invite churn ever gets large it needs pruning bounded by something other than
    -- "forever".
    -- NOTE: a cancellation must PROPAGATE before the holder redeems — a holder consuming
    -- on a node that has not yet seen this row still gets in. Same convergence class as
    -- the NotRevoked / MinOneMember / MinOneManager local-visibility notes; not solved here.
    table CancelledInvite (
        InviteKey text primary key,
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        -- Cancellation is permanent: un-cancelling would restore the re-entry it closed.
        -- To re-invite a party, issue a fresh invitation.
        constraint Immutable check on update, delete (false),
        -- committed.Manager, not Manager: this check has a subquery so it defers to
        -- commit, by which point a manager seated in the SAME transaction would otherwise
        -- be able to authorize its own cancellation. Member, MemberPeer and Revocation
        -- read committed.* for the same reason. (Manager.Authorized reads the LIVE table
        -- instead — there it is the strict Generation ordering, not a snapshot, that
        -- excludes an authorizer seated in the same transaction.)
        constraint Authorized check on insert (
            exists (select 1 from committed.Manager A
                where A.MemberKey = context.ManagerKey
                    and verify(digest('Strand.CancelledInvite', 'cancel', new.InviteKey),
                               context.ManagerSignature, A.MemberKey, 'ed25519'))
        )
    ) with context (ManagerKey text, ManagerSignature text);

    -- A party in the closed strand network
    table Member (
        Key text primary key,
        StampId text not null unique,   -- per-row authorization nonce, bound into the signed digests below.
                                        -- unique holds over LIVE rows only; a removed row's stamp is retired
                                        -- permanently into Revocation (NotRevoked below), so the never-expiring
                                        -- admission signature cannot resurrect a revoked member.
        -- A removed row's StampId is retired into Revocation, and this refuses any insert
        -- naming a retired stamp: the approval that seated this row can never re-seat it
        -- after removal. unique alone did not do this — it only holds over LIVE rows, so
        -- a delete freed the stamp and the original never-expiring signature verified
        -- again. A legitimate re-add mints a FRESH StampId and a fresh signature, so it is
        -- unaffected. Mirrors CadreControl.OwnerKey.NotRevoked (rationale in full there).
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'Member' and R.StampId = new.StampId)
        ),
        -- Retirement is MANDATORY: a delete must carry the matching Revocation row in the
        -- same transaction, or the stamp would free up again. Deferred (subquery), so the
        -- sibling insert is visible at commit regardless of statement order.
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'Member' and R.StampId = old.StampId)
        ),
        -- Membership is insert + delete only; a re-keyed member is a remove + fresh add.
        constraint NoUpdate check on update (false),
        -- Mask is explicit on all three operations: a bare check defaults to
        -- insert|update and silently never runs on DELETE.
        constraint OnlyClosed check on insert, update, delete (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        -- A closed strand must never lose its last member: Member is the strand's read
        -- gate, and the founding Manager is only seatable beside an existing Member, so
        -- an empty member set is a permanent denial of the whole strand. Deferred
        -- (subquery), so the count it sees is the POST-delete count.
        -- NOTE: this is a per-transaction check against locally visible rows. Two nodes
        -- that concurrently remove different members can each see a surviving one and
        -- still converge to zero; if partitioned removal ever becomes a real workflow,
        -- the floor needs a cross-node guard, not a local count.
        constraint MinOneMember check on delete (
            (select count(1) from Member) >= 1
        ),
        -- A member still holding a Manager row cannot be un-membered — it must resign
        -- its Manager row first. Deferred (subquery), so it reads the POST-image: a
        -- single transaction deleting BOTH the Manager and the Member row passes.
        constraint NotAManager check on delete (
            not exists (select 1 from Manager A where A.MemberKey = old.Key)
        ),
        constraint Authorized check on insert, delete (
            -- Every authorizer is read from the PRE-transaction snapshot (committed.*):
            -- this CHECK auto-defers to commit (it has a subquery), by which point rows
            -- inserted alongside are live, so a plain from-Manager would let a manager
            -- seated in this same transaction authorize a removal. committed.* states
            -- the rule directly: the authorizer existed BEFORE this transaction.

            -- Every signed digest below leads with two fixed literals — the
            -- 'Strand.Member' domain tag and an action tag — so an approval verifies
            -- ONLY against the one rule it was minted for (the idiom of CadreControl's
            -- control-authorization.ts), and binds the row's StampId, so it authorizes
            -- exactly one INCARNATION of the row: once the row is deleted (retiring the
            -- stamp) or re-created under a fresh stamp, the captured approval matches
            -- nothing.

            -- Bootstrap: the FOUNDING transaction — one whose pre-transaction member
            -- set is empty — seats the first member, AND ONLY THAT ONE, with no
            -- authorization. Both counts are load-bearing. The committed (PRE-image)
            -- count keeps the branch off for a DELETE and for the insert half of a
            -- same-transaction wipe-then-seat (the wiped rows were committed). The
            -- live (POST-image) count keeps a single founding transaction from
            -- seating an unbounded unauthenticated member set — which would also
            -- brick the strand, since Manager's own bootstrap branch requires at
            -- most one Member.
            (old.Key is null
                and (select count(1) from committed.Member) = 0
                and (select count(1) from Member) <= 1)

                -- or added directly by a pre-existing manager signing the add-tagged
                -- digest over (Key, StampId) — bound to this row's fresh stamp, so the
                -- approval seats exactly this incarnation and dies with it.
                or (old.Key is null and exists (
                    select 1 from committed.Manager A
                        where A.MemberKey = context.ManagerKey
                            and verify(digest('Strand.Member', 'add', new.Key, new.StampId), context.ManagerSignature, A.MemberKey, 'ed25519')
                ))

                -- or added by consuming an invite. The ConsumedInvite admitting this
                -- member must be same-transaction FRESH — its InviteKey absent from the
                -- committed snapshot. consumeInvite inserts Member + ConsumedInvite in
                -- one transaction, so a genuine join passes; a revoked member's STALE
                -- committed row no longer re-admits it, while a fresh manager-issued
                -- invite still does (new InviteKey → uncommitted row). InviteExists +
                -- ValidUsage on ConsumedInvite keep this branch mintable only via a
                -- real invite and possession of its private key.
                or (old.Key is null and exists (
                    select 1 from ConsumedInvite CI
                        where CI.MemberKey = new.Key
                            and not exists (select 1 from committed.ConsumedInvite CC where CC.InviteKey = CI.InviteKey)
                ))

                -- or a removal authorized by a pre-existing manager over the DISTINCT
                -- remove-tagged digest bound to the departing row's (Key, StampId).
                or (new.Key is null and exists (
                    select 1 from committed.Manager A
                        where A.MemberKey = context.ManagerKey
                            and verify(digest('Strand.Member', 'remove', old.Key, old.StampId), context.ManagerSignature, A.MemberKey, 'ed25519')
                ))

                -- or the member removes ITSELF (leaving): the leave-tagged signature
                -- verifies against old.Key itself, so only the departing key's holder
                -- can produce it — no manager involved. The 'leave' tag (vs the manager
                -- branch's 'remove') is belt-and-braces ONLY: the two branches verify
                -- against DIFFERENT keys, so the former shared tag was never
                -- exploitable — the anti-replay fix here is the StampId binding, not
                -- this tag.
                or (new.Key is null
                    and verify(digest('Strand.Member', 'leave', old.Key, old.StampId), context.MemberSignature, old.Key, 'ed25519'))
        ),
    ) with context (ManagerKey text null, ManagerSignature text null, MemberSignature text null);

    -- A member-associated peer (node)
    --
    -- NOTE: a MemberPeer row can OUTLIVE the Member row it names. MemberExists runs on
    -- insert only, and nothing cascades a Member delete, so revoking a member leaves its
    -- peer bindings behind as orphans until a manager clears them (removeMemberPeer).
    -- Any consumer that treats a MemberPeer row as evidence of membership MUST join to
    -- Member rather than trusting the row alone.
    table MemberPeer (
        MemberKey text,
        PeerId text,
        StampId text not null unique,   -- per-row authorization nonce, bound into the signed
                                        -- digests below; retired into Revocation on delete
                                        -- (same idiom as Member.StampId, rationale there).
        primary key (MemberKey, PeerId),
        -- Refuses any insert naming a retired stamp — see Member.NotRevoked.
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'MemberPeer' and R.StampId = new.StampId)
        ),
        -- A delete must retire its stamp in the same transaction — see Member.RevocationRecorded.
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'MemberPeer' and R.StampId = old.StampId)
        ),
        -- Binding is insert + delete only, as on Member and Manager; a re-binding is a
        -- remove plus a fresh register. The whole visible identity IS the primary key, so
        -- an update is never an edit — and Authorized reads the NEW image, so an update
        -- would let ANY member re-point another member's row at its OWN key, signing only
        -- over its own new values, and thereby clear a binding it has no signature to
        -- delete.
        constraint NoUpdate check on update (false),
        -- Mask is explicit: a bare check defaults to insert|update and silently never runs on
        -- DELETE. Insert is the only reachable case — update is forbidden above, and a delete
        -- leaves no new row image to validate.
        constraint MemberExists check on insert (exists (select 1 from Member M where M.Key = new.MemberKey)),
        constraint Authorized check on insert, delete (
            -- The member itself signs its own binding, verified against the MemberKey the
            -- row names — so only that member registers (or removes) its own peers. The
            -- registration and removal approvals are DISTINCT action-tagged digests, each
            -- bound to the row's StampId, so a captured registration approval neither
            -- re-registers a cleared binding (its stamp is retired) nor authorizes a
            -- removal (wrong tag).
            (old.MemberKey is null
                and verify(digest('Strand.MemberPeer', 'add', new.MemberKey, new.PeerId, new.StampId), context.Signature, new.MemberKey, 'ed25519'))

                -- or the member clears its OWN binding.
                or (new.MemberKey is null
                    and verify(digest('Strand.MemberPeer', 'remove', old.MemberKey, old.PeerId, old.StampId), context.Signature, old.MemberKey, 'ed25519'))

                -- or a manager clears ANOTHER member's binding — the cleanup path after a
                -- revocation, which the departing member has no reason to cooperate with.
                -- Gated to DELETE and bound to a manager-remove-tagged digest over the exact
                -- row + stamp. The 'manager-remove' tag (vs the self branch's 'remove') is
                -- belt-and-braces ONLY — the two branches verify against different keys.
                -- The authorizer is read from the PRE-transaction snapshot
                -- (committed.Manager) for the same reason Member.Authorized does: this check
                -- defers to commit, by which point a manager seated in the SAME transaction
                -- would otherwise be able to authorize its own cleanup.
                or (new.MemberKey is null and exists (
                    select 1 from committed.Manager A
                        where A.MemberKey = context.ManagerKey
                            and verify(digest('Strand.MemberPeer', 'manager-remove', old.MemberKey, old.PeerId, old.StampId), context.ManagerSignature, A.MemberKey, 'ed25519')
                ))
        ),
    ) with context (Signature text null, ManagerKey text null, ManagerSignature text null);

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
        StampId text not null unique,   -- per-row authorization nonce, bound into the signed
                                        -- digests below; retired into Revocation on delete
                                        -- (same idiom as Member.StampId, rationale there).
        -- Refuses any insert naming a retired stamp — see Member.NotRevoked. This is what
        -- makes a captured promotion approval single-use: once the manager is removed (its
        -- stamp retired), the approval that seated it can never re-seat it.
        constraint NotRevoked check on insert (
            not exists (select 1 from Revocation R where R.TableName = 'Manager' and R.StampId = new.StampId)
        ),
        -- A delete must retire its stamp in the same transaction — see Member.RevocationRecorded.
        constraint RevocationRecorded check on delete (
            exists (select 1 from Revocation R where R.TableName = 'Manager' and R.StampId = old.StampId)
        ),
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        -- A manager IS a member: the table comment has always said so, and since the
        -- single-use-approval work it is load-bearing — Revocation.Authorized verifies a
        -- delete's tombstone against a committed Member row, so a manager with no Member
        -- row cannot revoke, clear a peer binding, or even resign. Reads the LIVE Member
        -- table, not committed.Member, so an admit-then-promote in ONE transaction passes
        -- (the same shape ConsumedInvite.MemberExists allows for the invite join); the
        -- sibling Member insert is authorized at that same commit, so nothing is waived.
        -- Mask is explicit: a bare check defaults to insert|update, and update is
        -- forbidden outright by NoUpdate below. Nothing is needed on DELETE — the other
        -- half of the invariant is Member.NotAManager, which refuses to un-member a key
        -- that still holds a Manager row.
        -- NOTE: a per-transaction check against locally visible rows. Two partitioned nodes
        -- — one promoting X, one removing X's Member and Manager rows — can each pass
        -- locally and converge to a Manager row with no Member row. Same convergence class
        -- as the MinOneMember / MinOneManager / NotRevoked notes; not solved here.
        constraint MemberExists check on insert (
            exists (select 1 from Member M where M.Key = new.MemberKey)
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
            -- Every signed branch below is a domain/action-tagged digest bound to the
            -- row's StampId — the same single-use idiom as Member.Authorized: an
            -- approval seats (or removes) exactly one incarnation of one row.

            -- Bootstrap: the founding manager is seated with no prior signer, at
            -- generation 0. Gated to INSERT (old.MemberKey is null) AND to the founding
            -- state — at most one Member, and this manager IS that member. Deferred
            -- checks see post-image state, so an ungated count test is also true for a
            -- DELETE that drops the count to <= 1, and for the INSERT half of a
            -- same-transaction swap of the sole manager. The trailing Member-exists test
            -- is belt-and-braces since MemberExists above enforces it on EVERY insert —
            -- kept so this branch's own claim ("this manager IS that member") reads in
            -- place rather than by cross-reference.
            (old.MemberKey is null
                and new.Generation = 0
                and (select count(1) from Manager) <= 1
                and (select count(1) from Member) <= 1
                and exists (select 1 from Member M where M.Key = new.MemberKey))

                -- or authorized by this former manager (self-resignation), over the
                -- resign-tagged digest bound to its own row's stamp. The 'resign' tag
                -- (vs the admin branch's 'remove') is belt-and-braces — the two
                -- branches verify against different keys; the anti-replay fix is the
                -- stamp: once this manager is re-promoted under a fresh stamp, a
                -- captured resignation no longer removes it.
                or (
                    old.MemberKey is not null
                        and old.MemberKey = context.ManagerKey
                        and verify(digest('Strand.Manager', 'resign', old.MemberKey, old.StampId), context.Signature, old.MemberKey, 'ed25519')
                )

                -- or a promotion signed by an EARLIER-generation manager, over the
                -- add-tagged digest binding (MemberKey, Generation, StampId) — so a
                -- captured promotion replays at neither a different generation nor a
                -- second incarnation of the row. The strict
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
                            and verify(digest('Strand.Manager', 'add', new.MemberKey, new.Generation, new.StampId), context.Signature, A.MemberKey, 'ed25519')))

                -- or a removal authorized by ANOTHER existing manager, over the
                -- remove-tagged digest bound to (MemberKey, StampId). Deliberately no
                -- generation condition here: deletes are safe once inserts are (every
                -- accepting branch requires a Manager row in the post-image, and no
                -- attacker row can get there), and a generation gate would break a
                -- later-generation manager removing an earlier-generation one.
                or (new.MemberKey is null and exists (
                    select 1 from Manager A
                        where A.MemberKey = context.ManagerKey
                            and A.MemberKey <> old.MemberKey
                            and verify(digest('Strand.Manager', 'remove', old.MemberKey, old.StampId), context.Signature, A.MemberKey, 'ed25519')))
        )
    ) with context (ManagerKey text null, Signature text null);

    -- Permanent tombstones for retired per-row authorization nonces (StampIds) — the
    -- delete half of the retired-stamp anti-replay idiom on Member / Manager /
    -- MemberPeer. Adapted from CadreControl.Revocation (the idiom is stated in full on
    -- CadreControl.OwnerKey); two deliberate differences:
    --   1. TableName is confined to the three guarded STRAND tables (RowIsGone below).
    --   2. Authorized verifies against a committed MEMBER row, not an owner key: every
    --      delete path in this schema is driven by a manager or by the departing party,
    --      and both are members. The action tag is 'retire' where the control layer
    --      says 'remove'; the domain tag already keeps the two schemas' approvals
    --      disjoint, so the divergence is cosmetic — kept because 'retire' names the
    --      act (retiring a stamp), not a row operation.
    -- NOTE: the guarded tables' NotRevoked CHECK runs against locally visible rows, so
    -- a node that has not yet converged on a Revocation row can still accept a replayed
    -- add and the resurrected row coexists with the tombstone after merge — the same
    -- convergence class as the MinOneMember / MinOneManager local-count notes.
    -- NOTE: this table only grows — one row per membership deletion, plus any junk any
    -- member chooses to file, and Immutable means rows never go away. Fine at strand
    -- scale; if membership churn ever gets large it needs pruning bounded by something
    -- other than "forever".
    -- NOTE: nothing on the strand read side drops a row because its stamp is retired
    -- (NotRevoked is insert-only), which is why a tombstone filed against a live but
    -- not-yet-converged row is inert here. If a read path ever starts filtering on
    -- Revocation (as the control layer's listAuthorizedMembers does), filing a tombstone
    -- becomes a remote eviction primitive and Authorized below must narrow from "any
    -- member" to "a manager, or the row's own owner".
    table Revocation (
        TableName text,             -- 'Member' | 'Manager' | 'MemberPeer' (confined by RowIsGone below)
        StampId text,               -- the retired nonce
        primary key (TableName, StampId),
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        -- Retirement is permanent: clearing or re-pointing a tombstone would restore the replay.
        constraint Immutable check on update, delete (false),
        -- A stamp may only be retired once its row is actually gone. Deferred (subquery), so a
        -- delete in the same transaction has already landed. Retiring a stamp that never
        -- existed is permitted and harmless: a stamp carries 256 bits of CSPRNG output
        -- (strand-membership-writer.ts generateStrandStampId), so a future legitimate one
        -- cannot be guessed and pre-planted — junk stamps only grow the table.
        constraint RowIsGone check on insert (
            (new.TableName = 'Member' and not exists (select 1 from Member M where M.StampId = new.StampId))
                or (new.TableName = 'Manager' and not exists (select 1 from Manager A where A.StampId = new.StampId))
                or (new.TableName = 'MemberPeer' and not exists (select 1 from MemberPeer P where P.StampId = new.StampId))
        ),
        -- Filing a tombstone is a MEMBER action: every legitimate delete in this schema is
        -- driven by a manager or by the departing party — both members — and the tombstone
        -- rides the delete's own transaction. The authorizer is read from the
        -- PRE-transaction snapshot (committed.Member) for the same reason the sibling
        -- tables read committed.*: this check defers to commit, by which point a member
        -- seated in the same transaction is live. The digest binds the WHOLE row
        -- (TableName, StampId) under its own domain tag, so it is disjoint from every
        -- other rule — including the remove-tagged approval the same party signs in the
        -- SAME transaction for the delete this tombstone accompanies. RowIsGone and
        -- Immutable guard what authorization does not: retiring a stamp early, or
        -- withdrawing one later.
        constraint Authorized check on insert (
            exists (select 1 from committed.Member M
                where M.Key = context.MemberKey
                    and verify(digest('Strand.Revocation', 'retire', new.TableName, new.StampId), context.Signature, M.Key, 'ed25519'))
        )
    ) with context (MemberKey text, Signature text);
`;
