description: Renamed the strand membership admin role from "authority" to "manager" (schema table, RBAC API, tests, docs) so it stops colliding with the "authority" concept sApps like VoteTorrent use in their own data.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, docs/architecture.md, docs/reference-app-rn.md, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
----

# Complete: rename strand-membership "authority" → "manager"

Whole-word rename of the strand-membership RBAC admin role — **no behavior change**. The role that issues invites, admits members, and rotates admins is now **Manager** (was Authority). `MemberKey` (the member/PK columns) unchanged. Implement handoff was accurate; review confirmed the mapping and fixed one class of mechanical-rename fallout.

## Review findings

### Correctness / behavior — CLEAN
- Read the full implement diff (`git show 7fbbb0c`) before the handoff. Schema rename (`schemas/strand.qsql` + embedded `STRAND_SCHEMA` in `strand-schema.ts`) is symmetric and lockstep; the byte-equality **drift guard** (`strand-schema-drift.spec.ts`) passes, proving both copies edited identically.
- Writer (`strand-membership-writer.ts`) rename is complete and symmetric: table names, `context.Manager*` fields, function/param/type names (`addManager`/`removeManager`/`addMemberByManager`/`issueInvite({managerKeyPair})` + their `*Params`), log strings. Signing payloads and constraint logic unchanged.
- Barrel `index.ts` re-exports renamed. No behavioral edit anywhere — pure symbol/prose rename.

### Scope guards — HELD (verified, not assumed)
- `Authorized` constraint name and `isAuthorizedToJoin` method: intact (76 occurrences across 11 src files — the "authoriz-" word, not the role).
- Generic English "authoritative" (architecture.md, integration scenarios' "authoritative DB"): left as-is — confirmed only "authoritative" survives, no bare role "authority".
- Whole-word `Authority` in code/schema: **zero** remaining (repo grep). Remaining `\bAuthority\b` hits are only ticket files + `docs/cadre-consistency.md` (the untouched quorum "Authority layer" concept) — correct.
- `managerRow` collision fix in `strand-founder-bootstrap.spec.ts:74` verified (would have collided with the enclosing `StrandInstanceManager` local `manager`). The `const manager = await db.get(...)` row locals in `publish-strand.spec.ts:175` and `strand-membership-writer.spec.ts:160` have **no** enclosing `manager` — no collision, confirmed.
- No strand-role "authority" UI in `reference-app-*` (grep empty) — nothing to rename there, as the handoff claimed.

### Found + FIXED inline (minor — mechanical-rename grammar fallout)
The bulk `authority`→`manager` left the indefinite article `an` in front of the now-consonant-sound word "manager" — ungrammatical "an manager" / "an Manager" (was correct as "an authority"). 10 sites corrected to "a manager" / "a Manager":
- `docs/architecture.md` (6 phrases across the issueInvite / addMemberByManager / addManager / removeManager bullets).
- `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` (4 `it(...)` names + 1 comment).
- `packages/cadre-core/test/strand-membership-invite.spec.ts` (2 `it(...)` names).
- `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts` (1 comment).

Test-name strings, comments, and prose only — behavior-neutral. Post-fix grep for `\ban [Mm]anager` is empty.

### Terminology drift — noted, NOT actioned (human-queue)
- `tickets/backlog/strand-min-one-authority-invariant.md` slug still carries the old role word "authority". Left as-is: it is the human's backlog to curate, its `description` already uses the generic word "admin" (readable), and no doc/code cross-reference names that slug, so nothing is broken. A human can rename on promotion if desired.

### Tests / coverage
- No new tests: this is a rename; existing coverage is the floor and passes in-engine. No new behavior to cover, no tripwires warranted.
- Ran (all green, exit 0):
  - `yarn lint` → clean.
  - `yarn workspace @serfab/cadre-core run test strand-membership-writer strand-membership-invite strand-membership-peer-rotation strand-founder-bootstrap publish-strand` → **60 passed (5 files)**.
  - `yarn workspace @serfab/quereus-plugin-sereus run test strand-schema-drift strand-schema.e2e` → **21 passed (2 files)**.

### Known / pre-existing (not this rename, not re-reported)
- Real-network integration tests (`strand-membership-closed-strand-e2e.integration.ts`, `networked.e2e.spec.ts`) fail with `membership-not-admitted:low-confidence-downsize` from the linked optimystic p2p layer — a systemic environment issue, **already tracked** as blocked slug `control-db-convergence-optimystic-p2p` in `tickets/.pre-existing-known.md`. Not re-reported per pre-existing-failure rules.
- Carried-through schema/platform gaps (unchanged by the rename, prose renamed to "manager"): (a) optimystic evaluates deferred CHECK only on INSERT not DELETE → `removeManager` unenforced at runtime (`optimystic-deferred-check-not-enforced-on-delete`); (b) no "min-one-manager" invariant (`strand-min-one-authority-invariant`, backlog). Both prior tickets, not introduced here.
