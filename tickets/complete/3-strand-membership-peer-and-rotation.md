description: Reviewed and accepted the new code that lets a strand member register the network nodes acting for it, and lets strand admins promote or remove other admins.
prereq:
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, schemas/strand.qsql, docs/architecture.md
----

## What landed (implement stage)

Three founder-reachable `Strand.*` writers in `strand-membership-writer.ts`, exported from
`index.ts`, plus a 14-test component spec against a real closed strand DB in bootstrap mode:

- **`registerMemberPeer(db, { memberKeyPair, peerId })`** — a member self-signs
  `MemberKey || '|' || PeerId` with its OWN key; `MemberPeer.Authorized` verifies against the
  member key itself. Insert-if-absent on the composite PK `(MemberKey, PeerId)`.
- **`addAuthority(db, { byAuthorityKeyPair, newAuthorityKey })`** — an existing authority signs
  `digest(newAuthorityKey)` and inserts an `Authority` row (existing-authority branch).
- **`removeAuthority(db, { byAuthorityKeyPair, targetAuthorityKey })`** — deletes an `Authority`
  row; one signed-context construction serves both admin-removal and self-resignation branches.

Also refreshed stale "ticket 3" forward-references in `strand-member-registry.ts` (comment/log
only) and added an `architecture.md` subsection.

## Review findings

### Validation run (all green)
- `yarn workspace @serfab/cadre-core test strand-membership-peer-rotation` → **14 passed**.
- `yarn workspace @serfab/cadre-core test` (full suite) → **525 passed, 39 files**, no regressions.
- `yarn workspace @serfab/cadre-core typecheck` → **clean**.
- `npx eslint` on all four changed files → **clean** (exit 0).

### Code quality (SPP / DRY / type safety / error handling / resource cleanup)
- **Checked, no issues.** Functions are small and single-purpose; `registerMemberPeer` reuses
  `signStrandPayload` and a focused `memberPeerExists` helper; no `any` (the `AuthorityKeyPair`
  typing for `memberKeyPair` is reused purely for the `{ privateKeyB64, publicKeyB64 }` shape and
  is documented as implying no authority privilege); exceptions propagate from `db.exec`/`db.eval`
  (none swallowed); the spec tears down every libp2p node + closes the db in `afterEach`.
- **Signing correctness verified against the schema** for all three writers: MemberPeer payload
  `MemberKey|PeerId` matches `coalesce(new.MemberKey,old.MemberKey) || '|' || coalesce(new.PeerId,
  old.PeerId)`; `addAuthority` signs the bare new key matching `digest(coalesce(new.MemberKey,
  old.MemberKey))`; `removeAuthority` signs the target key (= `old.MemberKey` on delete) for both
  accepting branches.
- **Documentation re-read against the new reality.** `architecture.md`'s new subsection,
  `strand-member-registry.ts`'s refreshed comments, and the `reference-app-rn.md` schema-table
  list all reflect the shipped code. The "`Authority` has no `MemberExists`" claim in the docs is
  correct per `schemas/strand.qsql`. No stale forward-reference remains (grep for "ticket 3" /
  "next ticket" returns only the one legitimately-updated log string).

### Test coverage
- **Checked; the floor is solid and accepted as a starting point.** Happy paths, wrong-signer /
  non-member / wrong-key / open-strand rejection paths, multi-device, re-register no-op, and the
  non-bootstrap signature branch are all covered, each asserting row counts (not just throw/resolve).
  The `addAuthority` accept and reject tests are mutually consistent — the reject test passing
  confirms the new row IS counted at commit, which in turn proves the accept test exercises the
  real signature branch rather than the `count<=1` bootstrap shortcut.

### Major finding (already filed by implementer — confirmed, correct disposition)
- **Delete-side deferred CHECK constraints are not enforced in bootstrap mode.**
  `Authority.Authorized` is deferred, so the platform currently accepts ANY `Authority` delete
  regardless of signature — `removeAuthority` is effectively unauthenticated at runtime today.
  This is a genuine cross-repo platform gap (optimystic/Quereus), already filed as
  **`tickets/backlog/optimystic-deferred-check-not-enforced-on-delete.md`** with a repro and a
  `KNOWN GAP` sentinel test that pins the insecure behavior and will fail loudly once enforcement
  lands. No change needed in this ticket's code — the writer already emits a correctly-signed
  delete, forward-compatible with the fix. **Verified the ticket exists and accurately describes
  the gap + the flip-to-`rejects.toThrow()` follow-up.**

### New ticket filed during review
- **`tickets/backlog/strand-min-one-authority-invariant.md`** (the implementer left this
  disposition to the reviewer). `Authority.Authorized`'s `count(Authority) <= 1` bootstrap branch
  is true at commit whenever a delete drops the count to ≤ 1, so — once delete enforcement lands —
  a second-to-last removal would be unauthenticated and a last-authority removal would orphan the
  strand. This is a schema concern (not a writer one) and is gated behind the delete-enforcement
  gap above, so it is filed `prereq: optimystic-deferred-check-not-enforced-on-delete`.

### Accepted limitations / things probed, no action this pass
- **`removeAuthority` delete-path signing is effectively untested until enforcement lands.**
  Because deletes are unenforced, the admin-removal and self-resignation acceptance tests only
  prove the correct row is removed and the others survive — not that the signature is verified.
  They are written forward-compatibly (valid founder/self signatures) so they will exercise the
  signature branches unchanged once the platform gate lands. Re-deriving the signature in a unit
  test would require the writer to return it (it does not) and would only duplicate
  `signStrandPayload`'s own coverage. **Accepted.**
- **`addAuthority` has no insert-if-absent guard (asymmetric with `registerMemberPeer`).**
  Justified: peer registration is part of idempotent founder bring-up (must be restart-safe),
  whereas an authority add is an explicit one-shot admin action. Re-adding an existing authority
  relies on eventual PK-uniqueness enforcement, exactly as the invite path does (see
  `optimystic-insert-pk-uniqueness-not-enforced`). **Not a bug.**
- **`removeMemberPeer` is out of scope.** `MemberPeer.MemberExists` reads `new.MemberKey` (null on
  delete), so peer deletion needs a schema tweak (`coalesce(new.MemberKey, old.MemberKey)`) first.
  Documented in the writer + the cross-repo backlog ticket's follow-up note. **Correct boundary.**
- **Enrollment `peerIds` wiring still deferred.** `StrandMemberRegistry.registerMember` logs-and-
  ignores supplied `peerIds` rather than calling `registerMemberPeer`, because the member self-
  proof it holds does not carry the per-peer signatures `MemberPeer.Authorized` requires. The
  downstream e2e ticket drives `registerMemberPeer` directly. **Correct boundary.**

## Downstream

`4-strand-membership-closed-strand-e2e` (implement) consumes `registerMemberPeer` + `addAuthority`
over two real nodes; the delete-enforcement gap and the min-one-authority invariant are relevant
to its rejection-floor assertions.
