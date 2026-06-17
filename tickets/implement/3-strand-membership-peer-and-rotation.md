description: Let a strand member register which network nodes act on its behalf, and let a strand admin promote or remove other admins — both authorized by signatures the strand verifies.
prereq: strand-membership-founder-bootstrap
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/index.ts, schemas/strand.qsql
difficulty: medium
----

## Context

Depends only on `strand-membership-founder-bootstrap` (it needs an existing `Member` and an
existing `Authority` — the founder provides both — plus the `signStrandPayload` primitive). It is
independent of `strand-membership-invite-join` and may run in parallel after ticket 1. Adds the
two remaining founder-reachable writers: **`MemberPeer` registration** and **`Authority`
rotation** (add/remove).

## Constraints being satisfied (from `schemas/strand.qsql`)

- **`MemberPeer.Authorized`** — payload
  `coalesce(new.MemberKey,old.MemberKey) || '|' || coalesce(new.PeerId,old.PeerId)`:
  `verify(digest(payload,'sha256','utf8'), context.Signature, coalesce(new.MemberKey,old.MemberKey), 'ed25519')`
  — the member signs with its **own** key. Plus deferred `MemberExists` (the `Member` row must
  exist). PK is `(MemberKey, PeerId)`. Context: `Signature`.
- **`Authority.Authorized`** — three branches:
  - bootstrap `(select count(1) from Authority) <= 1` (already used by ticket 1 founder), else
  - existing-authority adds another: payload `coalesce(new.MemberKey,old.MemberKey)`,
    `verify(digest(payload,...), context.Signature, A.MemberKey, 'ed25519')` for some
    `A.MemberKey = context.AuthorityKey`, else
  - former-authority self (delete branch): `old.MemberKey = context.AuthorityKey` AND
    `verify(digest(old.MemberKey,...), context.Signature, old.MemberKey, 'ed25519')`.
  - Context: `AuthorityKey`, `Signature`.

## API shape (in `strand-membership-writer.ts`)

- `registerMemberPeer(db, { memberKeyPair, peerId }): Promise<void>` — member self-signs
  `MemberKey || '|' || PeerId`, insert `MemberPeer (MemberKey, PeerId)` with
  `with context Signature=?`. `memberKeyPair` is the member's `{ privateKeyB64, publicKeyB64 }`
  (founder via `strandMemberKeyPair`; an invited member via its own keypair).
- `addAuthority(db, { byAuthorityKeyPair, newAuthorityKey }): Promise<void>` — an existing
  authority signs `digest(newAuthorityKey)` and inserts `Authority (MemberKey=newAuthorityKey)`
  with `with context AuthorityKey=<by pub>, Signature=?`.
- `removeAuthority(db, { byAuthorityKeyPair, targetAuthorityKey }): Promise<void>` — delete an
  `Authority` row. The schema's `Authority.Authorized` allows removal via the existing-authority
  branch (another authority signs `coalesce(new.MemberKey, old.MemberKey)` = `old.MemberKey`) or
  the former-authority self branch (`old.MemberKey = context.AuthorityKey`). Pick the
  existing-authority branch for admin-driven removal and the self branch for self-resignation;
  build the `with context` accordingly. Note `coalesce(new,old)` binds `old` on delete.

Tables addressed as `Strand.MemberPeer`, `Strand.Authority`.

## Edge cases & interactions

- **Member self-signature only**: a `MemberPeer` insert signed by a key other than its own
  `MemberKey` must be rejected. Cover.
- **Peer for a non-member**: `registerMemberPeer` for a `MemberKey` with no `Member` row must be
  rejected (deferred `MemberExists`).
- **Composite-PK duplicates**: inserting the same `(MemberKey, PeerId)` twice should be a no-op
  or a clean PK rejection — decide and assert; make `registerMemberPeer` insert-if-absent so a
  re-register on restart is safe. A member may register multiple distinct `PeerId`s (multi-device).
- **`MemberPeer` delete gap (pre-existing)**: `MemberExists` reads `new.MemberKey`, which is null
  on delete, so peer-row deletes are currently rejected by the schema (noted in the
  `apply-strand-membership-schema` review). This ticket does **not** add peer deletion; document
  that `removeMemberPeer` is out of scope and why (a schema tweak would be needed).
- **Authority add by non-authority**: `addAuthority` whose `byAuthorityKeyPair` is not in
  `Authority` must be rejected (no `count<=1` shortcut once the founder authority exists).
- **Authority add signature binding**: a valid add signs `digest(newAuthorityKey)`; a signature
  over the wrong key must be rejected.
- **Self-resignation vs admin-removal**: test both `removeAuthority` branches — an authority
  removing a *different* authority (existing-authority branch) and an authority removing *itself*
  (former-authority self branch). A non-authority attempting removal must be rejected.
- **Last-authority removal**: removing the only remaining authority would orphan the strand
  (no one can ever add another). The schema does not prevent it. Document this as a known
  hazard; do NOT add a guard here unless trivial — if non-trivial, file a `backlog/` ticket for a
  "min-one-authority" invariant rather than growing this ticket.
- **Open strand**: `MemberPeer`/`Authority` are `OnlyClosed` (Authority) / require a `Member`
  (MemberPeer, members only exist on closed strands). Assert these writes are rejected / not
  applicable on an open strand.
- **bootstrap-mode rejection rollback**: same caveat as ticket 2 — rejection assertions use
  "throws" as the floor; do not chase the optimystic rollback bug here.

## TODO

### Phase 1 — MemberPeer
- `registerMemberPeer` (insert-if-absent, self-signed). Component test against a real closed
  strand DB (founder bootstrapped): founder registers a peer → one `MemberPeer` row; wrong-signer
  rejected; non-member rejected; multi-peer for one member; re-register no-op.

### Phase 2 — Authority rotation
- `addAuthority` + `removeAuthority` (both branches). Tests: existing authority adds a second
  authority; non-authority add rejected; wrong-key-signature add rejected; admin-removal of
  another authority; self-resignation; non-authority removal rejected.

### Phase 3 — validate
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cc-peer.log` (stream). Lint + typecheck
  changed files.
- Update `docs/architecture.md` membership section with peer registration + authority rotation.
