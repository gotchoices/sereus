----
description: Rename the strand membership role we call "authority" (a strand member allowed to invite and admit others) to "manager", so it stops clashing with the "authority" term sApps like VoteTorrent use in their own data. Pairs with the separate cadre-owner rename.
prereq: rename-cadre-authority-to-owner
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/src/strand-member-key.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-founder-bootstrap.spec.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/architecture.md, docs/reference-app-rn.md
difficulty: medium
----

# Rename strand-membership "authority" → "manager"

## Why

Inside every strand, membership uses an RBAC role called **Authority**: a member that can issue invites, admit members, and promote/demote other authorities. That name collides with the "authority" concept sApps carry in their own data — the VoteTorrent sApp calls an election administrator an "authority" — so a user reading strand data meets "authority" as two unrelated things. No production sApps exist yet, so renaming ours now is free. The role is administrative and plural (a strand has several, rotatable) — "owner" (used for the cadre's owning party) does **not** fit; the right word for a strand admin is **manager**.

## Scope — the strand membership role only

**In scope (→ `manager`)**: `schemas/strand.qsql` `declare schema Strand` — the `Authority` table (PK `MemberKey`), and the `context.AuthorityKey`/`context.AuthoritySignature` params used by the Strand schema (`Invite`, `Member`, `Authority`). The runtime byte-equal copy `STRAND_SCHEMA` in `packages/quereus-plugin-sereus/src/strand-schema.ts`. The strand-membership runtime RBAC API in cadre-core and its tests. Strand-RBAC doc sections.

**Out of scope**:
- **Cadre owner** (`CadreControl.AuthorityKey`, `--authority`, "authority node", `VouchAuthority`, `isAuthority`): the sibling ticket `rename-cadre-authority-to-owner` (this ticket's `prereq`). By the time this runs, that concept is already `owner`.
- **Shared crypto keypair type**: the owner ticket renames `authority-key.ts`→`ed25519-key.ts` with `Ed25519KeyPair`/`ed25519KeyPairFromLibp2p`. Strand code here just **consumes** `Ed25519KeyPair` — do not reintroduce an "authority"/"owner" name for it. If the import currently reads `AuthorityKeyPair`, the owner ticket already fixed it to `Ed25519KeyPair`.
- The Strand schema's generic `Signature` context param on the `Authority`/`MemberPeer` tables — it is `Signature`, not `AuthoritySignature`. **Leave it.**
- `docs/cadre-consistency.md` "Authority layer/Model" (quorum concept) and `docs/web/*.html` "central authority" (generic English) — untouched.

## Naming decisions (resolved)

| Old | New |
|---|---|
| `Authority` (Strand table) | `Manager` |
| `context.AuthorityKey` (Strand tables) | `context.ManagerKey` |
| `context.AuthoritySignature` (Strand tables) | `context.ManagerSignature` |
| `insertFounderAuthorityIfAbsent` | `insertFounderManagerIfAbsent` |
| `addMemberByAuthority` / `AddMemberByAuthorityParams` | `addMemberByManager` / `AddMemberByManagerParams` |
| `addAuthority` / `AddAuthorityParams` | `addManager` / `AddManagerParams` |
| `removeAuthority` / `RemoveAuthorityParams` | `removeManager` / `RemoveManagerParams` |
| param `authorityKeyPair` | `managerKeyPair` |
| param `byAuthorityKeyPair` | `byManagerKeyPair` |
| param `newAuthorityKey` / `targetAuthorityKey` | `newManagerKey` / `targetManagerKey` |
| local `authoritySignature` (issue-invite) | `managerSignature` |
| admission mode string `'authority'` | `'manager'` |
| `strandTableCount(…, 'Authority')` union member | `'Manager'` |

`MemberKey` (the `Manager` table PK and the member/manager key column names) **stays** — a manager is identified by their member key; only the role name changes.

## Change points

Mapped by agent; file:line is an index — whole-word rename + build/typecheck finds the rest.

### (a) Schema DDL — two byte-identical copies, edit both in lockstep
- `schemas/strand.qsql` (canonical) and `packages/quereus-plugin-sereus/src/strand-schema.ts` (`STRAND_SCHEMA` embedded). They MUST stay byte-equal — `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts` enforces it (it anchors on schema name `Strand`, so the rename doesn't break the guard as long as both copies match).
- Rename `table Authority`→`table Manager`; every `from Authority A` and `count(1) from Authority`; every `A.MemberKey = context.AuthorityKey`→`context.ManagerKey` and `context.AuthoritySignature`→`context.ManagerSignature` in `Invite.InviteValid`, `Member.Authorized`, `Authority.Authorized`; the `with context (AuthorityKey …, AuthoritySignature …)` clauses on `Invite`/`Member`/`Authority` (keep the bare `Signature` param on `Authority`/`MemberPeer`). Rewrite the role-describing comments ("An authority is a member that can issue invites, authorize members, and rotate authorities", "first authority needs no authorization", …) to "manager". Keep SQL reserved words lowercase.

### (b) cadre-core runtime (`packages/cadre-core/src`)
- `strand-membership-writer.ts` (primary surface): SQL `insert into Strand.Authority`/`delete from Strand.Authority`→`Strand.Manager`; `with context AuthorityKey = …, AuthoritySignature = …`→`ManagerKey`/`ManagerSignature` (keep `Signature = …` where it's the bare param); exported API `insertFounderAuthorityIfAbsent`/`addMemberByAuthority`/`addAuthority`/`removeAuthority` + their param types/fields per the table; `strandTableCount` union `'Authority'`→`'Manager'`; debug `log()` strings ("Inserted founding Authority", "Added authority %s by %s", "Removed authority…").
- `strand-member-registry.ts`: admission mode `'authority'`→`'manager'` + `authorityKeyPair` field; `addMemberByAuthority` call-site; "authority-side flow" comment.
- **Mixed files — concept-#2 lines only** (rest is owner/control, already handled): `strand-member-key.ts` (the `Authority.MemberKey` wording in comments), `strand-instance-manager.ts` (comments "founding Member/Authority"), `strand-database.ts` (comments "founding authority", "Authority.MemberKey").

### (c) Tests
- `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`: table list `'Authority'`, `Strand.Authority` queries, `with context AuthorityKey=…, AuthoritySignature=…` → `Manager`/`ManagerKey`/`ManagerSignature` (keep bare `Signature`); comments.
- `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`: doc comment mentioning "Authority" for accuracy (no logic change).
- `cadre-core/test`: `strand-membership-writer.spec.ts`, `strand-founder-bootstrap.spec.ts`, `strand-membership-invite.spec.ts`, `strand-membership-peer-rotation.spec.ts` — `'Authority'` table union, `Strand.Authority` selects/counts, `addMemberByAuthority`/`addAuthority`/`removeAuthority` calls, `authorityKeyPair`/`byAuthorityKeyPair`/`newAuthorityKey`/`targetAuthorityKey` args, `AuthorityKey`/`AuthoritySignature` context, mode `'authority'`, and comments.
- `integration-tests`: `strand-membership-closed-strand-e2e.integration.ts` — `addAuthority`, `'Authority'` union, `Strand.Authority` counts, `issueInvite({ authorityKeyPair })`, `addAuthority({ byAuthorityKeyPair, newAuthorityKey })`, comments. (NOTE: `strand-formation-e2e.integration.ts` and `strand-formation-consent.spec.ts` use `authorityPrivateKey`/`ensureAuthorityKey`/`insertFormationInvite` — that's the **cadre-owner/control** authority, owner ticket's territory. Do NOT touch here.)

### (d) Docs
- `docs/architecture.md` strand-RBAC sub-sections (~509–553) — real prose rewrites, not blind swaps: the `Strand.*` table list including `Authority`→`Manager`; the `issueInvite`/`addMemberByAuthority`/`addAuthority`/`removeAuthority` API prose (524, 526, 546, 547); the admission-mode example `{ mode: 'authority', authorityKeyPair }`→`{ mode: 'manager', managerKeyPair }`; the "MemberPeer registration + authority rotation" heading (541); and especially the **"Authority-removal hazards"** paragraph (549) and "min-one-authority invariant" → manager. Line 59 "founding `Authority`/`Member`" and 516 "`Authority.MemberKey`".
- `docs/reference-app-rn.md`: line 587 strand-schema table cell `Authority`→`Manager`.
- Reference apps: **no strand-RBAC UI exists today** — agents found zero "authority"-role UI in `reference-app-rn`/`ns`. Nothing to rename there; if such a screen is added later it should use "manager" from the start.

## Edge cases & interactions

- **Byte-equal schema copies.** `strand.qsql` and `strand-schema.ts` (`STRAND_SCHEMA`) must stay identical — edit both, run `strand-schema-drift.spec.ts`.
- **Keep `Signature`, rename `AuthoritySignature`.** The Strand schema has BOTH a bare `Signature` context param (on `Authority`/`MemberPeer`) and an `AuthoritySignature` param (on `Invite`/`Member`/`Authority`). Only the `Authority`-prefixed one becomes `ManagerSignature`; do not rename the bare `Signature`.
- **Mixed spec files half-renamed by the owner ticket.** `control-authorization-binding.spec.ts`/`control-schema-drift.spec.ts` had their owner lines renamed already; they contain no Strand `Authority` role lines relevant here — but if any strand-membership assertion sits in a file the owner ticket partly edited, finish only the `Manager` lines and confirm the file compiles.
- **Consume `Ed25519KeyPair`, don't rename it.** The shared keypair type is already neutral (owner ticket). Strand code imports it as-is.
- **Don't cross into control/formation authority.** `insertStrand`, `FormationUsage`, `insertFormationInvite`, `authorityPrivateKey` etc. are the owning-party authority (now `owner`) — out of scope. Scope the find/replace to `Strand.Authority` / strand-membership sites.
- **First-record bootstrap gates.** `Authority.Authorized`'s `(select count(1) from Authority) <= 1` and `Member`'s first-member gate become `from Manager`/unchanged-Member — verify the founder-bootstrap path (`strand-founder-bootstrap.spec.ts`) still admits the first manager with no prior authorization after the rename.

## TODO

### Phase 1 — Schema (byte-equal pair)
- Rename `Authority`→`Manager`, `context.AuthorityKey`→`ManagerKey`, `context.AuthoritySignature`→`ManagerSignature`, role comments, in `strand.qsql` AND `strand-schema.ts`. Run `strand-schema-drift.spec.ts`.

### Phase 2 — Runtime
- `strand-membership-writer.ts` API + SQL + log strings; `strand-member-registry.ts` mode/field; mixed-file comment fixes in `strand-member-key.ts`/`strand-instance-manager.ts`/`strand-database.ts`.

### Phase 3 — Tests
- Update the quereus-plugin e2e/drift specs, the four cadre-core strand specs, and the closed-strand integration scenario per (c). Keep control/formation-authority specs untouched.

### Phase 4 — Docs
- Rewrite the architecture.md strand-RBAC sections + `docs/reference-app-rn.md` table cell to "manager". Leave cadre-consistency.md and web html.

### Phase 5 — Validate
- `yarn lint`, `yarn build`/typecheck for `cadre-core`, `quereus-plugin-sereus`, `integration-tests`; run the strand-membership + strand-schema suites. Grep for residual strand-sense `Authority`/`AuthorityKey`/`AuthoritySignature` and confirm each remaining hit is cadre-owner (now `owner`, done), the consistency doc, or generic/sApp. Hand off noting founder-bootstrap and rotation paths as the highest-value things for review to re-exercise.
