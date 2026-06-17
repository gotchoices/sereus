description: Review the new code that lets a strand member register the network nodes acting for it, and lets strand admins promote or remove other admins.
prereq:
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, schemas/strand.qsql, docs/architecture.md, tickets/backlog/optimystic-deferred-check-not-enforced-on-delete.md
difficulty: medium
----

## What landed

Implemented the two remaining founder-reachable `Strand.*` writers in
`strand-membership-writer.ts`, exported from `index.ts`, with a component spec
(`strand-membership-peer-rotation.spec.ts`, 14 tests) running against a REAL closed strand DB
in bootstrap mode (the same `connectToStrand` path `StrandDatabase` uses).

- **`registerMemberPeer(db, { memberKeyPair, peerId })`** — a member self-signs
  `MemberKey || '|' || PeerId` with its OWN key; `MemberPeer.Authorized` verifies against the
  member key itself (no authority involved). **Insert-if-absent** on the composite PK
  `(MemberKey, PeerId)` so a re-register is a no-op (deliberately NOT relying on platform
  PK-uniqueness, which is unenforced — `optimystic-insert-pk-uniqueness-not-enforced`).
  `memberKeyPair` is typed `AuthorityKeyPair` only for the shared `{ privateKeyB64, publicKeyB64 }`
  shape — no authority privilege is implied.
- **`addAuthority(db, { byAuthorityKeyPair, newAuthorityKey })`** — existing authority signs
  `digest(newAuthorityKey)` and inserts an `Authority` row (existing-authority branch).
- **`removeAuthority(db, { byAuthorityKeyPair, targetAuthorityKey })`** — deletes an `Authority`
  row. ONE context construction serves both schema branches: on a delete
  `coalesce(new.MemberKey, old.MemberKey) = old.MemberKey = targetAuthorityKey`, so the signed
  payload is the target key whether the signer is a *different* authority (admin removal,
  existing-authority branch) or the target itself (self-resignation, former-authority self
  branch). The caller selects the case purely by which keypair it passes.

Also: refreshed now-stale "ticket 3 / next ticket" forward-references in `strand-member-registry.ts`
(comment + log only — no logic change) and added an architecture.md subsection.

## ⚠️ Major finding discovered during implementation (NOT a blocker for this ticket)

**Deferred CHECK constraints are not enforced on DELETE** in the optimystic bootstrap-mode
transactor. `Authority.Authorized` is a deferred (subquery-bearing) CHECK, so the platform
accepts **any** `Authority` delete regardless of signature — `removeAuthority`'s authorization
is effectively **unenforced at runtime** today. Proven directly with a throwaway probe: a
`delete ... with context AuthorityKey = null, Signature = null` against a strand with 3
authorities still removed the row (count 3 → 2), even though no branch of `Authority.Authorized`
matches a null/garbage signature when the post-delete count is ≥ 2.

- INSERT-side enforcement DOES work (the `addAuthority` rejection tests here pass, as do the
  `strand-schema.e2e` insert-rejection tests), so the gap is **DELETE-specific**.
- Secondary observation worth a reviewer's eye: a **non-deferred** CHECK on delete
  (`MemberPeer.Authorized`, bare `verify()`, no subquery) behaved as a silent **no-op** in the
  same probe (bogus-signature delete neither threw nor removed the row) — delete-side CHECK
  handling may be inconsistent across deferred vs non-deferred. Both paths should be audited.
- Filed as **`tickets/backlog/optimystic-deferred-check-not-enforced-on-delete.md`** (cross-repo
  fix in `../optimystic` and/or Quereus). The writer still emits a correctly-signed delete so it
  works unchanged once enforcement lands — mirrors how the invite path issues correct inserts
  despite the open PK-uniqueness gap.

The spec pins this with **`KNOWN GAP: a non-authority removal currently SUCCEEDS`**, which
asserts the *actual* (insecure) behavior and will fail loudly the moment the platform starts
enforcing delete-side constraints — at which point flip it to `rejects.toThrow()` + unchanged
count.

## How to validate

- `yarn workspace @serfab/cadre-core test strand-membership-peer-rotation` → 14 passing.
- Full suite `yarn workspace @serfab/cadre-core test` → 525 passing (39 files), no regressions.
- `yarn workspace @serfab/cadre-core typecheck` clean; `eslint` clean on all changed files.

## Test coverage (the floor — reviewer should treat it as a starting point)

Phase 1 (MemberPeer): founder registers a peer → 1 row; wrong-signer rejected (raw insert with
a mismatched signer); non-member rejected (deferred `MemberExists`); multi-peer/multi-device →
one row per `PeerId`; re-register no-op; a **non-founder** member admitted by authority then
registers its own peer (count>1 branch); peer registration rejected on an open strand (no Member
can exist).

Phase 2 (Authority): existing authority adds a second (genuine signature branch — at commit
count ≥ 2 so the bootstrap shortcut is false); non-authority add rejected; wrong-key-signature
add rejected; admin-removal of a different authority; self-resignation; and the KNOWN GAP
non-authority-removal pin.

## Gaps / things a reviewer should probe

- **`removeAuthority` acceptance tests prove less than they look like.** Because the platform
  doesn't gate deletes (above), the admin-removal and self-resignation tests currently only
  prove the writer removes the *correct* row and leaves the others intact — NOT that the
  signature is verified. They're written to be forward-compatible (the founder/self signatures
  are valid for the respective branches), so once delete enforcement lands they exercise the
  signature branches unchanged. Worth confirming that framing is acceptable.
- **Last-authority / second-to-last removal hazard (schema-level, independent of the platform
  gap).** `Authority.Authorized`'s `(select count(1) from Authority) <= 1` bootstrap branch is
  true at commit whenever a delete drops the count to ≤ 1, so removing the last (or
  second-to-last) authority is accepted regardless of signature, and removing the last one
  orphans the strand. Deliberately NOT guarded here (per ticket); a "min-one-authority"
  invariant is left to a future schema change. Reviewer: decide whether that deserves its own
  backlog ticket now or stays a documented hazard.
- **`removeMemberPeer` is out of scope.** The schema's `MemberPeer.MemberExists` reads
  `new.MemberKey` (null on delete), so peer deletion needs a schema tweak (e.g.
  `coalesce(new.MemberKey, old.MemberKey)`); see the writer doc + `schemas/strand.qsql`.
- **Enrollment `peerIds` wiring still deferred.** `StrandMemberRegistry.registerMember` still
  logs-and-ignores supplied `peerIds` rather than calling `registerMemberPeer` — the member
  self-proof it holds does not carry the per-peer signatures `MemberPeer.Authorized` requires,
  so wiring it is a genuine follow-on (the downstream e2e ticket drives `registerMemberPeer`
  directly). Confirm this is the right boundary.
- **`rejects.toThrow()` as the floor.** Per the ticket, insert rejection assertions also check
  unchanged row counts (the deferred-rollback fix makes that hold), but the floor is "throws".

## Downstream

`4-strand-membership-closed-strand-e2e` (implement) consumes `registerMemberPeer` + `addAuthority`
over two real nodes; its rejection-floor and the delete-gap interaction are relevant there too.
