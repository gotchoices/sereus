description: A machine's record of its network identity in a shared workspace gains a field saying whether the machine stores that workspace or only uses it through others, so the party's other machines can tell a phone that stores nothing from a server.
architecture: docs/cadre/control-schema.md#schema-versions-and-migrations
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/fixtures/control-schema/v5.qsql, packages/cadre-core/test/control-schema-versions.spec.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, docs/cadre/control-schema.md
difficulty: hard
----

# The `StrandPeer` row records whether the machine serves the strand

This is the first of three tickets that fix `client-locked-out-of-closed-strand-after-party-key-replacement`. It changes only the control row and the code that writes, reads and verifies it. The next ticket (`client-publishes-its-strand-peer-row-marked-client`) makes clients publish the row and makes the readers use the new field; the last (`scenario-client-survives-party-key-replacement`) proves the whole chain on a real network.

## Why the fact goes on this row

`CadreControl.StrandPeer` is each machine's signed statement of the peer id it uses in one strand (`schemas/control.qsql`, `docs/cadre/control-schema.md` → Tables). Two readers need to know, per row, whether the machine stores the strand's blocks: the offline write queue waits only for machines that do (`docs/strands/writes.md` → Waiting for the party's own machines), and the party key replacement and the membership loop must bind every live machine, storing or not (`docs/strands/membership.md` → Binding the party's machines). The fact is per strand, since a machine's `strandCohortMember` role is a node setting and nothing stops one node from being reconfigured between strands, and `CadrePeer.Profile` cannot take a third value (`node-class.ts`, and the limit in `docs/cadre/control-schema.md`). So it is a new column on `StrandPeer`.

## The change

**Column.** `Role text null` on `StrandPeer`, after `StrandPeerId`. `null` means the machine serves the strand, which is what every row written before this version meant. `'client'` means the machine runs the strand as a client (glossary: `docs/concepts.md`). A named table-level check, `KnownStrandPeerRole check (Role is null or Role = 'client')`, so the column itself stays a plain nullable add (the control schema's rule for a rule on a new column). Every stored row reads null for the column, so the new check holds on every existing store.

**Two signed forms.** The framed digest is injective over its field list (`@optimystic/quereus-plugin-crypto` `digest`), so a row that signs the role cannot verify against the three-field form. Keep both, as `docs/cadre/control-schema.md` → Changing the schema step 5 requires:

- A row with `Role` null is signed over `StrandId, PeerId, StrandPeerId`, exactly as today. A serving machine's row is therefore byte-identical to one written under version 4, and a machine still on version 4 verifies it.
- A row with `Role` set is signed over `StrandId, PeerId, StrandPeerId, Role`.
- `StrandPeer.Authorized` becomes: the `CadrePeer` row exists and either (`new.Role is null` and the three-field digest verifies) or (`new.Role is not null` and the four-field digest verifies). Do not use `coalesce(new.Role, '')` in one digest: that would change the form every serving machine signs and a version-4 reader would then drop every new serving row.
- In TypeScript, `strandPeerRowFields` (`control-authorization.ts`) appends `role` only when it is not null, and `StrandPeerSignedFields` gains `role: StrandPeerRole | null`. `verifyStrandPeerRow` (`peer-authorization.ts`) needs no new logic: the builder picks the form from the row's own role, so a stored row signed over the wrong form fails to verify and is dropped like any forged row.

**Version.** `CONTROL_SCHEMA_VERSION` becomes 5 and the `sereus.controlSchemaVersion` tag in both schema copies with it. Copy `schemas/control.qsql` to `packages/cadre-core/test/fixtures/control-schema/v5.qsql`. Add `{ version: 5, table: 'StrandPeer', action: 'add' }` to `CHANGED_DIGESTS` in `control-schema-versions.spec.ts`; the spec keys a digest by table name without the schema prefix and the action tag. The edit is made identically in `schemas/control.qsql` and the embedded `CONTROL_SCHEMA_DECLARATION` in `control-schema.ts`; `control-schema-drift.spec.ts` compares them character for character.

**Row type and database.** `StrandPeerRow` (`types.ts`) gains `role: StrandPeerRole | null`, with `export type StrandPeerRole = 'client'` beside it (types are re-exported wholesale from `index.ts`). `ControlDatabase.readStrandPeerRows` selects `Role` and maps it; `insertStrandPeer` takes `{ strandId, strandPeerId, role }`, writes the column, and signs through `strandPeerRowFields` so the form follows the role. Its insert-if-absent guard already finds a held row; when the held row's role differs from the role being published, log it at the same level as the "already present" line, naming both roles and that the row cannot be changed (see the edge case below). The two existing callers (`CadreNode.publishStrandPeer`, and the spec) pass `role: null` in this ticket; the next ticket passes the real role.

**Schema comment.** Extend the comment above `table StrandPeer` in both copies: what the column means, that null means serves because that is what every earlier row meant, the two signed forms and why there are two, and that the row stays immutable so the role is fixed at the machine's first publish for that strand.

**Docs.** In `docs/cadre/control-schema.md`: the `StrandPeer` row of the Tables list says the row also states whether the machine serves the strand; under "A machine's own signature", one sentence that a `StrandPeer` row is signed over its role when it has one and over the three older fields when it has none, so rows from before version 5 still verify. Nothing else in the docs changes in this ticket; the behavioural docs change with the next one.

## Edge cases & interactions

- **A machine still on version 4 reads a client's row.** It verifies the three-field form, fails, and drops the row: it neither waits for the client nor binds it, which is what it did before the client had a row. A serving machine's row is unchanged, so nothing a version-4 machine relied on moves. Verified by inspection of `verifyStrandPeerRow` on the v4 fixture's form; state it in the schema comment and in the next ticket's release note.
- **A version-4 machine's catalog has no `Role` column.** Rows are stored by column name, so it ignores the column and the start-time check accepts a store a version-5 sibling migrated (`docs/cadre/control-schema.md` → Mixed versions in one party). No `StrandPeer` row is ever updated, so the "an older machine's update drops new columns" rule does not apply. Verified by inspection against that section.
- **The check edit is a drop and an add of a CHECK**, classified `catalog-only`; the column is a plain nullable add; `KnownStrandPeerRole` is an added CHECK over a column every stored row reads null for. `control-schema-versions.spec.ts` proves the v4 to v5 difference has no `unmigratable` statement. The mixed-release scenario (`control-schema-migration-mixed-releases.integration.ts`) builds its synthetic releases from the fixture of `CONTROL_SCHEMA_VERSION` through `test-harness/control-schema-releases.ts`, whose anchor strings are in `CadrePeer` and `ValidationKey`, so it needs no edit. Run it only if its wall clock fits the run; otherwise say it was not run.
- **Mixed forms are refused.** A row with `Role = 'client'` signed over three fields fails the second branch and skips the first; a row with `Role` null signed over four fields fails the first and skips the second. Pinned by the new spec arm below. The reader side needs no test: it uses the same builder.
- **An empty-string role** fails `KnownStrandPeerRole`. By inspection.
- **The insert check runs on the writing node**, against its own schema. A client on version 5 therefore inserts its row even while a sibling is on version 4; that sibling drops the row on read, as above. By inspection of the schema comment that already states where the check runs.
- **The role is fixed at the first publish.** The row is immutable by design, so a machine whose `strandCohortMember` role changes after it has run a strand keeps the old statement for that strand. This ticket makes `insertStrandPeer` log the mismatch; the next ticket documents the limit and its remedy. Accepted here because the client role ships in the same release as this column (`.release-notes.pending.md`), so no store in the field holds a client row written without a role.
- **`queryStrandPeers` callers compile against the new field.** `partitionPartyStrandPeers` and the integration scenarios read `strandPeerId` only; the next ticket makes them read `role`. By type.

## Tests

One new `it` in `control-database-strand-peer.spec.ts`, beside the existing signature test: a row with `role: 'client'` signed through `insertStrandPeer` inserts and reads back with its role; the same row signed by hand over the three-field form (`buildAuthorizationMessage` with three row fields, inserted with raw SQL as the forged-row test does) is refused with `Authorized`; and a null-role row signed by hand over four fields is refused the same way. The existing tests keep passing with `role: null`.

`control-schema-versions.spec.ts` and `control-schema-drift.spec.ts` need no new cases; they must pass with the new fixture and the `CHANGED_DIGESTS` entry.

## TODO

- Add `Role text null`, `KnownStrandPeerRole` and the two-branch `Authorized` check to `StrandPeer` in `schemas/control.qsql` and `control-schema.ts`, with the extended table comment; bump the version tag to 5 in both.
- Set `CONTROL_SCHEMA_VERSION = 5`; add `test/fixtures/control-schema/v5.qsql`; add the `CHANGED_DIGESTS` entry.
- `types.ts`: `StrandPeerRole`, `StrandPeerRow.role`. `control-authorization.ts`: `StrandPeerSignedFields.role`, `strandPeerRowFields` appends it when set. Check `peer-authorization.ts` needs no change beyond the type.
- `control-database.ts`: select and map `Role`; `insertStrandPeer` takes and writes `role`, signs through the builder, logs a held row whose role differs.
- Update `CadreNode.publishStrandPeer` and the spec to pass `role: null`.
- Docs: `docs/cadre/control-schema.md` Tables row and "A machine's own signature".
- New spec arm in `control-database-strand-peer.spec.ts`.
- Run `yarn workspace @serfab/cadre-core test` in the foreground (at least the control-schema and control-database-strand-peer specs, then the whole package), then `yarn lint`.
