----
description: An admin's approval for adding someone as an admin is a reusable token — the same approval also works to remove that person, and works again later, so a captured approval can be replayed to undo or redo admin changes.
prereq: strand-manager-authorization-hardening
files: schemas/strand.qsql (Manager table), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts (addManager, removeManager, signStrandPayload)
----

# Strand manager authorizations are neither single-use nor action-scoped

`Strand.Manager` writes are authorized by an ed25519 signature over `digest(<manager key>)` — one
field, no nonce, and the **same payload for add and remove**. Two consequences:

- **Cross-action reuse.** A signature that manager M produced to ADD key X is also a valid
  authorization to REMOVE X, and vice versa.
- **Replay.** Nothing marks an authorization as spent, so a captured signature stays valid
  forever — X can be re-added after being removed, or re-removed after being re-added, by anyone
  who kept a copy.

Constraint context values travel with the write to the strand's peers, so "captured" does not
require a network attacker to be in an unusual position.

This is the strand-side analog of work already done on the control side: the completed
`membership-cadrepeer-authority-antireplay` ticket gave `CadreControl.CadrePeer` a single-use
`StampId` column plus distinct insert-vs-delete signed payloads.
`bug-devicetoken-authority-antireplay` (backlog) is the same follow-up for `DeviceToken`. This
ticket is the same treatment for the strand membership tables.

Scope should be considered across all signed strand writes, not only `Manager` —
`Member.Authorized` (manager-signed `digest(new.Key)`) and `MemberPeer.Authorized`
(self-signed `MemberKey|PeerId`, shared by insert and delete) have the same shape.

Deliberately kept out of `strand-manager-authorization-hardening`: adding a nonce column changes
the table shape, every writer, and the drift-mirrored schema copies — a partial nonce would be
worse than none.
