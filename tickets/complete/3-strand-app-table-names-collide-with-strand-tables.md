description: An app table named like one of a strand's built-in membership tables (the chat app's "Member" was one) used to share that table's storage and corrupt both. Strand bring-up now refuses such schemas with a clear error, and the chat app's table is renamed to "Participant" everywhere.
files:
  - packages/quereus-plugin-sereus/src/reserved-table-names.ts (new: `assertNoReservedTableNames`, `strandReservedTableNames`, `ReservedTableNameError`)
  - packages/quereus-plugin-sereus/src/compose-strand.ts (check runs first, beside the cluster-size validation)
  - packages/quereus-plugin-sereus/src/index.ts (exports), packages/quereus-plugin-sereus/README.md
  - packages/quereus-plugin-sereus/test/plugin.spec.ts ("reserved strand table names" block)
  - packages/cadre-core/src/cadre-node.ts (`foundStrand` runs the check before publishing), packages/cadre-core/test/publish-strand.spec.ts
  - packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (new), packages/integration-tests/src/fixtures/index.ts (`loadChatSimpleSchema`)
  - schemas/chat-simple.qsql, schemas/chat.qsql, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts
  - packages/reference-app-rn/** (src, app, test, test-fixture, maestro, README), packages/reference-app-web/** (src, e2e, README), packages/reference-app-ns/** (src, README)
  - packages/integration-tests/src/scenarios/websocket-chat.integration.ts, multi-party-workflows.integration.ts, convergence-stress.integration.ts
  - docs/strands.md ("Reserved Table Names"), docs/schema-guide.md, docs/reference-app-rn.md, docs/reference-app-ns.md
----

# Refuse sApp tables named like strand tables; rename the chat app's `Member`

## What was wrong

A strand database holds two engine schemas, `Strand` (membership) and `App` (the sApp). A table declared without an explicit `using optimystic('<uri>')` is stored at `tree://default/<TableName>` — no schema name — so `App.Member` and `Strand.Member` were one optimystic collection. The chat app showed null-id phantom participants and lost the joiner's own participant row.

## What was built

**Boundary check (plugin).** `reserved-table-names.ts`:

- `strandReservedTableNames()` — the table names `STRAND_SCHEMA` declares, read with Quereus's `Parser` (parsed once, lazily). Currently Header, Invite, ConsumedInvite, CancelledInvite, Member, MemberPeer, Manager, Revocation.
- `assertNoReservedTableNames(schema)` — parses the sApp body wrapped in `declare schema App { ... }` (the same wrapper `composeStrand` applies), collects `declaredTable` items, compares case-insensitively, throws `ReservedTableNameError` (`.tables` as spelled, `.reserved`, message names both). Empty/absent schema passes. A body that doesn't parse throws the parser's error (the apply would have failed on it anyway, just later). `create table X` inside a declare block is also caught: the parser skips `create` as an ignored item and then parses `table X` as a declared table.
- `composeStrand` calls it first — before storage wrapping, plugin registration, node creation or any DDL — so a refused strand writes nothing.

**Extra, beyond the ticket's minimum:** `CadreNode.foundStrand` runs the same check before `publishStrand`. Without it, a refused schema would publish a cadre-wide `Strand` row and only fail afterwards at the local `addStrand`, leaving a row that no machine can launch. `signSchema` deliberately does NOT check: it is a crypto primitive, and cadre-core tests sign non-SQL placeholder strings.

**Rename.** Chat-simple copies: `table Participant (Id, Name[, Role])`, `Message.ParticipantId references Participant(Id)`. `schemas/chat.qsql`: `Invite`→`Invitation`, `UsedInvite`→`UsedInvitation`, `Member`→`Participant`, `MemberKey`→`ParticipantKey` (+ index), `MemberId`→`ParticipantId`, `MemberValid`→`ParticipantValid`, and the context variables `MemberKey/MemberSignature/InviteKey/InviteSignature`→`Participant*/Invitation*`. Digest field order was not changed. The chat app's own TypeScript surface was renamed too (`ChatParticipant`, `insertParticipant`, `queryParticipants`, `ParticipantId/ParticipantName` on messages, `participantDisplayName`, `participantCount`). The status banner now reads `N participant(s)`, because the old `N member(s)` count was what got misread as strand membership on the device. Strand-membership names (`MemberPrivateKey`, `generateStrandMemberKey`, member keys, role values `'owner'/'member'`) were left alone on purpose.

**RN test sidecar HTTP API changed** to match: `GET /participants/:strandId` (was `/members/`), body field `participantId` (was `memberId`), Maestro env `PARTICIPANT_ID` (was `MEMBER_ID`). A repo grep finds no other callers.

## Use cases to validate

- `connectToStrand` with an sApp schema declaring `table Member`, `table header`, or `create table Manager` → rejects with `ReservedTableNameError` naming the table(s). No node is created, no cache claim is taken, and `Strand.Header` does not exist afterwards.
- Names that merely contain a reserved name (`ChatMember`, `InviteNote`, `Participant`) compose normally.
- `foundStrand` with a colliding schema → rejects before any control-DB write (`queryStrands()` stays empty).
- Two parties on a closed strand with the canonical `schemas/chat-simple.qsql`. The host writes `host` + `msg-host-1` before inviting. The joiner syncs, then writes `joiner` + `msg-joiner-1`. Both machines read exactly `[host, joiner]` and both messages with their sender ids, and `Strand.Member` keys exactly {founder, joiner}.
- **The scenario was shown to detect the bug:** with the refusal commented out in the built `dist` files and the table named `Member` in a throwaway copy, it failed at the founder-only check with `expected [ null, 'host' ] to deeply equal [ 'host' ]`. Both packages were rebuilt afterwards and the copy deleted.

## Validation run

- `yarn lint` — clean. `yarn typecheck` (root, all workspaces + coverage guards) — clean.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 10 files, 119 passed + 1 todo (unit + e2e, including `chat-schema.e2e.spec.ts`).
- `yarn workspace @serfab/cadre-core test` — 132 files, 2144 passed, 1 skipped.
- reference-app-rn `test` — 19 files / 303 passed. reference-app-web `test` — 3 / 66, plus `check:svelte` and `typecheck:e2e` clean. reference-app-ns `test` — 6 / 110.
- Integration: `strand-chat-participants-converge`, `websocket-chat`, `multi-party-workflows`, `convergence-stress` — all pass.

## Known gaps / for the reviewer

- **Not run:** web Playwright e2e (`packages/reference-app-web/e2e/**`, whose fixtures were renamed), RN Maestro flows (need an emulator), NS `test:bundle` and device e2e, and the full integration suite (only the four scenarios above).
- **Devices with an existing chat strand (static, unverified):** such a strand was created under the old `Member` schema, and its optimystic catalog persisted an app `Member` table in the storage it shares with `Strand.Member`. After upgrading, the app passes the new schema; the declarative apply may then emit a drop of the old app `Member` table, which would target that shared collection. Treat old chat strands as corrupt and recreate them (clear app data) rather than warm-restarting them. No migration was written (repo policy: no backwards compat yet).
- **Explicit locations are not checked:** only names are. An app table with `using optimystic('tree://default/Member')`, or two app tables given the same explicit URI, would still collide. Not refused here; the upstream fix below would not cover that either.
- **Upstream report (optimystic) — recorded here, not filed in `../optimystic`:** `parseTableSchema` (`quereus-plugin-optimystic/src/optimystic-module.ts` ~3869) defaults to `tree://default/${tableSchema.name}` and drops the engine schema name; the schema catalog (~3706, `getDroppedSchemaRecord(this.tableName)`) is plugin-global and keyed by bare table name. Both should be schema-qualified (e.g. `tree://default/<schema>/<table>`). Still unverified (static only): a warm restart of a node holding same-named tables in two schemas may conflate their catalog records on hydrate. The refusal's docblock and `docs/strands.md` carry the NOTE that it stops being load-bearing once optimystic is fixed.
- **Cost not measured:** bring-up now parses the sApp schema once more (the apply parses it again), plus `STRAND_SCHEMA` once per process. Expected to be negligible next to apply/hydrate, but no timing was taken.
- **Browser bundle:** `compose-strand` now imports `Parser` from `@quereus/quereus`, which the bundle treats as external. The bundle already imported other runtime values from it (`QuereusError`, `FunctionFlags`, …), so no new kind of dependency. The comments in `build-browser.mjs` and `connect-browser.ts` claiming the bundle has no runtime `@quereus/quereus` import were already inaccurate before this change and are untouched.
- **Board edits:** the table name was updated in `backlog/debt-chat-simple-schema-copies-drift-unguarded`. The sibling ticket `implement/joining-machine-writes-before-first-sync-fork-tables` now points to the new fixture and scenario as its base.

## Review findings

Read the implement diff (`c8692f7`) first, then the handoff.

**Checked, no change needed:**
- *Correctness of the check.* `STRAND_SCHEMA` is a body (not already wrapped), so wrapping it in `declare schema App { ... }` parses the same items the apply sees. The wrapper puts a newline before `}`, so a trailing `--` comment in the sApp body can't swallow it. The check runs before cluster-size-dependent work, storage wrapping and DDL in `composeStrand`, and before `queryStrand`/publish in `foundStrand`. Every bring-up path (Node, browser, cadre-core `StrandDatabase`, Quoomb plugin loader) goes through `composeStrand`.
- *Leftover collisions.* Grepped `.ts/.qsql/.mjs/.js/.svelte/.tsx/.md` outside `node_modules`/`dist` for `table <reserved name>`. Only hits: the strand schema itself, the control schema's own `Revocation` (a different database, not an sApp), and the new refusal tests. The only other `table Member` hit is a stale NativeScript Android build output under `platforms/` (build artifact, not source). No leftover `MemberId`/`App.Member`/`/members/`/`MEMBER_ID` in the reference apps, integration tests, schemas or docs.
- *Type safety / modularity.* No `any`. The module is small and single-purpose. Importing the `Parser` value from `@quereus/quereus` plus types from the `./parser` subpath matches that package's `exports`.
- *Resource cleanup / error handling.* The refusal happens before anything is acquired, so nothing needs releasing. A parse failure propagates the parser's own error instead of being swallowed.
- *Performance.* One extra parse of the sApp body per bring-up, and `STRAND_SCHEMA` once per process. Not measured. Left as is: it's small next to hydrate/apply, and no measurement exists that argues otherwise.
- *Strand-membership names kept* (`MemberPrivateKey`, role `'member'`, etc.): correct. Those refer to strand membership, not the app table.

**Fixed in this pass (minor):**
- `packages/quereus-plugin-sereus/README.md`: the `StrandConnectionOptions.schema` row didn't mention the new refusal. It now names `ReservedTableNameError` and links to `docs/strands.md#reserved-table-names`.
- Added a unit test (`plugin.spec.ts`): a body that doesn't parse throws the parser's error, not `ReservedTableNameError`. That behaviour was documented but untested. Plugin suite now has 120 passed + 1 todo.

**Tripwires recorded:**
- Only table names are checked, not explicit `using optimystic('<uri>')` locations. An explicit URI that points at a strand table's collection, or two app tables that share one URI, would still collide. No sApp uses explicit locations today. Parked as a `NOTE:` bullet in `docs/strands.md` → "Reserved Table Names".
- Once optimystic puts the schema name into its default location and catalog keys, the refusal is no longer needed to prevent corruption. That `NOTE:` already exists in the `reserved-table-names.ts` docblock and in `docs/strands.md`. No ticket filed: the fix belongs in `../optimystic`, and this repo is protected by the refusal.

**Not filed / accepted as reported by implement:**
- Old on-device chat strands created under the `Member` schema are treated as corrupt, to be recreated. Repo policy is no backwards compatibility yet, so no migration ticket.
- Not re-run here: web Playwright e2e, RN Maestro flows, NS bundle/device e2e, the full integration suite. They need devices or browsers, or take a long wall-clock time. The implement stage ran the four affected integration scenarios.

**Validation (this pass):** `yarn lint` clean. `@serfab/quereus-plugin-sereus` test: 10 files, 120 passed + 1 todo. `@serfab/cadre-core` `publish-strand.spec.ts`: 40 passed.
