----
description: Populate and enforce the strand membership/RBAC tables at runtime — Header, founding Authority/Member, invite issuance/consumption, and MemberPeer — wired into strand formation and join
prereq: apply-strand-membership-schema
files: schemas/strand.qsql, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/types.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts
difficulty: hard
----

## Why this is separate

Once `apply-strand-membership-schema` lands, the `Strand` membership/RBAC tables exist and
their `verify()`-gated constraints are active and correct — but **no runtime code writes to
them**. The schema being present is necessary but not sufficient for Sereus's central
consent/RBAC promise: a strand still has no `Header` row, no founding `Authority`/`Member`, no
invite issuance/consumption, and no `MemberPeer` registration. Populating these is a distinct,
larger effort because it is entangled with **strand formation and join coordination** (who is
the founder, exactly one node inserts the bootstrap rows, joiners receive them via Optimystic
sync) and with **signing** (each write must carry a `with context (...)` signature the
constraints verify). This belongs in its own design pass rather than bloating the
schema-application ticket.

## Problem / desired behavior

The membership model defined in `schemas/strand.qsql` should be **enforced end-to-end on a
live strand**:

- **Header**: exactly one `Header` row per strand, inserted once by the strand's **founder**
  (the formation responder/creator) carrying `Id`, `Type` (`'o'`/`'c'`), `sAppId`,
  `sAppVersion`, `sAppSchema`, `sAppSignature`, `Engine`, `EngineVersion` — sourced from the
  `SAppConfig` (`types.ts:250-261`) plus the strand `Type` from `CadreControl.Strand`
  (`StrandRow.Type`, `types.ts:240-244`). A node that **joins** an existing strand must **not**
  insert `Header`; it receives the row via sync. `Header` is insert-only with a singleton
  primary key, so population must be founder-designated and idempotent (insert-if-absent),
  avoiding the founder-vs-joiner race.
- **Founding Authority/Member**: for a closed strand, the founder's member key (derived from
  `CadreControl.Strand.MemberPrivateKey`) is inserted as the first `Member` (the `count<=1`
  bootstrap branch) and the first `Authority` (the bootstrap branch).
- **Invite issuance/consumption**: an `Authority` issues an `Invite` (proving possession of the
  invite key); a joining member consumes it, recording a `ConsumedInvite` and admitting the
  corresponding `Member`. This is the SQL-layer counterpart to the existing seed/formation
  invite flows — reconcile with `FormationInvite`/`FormationUsage` (control layer) and the
  Member Registration API (`registerMember`/`validateMemberRegistration`) rather than
  duplicating them.
- **MemberPeer**: a member signs and registers its peer/node associations.
- **Authority rotation**: subsequent authority add/remove satisfies `Authority.Authorized`.

Each write supplies the `with context (...)` signature parameters the repaired constraints
verify (ed25519, `digest(<canonical payload>, 'sha256','utf8')`), mirroring how
`ControlDatabase.insertStrand` passes `with context AuthorityKey=?, Signature=?, StampId=?`
(`control-database.ts:394-398`). The canonical payload concatenation must match the shape
fixed in `apply-strand-membership-schema` / `1-integration-tests-rbac-signed-write-coverage`.

## Open design questions (resolve during the plan pass)

- **Founder designation**: how does a bring-up path know it is the founder vs a joiner? Likely
  signalled by the formation flow (`strand-formation-protocol.ts` / `StrandProvisioner`) or
  inferred from being the strand creator in `CadreControl.Strand`. The bring-up code
  (`StrandInstanceManager.startStrand` / `StrandDatabase`) needs that signal threaded through.
- **Reconciliation with existing membership/invite surfaces**: control-network
  `FormationInvite`/`FormationUsage`, the seed-bootstrap path, and the Member Registration API
  already model parts of join/consent at other layers. Decide what the SQL-layer Strand tables
  own vs. what stays at the control/formation layer, to avoid two competing sources of truth.
- **Open strands**: `Member`/`Invite`/`Authority` are `OnlyClosed`. Clarify what membership
  state (if any) an open strand records, and that open strands skip the bootstrap inserts.
- **Plumbing**: `Type` and the sApp fields are not currently passed into `StrandDatabase` /
  the composition seam; thread them through (likely via `StrandDatabaseConfig` and the
  formation result).

## Expected end-state tests (later phases)

- Closed-strand formation produces exactly one `Header` (`Type='c'`), one founding `Member`,
  one founding `Authority`; a joining node sees them via sync without re-inserting.
- An authority issues an invite; a new member consumes it → `ConsumedInvite` + `Member` rows
  admitted; an unauthorized join is rejected.
- Authority rotation: an existing authority adds another; a non-authority attempt is rejected.
- `MemberPeer` insert succeeds only with the member's own signature.
- An integration scenario (extending `strand-formation-e2e.integration.ts`) drives the full
  closed-strand invite→join→write path across two real `CadreNode`s.

## Key references

- `schemas/strand.qsql` — membership/RBAC tables and (post-repair) constraints to populate.
- `packages/cadre-core/src/control-database.ts:376-401` — `insertStrand` `with context` DML
  pattern to mirror for signed Strand writes.
- `packages/cadre-core/src/strand-instance-manager.ts:138-254` — strand bring-up where
  founder/joiner population would hook in.
- `packages/cadre-core/src/strand-formation-protocol.ts` / `StrandProvisioner` — formation flow
  that designates the founder and carries member keys.
- `docs/architecture.md` (Strand Formation, Member Registration API) — existing consent/join
  surfaces to reconcile against.
