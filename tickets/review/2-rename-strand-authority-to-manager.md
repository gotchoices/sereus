description: Renamed the strand membership admin role from "authority" to "manager" (schema table, RBAC API, tests, docs) so it stops colliding with the "authority" concept sApps like VoteTorrent use in their own data.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-founder-bootstrap.spec.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, docs/architecture.md, docs/reference-app-rn.md
----

# Review: rename strand-membership "authority" → "manager"

Whole-word rename of the strand-membership RBAC admin role. Pure symbol/prose rename — **no behavior change**. The role that can issue invites, admit members, and rotate admins is now **Manager** (was Authority). The `prereq` (`rename-cadre-authority-to-owner`) has already landed; the shared keypair type is `Ed25519KeyPair` and the cadre owning-party concept is `owner`.

## What changed (the mapping applied)

| Old | New |
|---|---|
| `Authority` (Strand table) | `Manager` |
| `context.AuthorityKey` | `context.ManagerKey` |
| `context.AuthoritySignature` | `context.ManagerSignature` |
| `insertFounderAuthorityIfAbsent` | `insertFounderManagerIfAbsent` |
| `addMemberByAuthority` / `AddMemberByAuthorityParams` | `addMemberByManager` / `AddMemberByManagerParams` |
| `addAuthority` / `AddAuthorityParams` | `addManager` / `AddManagerParams` |
| `removeAuthority` / `RemoveAuthorityParams` | `removeManager` / `RemoveManagerParams` |
| param `authorityKeyPair` / `byAuthorityKeyPair` | `managerKeyPair` / `byManagerKeyPair` |
| param `newAuthorityKey` / `targetAuthorityKey` | `newManagerKey` / `targetManagerKey` |
| admission mode `'authority'` | `'manager'` |
| `strandTableCount(…, 'Authority')` | `'Manager'` |

`MemberKey` (the `Manager` PK / member key columns) **unchanged** — a manager is identified by their member key.

## Deliberately NOT renamed (scope guards — verify these held)

- **Bare `Signature` context param** on `Manager`/`MemberPeer` tables — still `Signature` (only the `Authority`-prefixed `AuthoritySignature` → `ManagerSignature`).
- **`Authorized`** constraint name and **`isAuthorizedToJoin`** method — unchanged (they are "authoriz-", not the role word).
- **Generic English "authoritative"** (architecture.md ~155/178/212/219/509/553, the integration scenario's "authoritative DB") — left as-is.
- **Cadre owner / control authority** (`insertStrand`, `FormationUsage`, `authorityPrivateKey`, `ensureAuthorityKey`, formation invites) — owner-ticket territory, untouched.
- **`docs/cadre-consistency.md`** ("Authority layer/Model" quorum concept) and **`docs/web/*.html`** ("central authority") — untouched per ticket.
- **`Ed25519KeyPair`** consumed as-is; no "authority"/"owner" keypair name reintroduced.

## Files beyond the original ticket list (found via repo-wide grep — flagged for the reviewer)

The ticket's file list missed a few real references; a whole-repo grep for `Strand.Authority` / `AuthorityKey` / `addAuthority` / `authorityKeyPair` surfaced them, all renamed:
- `packages/cadre-core/src/index.ts` — the barrel re-exports (`addManager`, `removeManager`, `addMemberByManager`, and their `*Params` types).
- `packages/cadre-core/src/types.ts` — one comment ("founding `Member`+`Manager`").
- `packages/cadre-core/src/strand-instance-manager.ts`, `strand-database.ts` — comments.
- `packages/quereus-plugin-sereus/src/compose-strand.ts` — one comment (byte-equal-copy note).
- `packages/cadre-core/test/publish-strand.spec.ts` — `'Manager'` table counts + `Strand.Manager` queries (was NOT in the ticket list but exercises the renamed schema).
- `packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts` — one comment.

## One non-mechanical fix worth a look

`packages/cadre-core/test/strand-founder-bootstrap.spec.ts`: the bulk lowercase `authority`→`manager` would have renamed a local row variable `const authority = …` to `const manager`, which **collided** with the enclosing `StrandInstanceManager` variable also named `manager` (TDZ / const-reassign error). Fixed by naming the row local `managerRow` instead. Grep for `managerRow` there to confirm it reads correctly. (`publish-strand.spec.ts` and `strand-membership-writer.spec.ts` have a similar `const manager = …` row local but **no** enclosing `manager`, so no collision — worth a glance.)

## Validation performed (all green)

- `yarn workspace @serfab/cadre-core run test strand-membership-writer strand-membership-invite strand-membership-peer-rotation strand-founder-bootstrap publish-strand` → **60 passed (5 files)**.
- `yarn workspace @serfab/quereus-plugin-sereus run test strand-schema-drift strand-schema.e2e` → **21 passed (2 files)**. The **drift spec is the byte-equality guard** between `schemas/strand.qsql` and the embedded `STRAND_SCHEMA` — passing confirms both copies were edited in lockstep.
- `yarn lint` → clean (exit 0).
- Build/typecheck clean: `@serfab/cadre-core` (build), `@serfab/quereus-plugin-sereus` (build), `@serfab/integration-tests` (typecheck).

## Highest-value things for review to re-exercise

1. **Founder bootstrap** (`strand-founder-bootstrap.spec.ts`): the first `Manager` is admitted with **no prior authorization** via the `(select count(1) from Manager) <= 1` bootstrap branch — confirm the rename didn't break that first-record gate. Same for the first `Member`.
2. **Manager rotation** (`strand-membership-peer-rotation.spec.ts`): `addManager` past the count-≤1 shortcut genuinely exercises signature verification (existing-manager branch); `removeManager` admin-removal + self-resignation branches.
3. **Invite issue/consume** (`strand-membership-invite.spec.ts`): `issueInvite({ managerKeyPair })` double-signs (`ManagerSignature` + `InviteSignature`); `addMemberByManager` direct-admit branch.
4. **Byte-equal schema**: re-run `strand-schema-drift.spec.ts` if any schema hunk is questioned.

## Known gaps / honest flags (reviewer should treat tests as a floor)

- **Real-network integration tests fail — PRE-EXISTING, not this rename.** `strand-membership-closed-strand-e2e.integration.ts` and `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts` (4 cases) fail with `membership-not-admitted:low-confidence-downsize` from the linked optimystic workspace (`db-p2p/src/repo/cluster-coordinator.ts`). This is optimystic *cluster/consensus* membership, a different layer from the strand `Manager` role — `networked.e2e.spec.ts` never touches the renamed role yet fails identically, proving it's a systemic p2p issue in this environment. Deterministic across two runs. Same root-cause class as the already-**blocked** `control-db-convergence-optimystic-p2p`. Written up in `tickets/.pre-existing-error.md` for the runner's triage pass. **Do not attribute to this ticket; do not skip/disable — nothing was skipped.**
- **Pre-existing schema/platform gaps carried through the rename unchanged** (documented in `strand-membership-writer.ts` and architecture.md §"Manager-removal hazards"): (a) optimystic bootstrap-mode transactor evaluates deferred CHECK constraints only on INSERT, not DELETE, so `removeManager` is effectively unenforced at runtime (`optimystic-deferred-check-not-enforced-on-delete`); (b) no "min-one-manager" invariant — removing the last manager orphans the strand. Both are prior tickets, not introduced here; the doc prose was renamed to "manager" but the hazards are unchanged.
- **No new tests added** — this is a rename; existing coverage is the floor and it all passes in-engine. No strand-RBAC UI exists in the reference apps, so nothing to rename there.
