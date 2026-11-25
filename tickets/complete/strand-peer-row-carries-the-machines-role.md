description: A machine's record of its network identity in a shared workspace gains a field saying whether the machine stores that workspace or only uses it through others, so the party's other machines can tell a phone that stores nothing from a server.
architecture: docs/cadre/control-schema.md#schema-versions-and-migrations
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/fixtures/control-schema/v5.qsql, packages/cadre-core/test/control-schema-versions.spec.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, packages/cadre-core/test/strand-party-peers.spec.ts, docs/cadre/control-schema.md
difficulty: hard
----

# The `StrandPeer` row records whether the machine serves the strand

First of three tickets toward `client-locked-out-of-closed-strand-after-party-key-replacement`. This one changed only the control row and the code that writes, reads and verifies it. The next ticket (`client-publishes-its-strand-peer-row-marked-client`) makes clients publish the row and makes the readers act on the new field; the last (`scenario-client-survives-party-key-replacement`) proves the chain on a real network.

## What was built

Implemented in `ticket(implement): strand-peer-row-carries-the-machines-role`, reviewed and amended in this pass.

**Control schema version 5.** `CadreControl.StrandPeer` gains `Role text null` after `StrandPeerId`. Null means the machine serves the strand, which is what every row written before this version meant; `'client'` means it runs the strand without storing any of it. A named table-level check, `KnownStrandPeerRole`, admits only those two values, so the column itself stays a plain nullable add. `CONTROL_SCHEMA_VERSION` is 5, the `sereus.controlSchemaVersion` tag in both schema copies reads 5, and `schemas/control.qsql` is copied byte for byte to `test/fixtures/control-schema/v5.qsql`. The schema comment above the table explains the column, why null means serving, the two signed forms and why there are two, and that the immutable row fixes the role at the machine's first publish for that strand.

**Two signed forms.** `StrandPeer.Authorized` has two branches: a row with `Role` null must verify over `(StrandId, PeerId, StrandPeerId)`, the form every earlier row was signed over; a row with `Role` set must verify over those three and `Role`. A serving machine's row is therefore byte-identical to one written under version 4, and a machine still on version 4 verifies it. A version-4 machine verifies a client's row against the three-field form, fails, and drops it, which leaves that machine where it was before the client had a row. The versions spec records the change in `CHANGED_DIGESTS` as `{ version: 5, table: 'StrandPeer', action: 'add' }`.

**TypeScript.** `StrandPeerRole = 'client'` lives in `control-authorization.ts` beside `StrandPeerSignedFields.role`, and `types.ts` re-exports it, so it is public through `index.ts`'s `export *`. `strandPeerRowFields` appends the role only when it is not null, and `verifyStrandPeerRow` needed no new logic because the builder picks the form from the row's own role. In `control-database.ts`, `readStrandPeerRows` selects and maps `Role` through `strandPeerRowOf`, whose `strandPeerRoleOf` reads `'client'` as `'client'` and anything else, null included, as null. `insertStrandPeer` takes `Omit<StrandPeerSignedFields, 'peerId'>`, writes the column and signs through the builder. When a held row's role differs from the role being published, `logHeldStrandPeer` logs both roles and that the row cannot be changed, at debug level. `CadreNode.publishStrandPeer` passes `role: null`, with a comment saying why that is accurate today.

**Docs.** The `StrandPeer` row of the Tables list in `docs/cadre/control-schema.md` says the row also states whether the machine serves the strand; "A machine's own signature" has one sentence on the two forms; step 5 of "Changing the schema" now states the general rule this version follows for a changed digest.

## Review findings

**Read first.** The implement commit's diff, fresh, before the handoff. Then every reader and writer of the row: `readStrandPeerRows`, `queryStrandPeers`, `insertStrandPeer`, `verifyStrandPeerRow`, `strandPeerAddDigest`, `CadreNode.publishStrandPeer`, `partitionPartyStrandPeers`, and the three integration scenarios that call `queryStrandPeers`. Nothing outside cadre-core selects from the table by SQL. `schemas/control.qsql` and the v5 fixture are byte-identical; the v4 to v5 fixture diff is the version tag, the new column, the two constraints, and comment-only edits made since v4 shipped.

**Schema.** The `KnownStrandPeerRole` check is a named table-level CHECK, as the migration doc requires, and the versions spec classifies the v4 to v5 difference with no unmigratable statement. `StrandPeer` is never updated, so the "older machine's update drops new columns" case in the mixed-versions section does not reach it. An empty-string role fails both arms of the check and is refused; by inspection.

**Minor findings, fixed in this pass.**

- **The reader cast any stored string to `StrandPeerRole`.** Replaced with `strandPeerRoleOf`, which narrows to the one known value. A row with a role this build does not know now reads as null, fails verification because its digest omits the role, and is dropped, exactly as a version-4 reader drops a `'client'` row. Chosen over a tripwire because the next ticket derives "serves" as "role is not `'client'`", and a cast-through reader would then treat a role added by a later version as serving, which is the defect this ticket chain exists to fix. The consequence is in the function's comment, not a `NOTE:`, because it is a stated invariant rather than conditional work.
- **Type-only import cycle** between `control-authorization.ts` and `types.ts`. Removed by defining `StrandPeerRole` in `control-authorization.ts`, which `types.ts` already imported from; `types.ts` re-exports it so the public surface is unchanged, and the module's "no imports" comment is true again.
- **`insertStrandPeer` restated the signed fields as an inline type.** Now `Omit<StrandPeerSignedFields, 'peerId'>`.
- **Step 5 of "Changing the schema"** said writers sign the new form, which this version deliberately does not do for a null-role row. Reworded to the rule this version follows and why: signing the new form over a row whose new fields are null would make every older machine drop the row.

**Major findings.** None. The two-form design is the right one for a mixed-release party, the immutability of the row is pre-existing, and no reader's behaviour changes until the next ticket.

**Tripwires.** None added. The one conditional concern, a later schema version adding a role, is handled by the narrowing above and documented at the site.

**Tests.** Kept the implementer's new case in `control-database-strand-peer.spec.ts`: it pins the two signed forms against the schema's two branches, which is real branching, and both negative arms assert the named constraint. Cut none. Added none: the narrowing's only observable effect needs a row with an unknown role in the store, which the inserting node's own `KnownStrandPeerRole` check refuses, so no layer in this repository can reproduce it without mocking the database; verified by reading `verifyStrandPeerRow`.

**Handoff gaps, dispositions.**

- **No release note.** Left for the next ticket, whose body explicitly owns the version-5 section of `.release-notes.pending.md`.
- **A version-4 reader dropping a client's row is verified by inspection.** Accepted: `strandPeerRowFields` on version 4 returns three fields, and the framed digest over four cannot match. The next ticket's release note states the window.
- **The role-mismatch log is debug-level only.** Accepted as asked; the next ticket documents the limit in `docs/strands/membership.md`.
- **`docs/cadre/node.md` still says a client writes no row.** True until the next ticket changes the behaviour; it rewrites that bullet and the `role: null` comment in `publishStrandPeer`.

**Validation.**

| Check | Result |
|---|---|
| `yarn workspace @serfab/cadre-core typecheck` | pass |
| `yarn workspace @serfab/integration-tests typecheck` | pass |
| Five targeted cadre-core specs (schema versions, drift, strand-peer, party peers, peer authorization) | 31 of 31 pass |
| `yarn workspace @serfab/cadre-core test` | 200 files, 2705 pass, 1 skipped |
| `yarn lint` | pass, 66 docs OK |

The skipped test is the Windows-conditional `it.skipIf` in `key-store.spec.ts`, pre-existing and unrelated. The mixed-release migration scenario was not rerun: this pass changed no schema text, and the implement pass ran it green.
