description: An app table that happens to share a name with one of a strand's built-in membership tables (the chat app's "Member" table is one) is silently stored in the same place as that built-in table, so the two mix rows: the chat member list shows blank phantom members and a member's own entry can vanish. Refuse such schemas up front and rename the chat app's table.
prereq:
files:
  - packages/quereus-plugin-sereus/src/compose-strand.ts (step 4 sets the default table module; step 6 applies `Strand`, then the sApp schema is applied as `App` — the check belongs before either apply)
  - packages/quereus-plugin-sereus/src/strand-schema.ts (`STRAND_SCHEMA` — the reserved names: Header, Invite, ConsumedInvite, CancelledInvite, Member, MemberPeer, Manager, Revocation)
  - ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (~3869 `parseTableSchema`: default storage location is `tree://default/${tableSchema.name}` — the schema name is dropped; ~3706 the schema catalog is plugin-global, not per engine schema)
  - schemas/chat-simple.qsql, schemas/chat.qsql (chat.qsql also declares `Invite`)
  - packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-rn/src/use-chat.ts
  - packages/reference-app-web/src/lib/chat-strand.ts (+ its chat operations)
  - packages/reference-app-ns/src/chat-strand.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-ns/src/solo-smoke.ts
  - packages/integration-tests/src/scenarios/websocket-chat.integration.ts, multi-party-workflows.integration.ts, convergence-stress.integration.ts (sApp schemas declaring `table Member`)
  - packages/quereus-plugin-sereus/test/plugin.spec.ts
  - docs/reference-app-rn.md (~165 embeds the schema), docs/strands.md, docs/schema-guide.md
difficulty: medium
repro: verified
----

# App tables named like a built-in strand table share its storage

Split out of `fix/cross-party-strand-messages-do-not-converge` (device run, 2026-09-16). This is one of the two defects behind that report; the other is `joining-machine-writes-before-first-sync-fork-tables`.

## Mechanism

Every strand database holds two engine schemas: `Strand` (built-in membership tables) and `App` (the sApp's tables). Both are declared without a per-table `using optimystic('<uri>')`, so each table's storage location comes from the optimystic plugin's default: `tree://default/<TableName>` (`optimystic-module.ts` `parseTableSchema`). **The schema name is not part of it.** `App.Member` and `Strand.Member` therefore open the same optimystic collection, `default/Member`. Their indexes collide the same way (`<uri>/index/<name>`).

Nothing refuses this. The plugin's storage-adoption guard (`guardStorageAdoption`) only fires when the collection already holds rows, and at strand bring-up both tables are empty until the founder bootstrap writes the first `Strand.Member` row.

## Observed (headless, two `CadreNode`s, closed strand formed with `formStrand`, chat-simple schema)

- On the founder alone, right after `insert into App.Member ... ('host', ...)`: `select Id from App.Member` returns `host` **and a row whose Id is null** — the founder's `Strand.Member` row decoded through the app's columns.
- After the joiner's membership redemption: two null rows, on both machines.
- The joiner's own `insert or ignore into App.Member ('joiner', ...)` reported success and the row was never readable, locally or on the founder; the joiner's next `insert into App.Message` then failed `CHECK constraint failed: _fk_Message_MemberId`.
- With the app table renamed to `ChatMember` and nothing else changed, the same run converged fully in both directions within 5 s.

Likely (not verified on the device): the phone's status bar `2 member(s)` that was read as "membership crossed" counted these rows — the founder's own app row plus the phantom `Strand.Member` row — so it was not evidence that data moved.

Also likely, static only: because the optimystic schema catalog is plugin-global and looked up by table name (`getDroppedSchemaRecord(this.tableName)`), a warm restart's catalog hydrate may conflate the two table definitions. Would be confirmed by a restart of a node holding both tables with rows.

## What to build

**Boundary invariant (sereus):** `composeStrand` refuses an sApp schema that declares a table whose name matches, case-insensitively, any table in `STRAND_SCHEMA`, with an error naming the table and the reserved list. Get the declared table names from Quereus's own parser (`Parser` is exported from `@quereus/quereus`) — no hand-rolled schema scanning. Derive the reserved list from the parsed `STRAND_SCHEMA` as well, so a table added to the strand schema later is reserved automatically. Fail before any schema is applied, so a refused strand writes nothing to storage. Consider whether the same refusal belongs at the sApp signing/validation gate so an author finds out at publish time rather than at a joiner's bring-up; at minimum `composeStrand` must refuse, because it is the one path every strand takes.

**Rename the chat app's `Member` table** (e.g. `Participant`) in `schemas/chat-simple.qsql`, `schemas/chat.qsql` (it also has `Invite`), all three reference apps, their chat operations and the doc copies. `backlog/debt-chat-simple-schema-copies-drift-unguarded` covers these copies drifting; this ticket does not add that guard, but must change every copy consistently. Rename the colliding tables in the integration-test and plugin-spec schemas too, otherwise the new refusal breaks them.

**Report upstream (optimystic):** the default collection location should include the engine schema name (e.g. `tree://default/<schema>/<table>`), and the catalog should key records by schema as well. That removes the class entirely; the sereus refusal is still worth keeping as a legible error while that is outstanding. Record the report in the review handoff; do not wait on it.

## Tests

- Unit (plugin): `composeStrand` with an sApp declaring `table Member`/`table header` rejects with the named-table error and applies nothing; a non-colliding schema composes as before.
- Integration: a closed strand formed via `formStrand` with the renamed chat schema — founder writes a participant + message before the invitation, the joiner (after it has synced; see the sibling ticket for the before-sync case) writes its participant + message, and both machines read exactly `{host, joiner}` participants and all messages, with no null ids. `strand-formation-cross-party-seed.integration.ts` test 2 is the base to copy; assert the specific ids, not counts.

## TODO

- Add the reserved-name refusal in `composeStrand`, using the Quereus parser for both lists.
- Plugin unit tests for refusal (including case-insensitive match) and the passing case.
- Rename `Member` (and chat.qsql's `Invite`) in the chat schemas, the three reference apps, their operations/view-models, docs, and integration/plugin test schemas.
- Integration scenario asserting two-party participant + message convergence with exact ids.
- Document the reserved table names in `docs/strands.md` and `docs/schema-guide.md`.
- Note the upstream schema-qualified-URI report in the handoff.
- `yarn lint`, `yarn typecheck`, plugin + cadre-core tests, the new integration scenario and the chat scenarios touched.
