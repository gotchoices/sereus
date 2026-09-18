description: One integration test fails on every run because it still expects the storage ids that control-database tables had before optimystic started putting the schema name into a table's default storage location; update that expectation and the comments in two other tests that still describe the old location.
files: packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts (header comment line 9, assertions lines 116 and 131), packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (header lines 7-16, subject 4c comment lines 412-418), packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts (line 48)
difficulty: easy
repro: verified
----
# Control collection ids are schema-qualified — update the stale test expectation

## What fails

`cd packages/integration-tests && yarn vitest run src/scenarios/control-offline-read-after-restart.integration.ts` fails on every run (3 of 3 on 2026-09-17, and re-run once on 2026-09-18 during the fix stage, against optimystic 9ec2de46):

```
AssertionError: expected [ …(17) ] to deeply equal ArrayContaining{…}
- ArrayContaining [ "default/CadrePeer", "default/OwnerKey" ]
+   "default/cadrecontrol/OwnerKey",
+   "default/cadrecontrol/OwnerKey/index/_uniq_7.stampid",
+   "default/cadrecontrol/CadrePeer",
+   "default/cadrecontrol/CadrePeer/index/_uniq_7.stampid", …
 ❯ src/scenarios/control-offline-read-after-restart.integration.ts:116:31
```

The received block list contains both collection headers under their new ids. The property the test guards (the joiner's own raw store holds the headers) holds. Only the literal is stale. Line 131 has the same literal and fails next once 116 is fixed.

## Cause

Optimystic `1208af4b` / `6302f2e8` (2026-09-16) changed the storage location of a table declared without an explicit `using optimystic('<uri>')`. It used to be `tree://default/<Table>`. It is now `tree://default/<schema>/<Table>`, with the schema name lowercased by Quereus (see `../optimystic/packages/quereus-plugin-optimystic/src/schema/table-identity.ts`, `defaultCollectionUri`). The control schema is `declare schema CadreControl` (`schemas/control.qsql:2`), so the header block ids are `default/cadrecontrol/CadrePeer` and `default/cadrecontrol/OwnerKey`. Strand tables are `default/strand/<Table>` and sApp tables `default/app/<Table>`.

No sereus product code builds a `default/...` id, so only tests and comments are affected. Data stored before that optimystic change is not readable after upgrading (legacy catalog keys are skipped, and rows sit at the old location). Per AGENTS.md there is no backwards compatibility, so no migration is owed. A device holding pre-2026-09-16 data has to be reset and re-enrolled.

## Changes

- `control-offline-read-after-restart.integration.ts`: lines 116 and 131 expect `'default/cadrecontrol/CadrePeer'` and `'default/cadrecontrol/OwnerKey'`. Header comment line 9 names the same ids.
- `strand-chat-participants-converge.integration.ts`: the header (lines 7-16) says optimystic stores a defaulted table at `tree://default/<TableName>` with no schema name. Rewrite it as history: the collision happened when the location left the schema out, and optimystic now includes it (`tree://default/<schema>/<Table>`). The subject 4c comment (lines 412-418) should name `default/strand/…` and `default/app/…` (e.g. `default/app/Participant`, `default/app/Message`, `default/strand/Member`). The assertion at line 423 (`id.startsWith('default/')` → none) still holds under the new ids, so leave it unchanged. Do not change the header's statement that `composeStrand` refuses the colliding name. The sibling ticket `retire-reserved-strand-table-names-refusal` owns that sentence.
- `relay-only-control-addr.integration.ts:48` quotes an old error message (`Block default/OwnerKey is unavailable …`) as a measured observation. It is historical. Keep the quote and add a short parenthetical saying that id is now `default/cadrecontrol/OwnerKey`.

Overlap: `tickets/fix/strand-reconciler-join-transaction-captures-and-loses-concurrent-app-writes.md` also lists `strand-chat-participants-converge.integration.ts`, but for its test logic, not these comments. Edit only the comment lines named here.

## TODO

- Update lines 9, 116 and 131 of `control-offline-read-after-restart.integration.ts`.
- Update the header and subject 4c comments of `strand-chat-participants-converge.integration.ts`.
- Annotate the historical quote at `relay-only-control-addr.integration.ts:48`.
- Run `yarn vitest run src/scenarios/control-offline-read-after-restart.integration.ts` from `packages/integration-tests` 3 times, in the foreground (the file's header says one green run proves little). Record the pass count in the review handoff.
- Remove the `control-offline-read-after-restart` entry from `tickets/.pre-existing-known.md` (around lines 11 and 24) once it passes, or mark it resolved in that file's style.
- `yarn lint` on the touched files.
