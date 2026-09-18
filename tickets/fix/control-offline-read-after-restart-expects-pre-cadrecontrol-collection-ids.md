description: `control-offline-read-after-restart` fails every run because it asserts the control collection-header block ids `default/CadrePeer` and `default/OwnerKey`. Since optimystic `1208af4b` (2026-09-16, "same-named-tables-in-two-schemas-share-storage") a table declared without an explicit location lives at `tree://default/<schema>/<table>`, so the ids are now `default/cadrecontrol/CadrePeer` and `default/cadrecontrol/OwnerKey`. The test expectation is stale; the product behaves correctly. Several sereus comments and docs still describe the old, schema-less location.
files: packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts (lines 9, 116, 131), packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (header lines 7-14, subject 4c comment ~line 413), packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts (line 48, historical quote only), packages/quereus-plugin-sereus/src/reserved-table-names.ts (doc comment), docs/strands.md (~lines 228-239)
repro: `cd packages/integration-tests && yarn vitest run src/scenarios/control-offline-read-after-restart.integration.ts` — fails 3 of 3 runs on 2026-09-17 against optimystic 9ec2de46, at line 116
----

# control-offline-read-after-restart expects pre-schema-segment collection ids

## What fails

```
AssertionError: expected [ …(17) ] to deeply equal ArrayContaining{…}
- ArrayContaining [ "default/CadrePeer", "default/OwnerKey" ]
+ [ …, "default/cadrecontrol/OwnerKey", "default/cadrecontrol/OwnerKey/index/_uniq_7.stampid",
+   "default/cadrecontrol/CadrePeer", "default/cadrecontrol/CadrePeer/index/_uniq_7.stampid", … ]
 ❯ src/scenarios/control-offline-read-after-restart.integration.ts:116:31
```

Deterministic: 3 of 3 isolated runs and the full gate. The received list does contain both headers under their new ids, so the physical coverage property the test guards is met. Only the literal is wrong. Line 131 has the same literal and would fail next.

## Why the ids changed

Upstream optimystic `1208af4b` (implement) and `6302f2e8` (review), 2026-09-16: `packages/quereus-plugin-optimystic/src/schema/table-identity.ts` `defaultCollectionUri(schema, table)` now returns `tree://default/<schema>/<table>`, with the schema lowercased by Quereus. The control schema is `declare schema CadreControl` (`schemas/control.qsql:2`), so the collections are `default/cadrecontrol/<Table>`, and the strand ones are `default/strand/<Table>`. Upstream's review notes say directly that "sereus's integration assertion on `default/` block ids needs updating".

`git log -S cadrecontrol` in sereus shows only tickets and test commits after 2026-09-16 that already use the new form (e.g. `3f2028ee`, `8c7ebd25`, `05f5760d`). The two August hits (`85715c30`, `370ad30d`) are schema-name mentions, not collection ids. No sereus product code builds a `default/...` id. The only hits under `packages/*/src` outside tests are comments.

## Data written before the change (noted; no backwards compatibility owed)

Stored data from builds before `1208af4b` cannot be read after upgrading. Defaulted tables were stored at `tree://default/<Table>`. Their schema-catalog records were keyed by bare table name, and `hydrateCatalog` now skips those legacy keys (`namesOfCatalogKey` returns undefined). So a re-declared control or strand table opens an empty collection at the new location, and the old rows stay in storage without being read. Upstream's `same-named-tables-across-schemas.spec.ts` "legacy upgrade" case pins that behaviour. This affects any phone or host holding a control database or strand from before 2026-09-16. Per AGENTS.md there is no migration. A device that needs its old data would have to be reset and re-enrolled.

## Also stale (comments/docs, same cause)

- `reserved-table-names.ts` doc comment and `docs/strands.md` ~228-239 say the default location "does not include the schema name" and that `App.Member` and `Strand.Member` share one collection. That is no longer true. The file's own NOTE says: "if that becomes schema-qualified, this refusal stops being load-bearing — keep it only if the legible error is still wanted". Decide whether to keep `ReservedTableNameError` as a legibility guard or retire it, and correct the rationale either way.
- `strand-chat-participants-converge` header and subject 4c comment describe `tree://default/<Table>`. The 4c assertion (`id.startsWith('default/')` → none) still works under the new ids, but the comment should name `default/strand/…` / `default/app/…`.
- `relay-only-control-addr.integration.ts:48` quotes an old error message (`Block default/OwnerKey …`). It is historical, so annotate it or leave it.

## TODO

- Change lines 116 and 131 of `control-offline-read-after-restart.integration.ts` to `'default/cadrecontrol/CadrePeer'`, `'default/cadrecontrol/OwnerKey'`. Update the header comment at line 9.
- Run the file 3 times (the file's own header says a single green run proves little).
- Fix the stale location descriptions listed above, and decide what to do with `ReservedTableNameError`'s rationale.
