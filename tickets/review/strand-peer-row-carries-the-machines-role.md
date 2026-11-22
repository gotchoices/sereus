description: A machine's record of its network identity in a shared workspace gains a field saying whether the machine stores that workspace or only uses it through others, so the party's other machines can tell a phone that stores nothing from a server.
architecture: docs/cadre/control-schema.md#schema-versions-and-migrations
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/fixtures/control-schema/v5.qsql, packages/cadre-core/test/control-schema-versions.spec.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, packages/cadre-core/test/strand-party-peers.spec.ts, docs/cadre/control-schema.md
difficulty: hard
----

# The `StrandPeer` row records whether the machine serves the strand

First of three tickets toward `client-locked-out-of-closed-strand-after-party-key-replacement`. This one changes only the control row and the code that writes, reads and verifies it. The next ticket (`client-publishes-its-strand-peer-row-marked-client`) makes clients publish the row and makes the readers act on the new field; the last (`scenario-client-survives-party-key-replacement`) proves the chain on a real network.

## What was built

**Control schema version 5.** `CadreControl.StrandPeer` gains `Role text null` after `StrandPeerId`. Null means the machine serves the strand, which is what every row written before this version meant; `'client'` means it runs the strand without storing any of it. A named table-level check, `KnownStrandPeerRole`, admits only those two values, so the column itself stays a plain nullable add. `CONTROL_SCHEMA_VERSION` is 5, the `sereus.controlSchemaVersion` tag in both schema copies reads 5, and `schemas/control.qsql` is copied byte for byte to `test/fixtures/control-schema/v5.qsql`. The schema comment above the table now explains the column, why null means serving, the two signed forms and why there are two, and that the immutable row fixes the role at the machine's first publish for that strand.

**Two signed forms.** `StrandPeer.Authorized` has two branches: a row with `Role` null must verify over `(StrandId, PeerId, StrandPeerId)`, the form every earlier row was signed over; a row with `Role` set must verify over those three and `Role`. A serving machine's row is therefore byte-identical to one written under version 4. The versions spec records this in `CHANGED_DIGESTS` as `{ version: 5, table: 'StrandPeer', action: 'add' }`.

**TypeScript.** `StrandPeerRole = 'client'` and `StrandPeerRow.role` in `types.ts` (re-exported through `index.ts`). `StrandPeerSignedFields.role` in `control-authorization.ts`, where `strandPeerRowFields` appends the role only when it is not null; that file now has one type-only import, from `types.ts`. `verifyStrandPeerRow` needed no new logic because the builder picks the form from the row's own role. In `control-database.ts`, `readStrandPeerRows` selects and maps `Role` through a new `strandPeerRowOf` helper, and `insertStrandPeer` takes `{ strandId, strandPeerId, role }`, writes the column and signs through the builder. When a held row's role differs from the role being published, `logHeldStrandPeer` logs both roles and that the row cannot be changed, at the same debug level as the "already present" line. `CadreNode.publishStrandPeer` passes `role: null`, with a comment saying why that is accurate today: `StrandInstanceManager` publishes a row only for a node that serves the strand's blocks.

**Docs.** The `StrandPeer` row of the Tables list in `docs/cadre/control-schema.md` says the row also states whether the machine serves the strand; "A machine's own signature" gains one sentence on the two forms and why rows from before version 5 still verify.

## Tests

- **`control-database-strand-peer.spec.ts`, new `it` "a row that states a role is signed over it, and neither signed form passes for the other".** A `role: 'client'` row inserted through `insertStrandPeer` reads back with its role. The same machine's row with `Role = 'client'` signed by hand over three fields is refused with `Authorized`, and a null-role row signed by hand over four fields is refused the same way. Both negative arms assert the named constraint, so neither can pass vacuously.
- **Existing tests** in that spec now pass `role: null`; `strand-party-peers.spec.ts`'s row helper gained `role: null` to compile.
- **No new case** in `control-schema-versions.spec.ts` or `control-schema-drift.spec.ts`. They pass with the v5 fixture and the `CHANGED_DIGESTS` entry, which together prove the v4 to v5 difference has no unmigratable statement and that the one digest change is recorded.

## Validation run

| Check | Result |
|---|---|
| `yarn workspace @serfab/cadre-core typecheck` | pass |
| `yarn workspace @serfab/integration-tests typecheck` | pass |
| Six targeted cadre-core specs (schema versions, drift, strand-peer, party peers, store migration, peer authorization) | 37 of 37 pass |
| `yarn workspace @serfab/cadre-core test` | 200 files, 2705 pass, 1 skipped |
| `yarn lint` | pass, 66 docs OK |
| `yarn workspace @serfab/cadre-core build` | pass |
| `control-schema-migration-mixed-releases.integration.ts` | pass, 65 s |

The one skipped test is the Windows-conditional `it.skipIf` in `key-store.spec.ts`, unrelated and pre-existing.

## Known gaps for the reviewer

- **No release note.** The implement ticket said the next ticket carries the release note, so none was added here. A schema version bump is itself release-visible, so decide whether `.release-notes.pending.md` should name version 5 now rather than with the client behaviour.
- **A version-4 reader dropping a client's row is verified by inspection only.** The mixed-release scenario runs both synthetic releases on this build's code, so no test has a real version-4 reader meet a four-field row. The reasoning: `verifyStrandPeerRow` on version 4 builds the three-field digest, which cannot match a signature over four fields.
- **The reader casts `Role` without validating it.** `strandPeerRowOf` maps any stored string to `StrandPeerRole`, as `cadrePeerRowOf` does for `Profile`. A row carrying an unknown role would still have to be signed by the machine it names, and only a machine that bypassed its own `KnownStrandPeerRole` check could write one. Decide whether that deserves a tripwire `NOTE:` or a narrowing in the mapper.
- **`KnownStrandPeerRole` and an empty-string role are untested**, by inspection as the implement ticket allowed.
- **The role-mismatch log is debug-level only**, as asked. Nothing else surfaces a machine whose `strandCohortMember` role changed after its first publish for a strand; the next ticket documents the limit and its remedy.
- **`docs/cadre/node.md` still says a client writes no `StrandPeer` row.** True today and deliberately left for the next ticket, which changes that behaviour. The `role: null` comment in `publishStrandPeer` should go with it.
- **Type-only import cycle.** `control-authorization.ts` now imports a type from `types.ts`, which already imports types from `control-authorization.ts`. Erased at compile time and lint is clean, but it is new.
