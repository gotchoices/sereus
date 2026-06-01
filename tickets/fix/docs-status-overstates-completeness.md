----
description: STATUS.md/architecture.md/cadre-core README overstate completeness (cadre-core "Complete", storage rings, cadre/cohort checklists, profile table)
files: docs/STATUS.md, docs/architecture.md, packages/cadre-core/README.md, packages/cadre-core/src/arachnode-stub.ts, docs/strands.md
----
Sereus's project status docs are intended to be a living, accurate checklist of what is built versus pending — the README points readers to `docs/STATUS.md` for exactly this purpose. Several status and architecture claims currently misrepresent the real state of the code: they present stubbed or unbuilt subsystems as complete, and conversely mark already-implemented work as untouched todo. This erodes the trustworthiness of the docs for anyone using them to reason about the system.

### cadre-core marked "Complete" while the storage/profile subsystem is a stub

`docs/STATUS.md:795` heads the section `@serfab/cadre-core (Complete)`, and `STATUS.md:806` lists "Profile Configuration: Transaction vs storage mode with FRET profile mapping" as a done item. `docs/architecture.md:84-108` presents Node Profiles and the concentric storage ring model (Ring Zulu, Rings 0-3, keyspace partitioning, capacity quotas) as implemented behavior.

In reality the storage/ring subsystem is `packages/cadre-core/src/arachnode-stub.ts`, whose `start`/`stop` and keyspace methods are no-op stubs with placeholder keyspace math (`arachnode-stub.ts:20-31` documents it as a stub; `:52-76` `start()` only logs and computes a placeholder `RingConfig`; `:124-142` `calculateKeyspaceStart`/`calculateKeyspaceEnd` are explicitly "placeholder" / "stub" calculations). The only real, observable effect of profile selection is the `fretProfile` core/edge hint and the `enableRingZulu` toggle (`packages/cadre-core/src/strand-instance-manager.ts:202,210`). Concentric storage rings, keyspace partitioning, and capacity quotas are not implemented.

### Cadre/Cohort management checklists predate the work and now misrepresent it

`docs/STATUS.md:150-181` (the "Cadre Management" and "Cohort Management" sections) list every item as an unchecked todo — create spec docs, propose tables `cadres`/`cadre_nodes`/`node_keys`, decide where the schema lives, etc. Much of this work already exists: `schemas/control.qsql` defines the control/cadre schema, `docs/architecture.md` covers the cadre/cohort model, and `@serfab/cadre-core` is built and shipping. The checklist was written before the work landed and now reads as if none of it is done, directly contradicting the rest of STATUS.md and the README's "living checklist" framing.

### cadre-core README profile table contradicts the code and architecture.md

`packages/cadre-core/README.md:94-99` describes the transaction profile as "Ring Zulu only" and states that "both profiles participate in transaction consensus." Both claims conflict with the code and the architecture doc:
- `packages/cadre-core/src/strand-instance-manager.ts:210` sets `enableRingZulu = (profile === 'storage')`, i.e. Ring Zulu is enabled for the storage profile, not the transaction profile.
- `docs/architecture.md:92,107` state that only storage-profile nodes join Ring Zulu and that transaction-profile nodes skip Arachnode initialization.

The README profile table must be brought into agreement with the actual code behavior and architecture.md.

### strands.md is linked as a reference but ends in empty unfinished sections

`docs/strands.md` is linked as the strand-management reference, yet it ends with empty, unfinished sections (`docs/strands.md:85-88`). A reference doc with hanging empty headings should either be completed or have the stub sections relabeled/removed so the doc accurately reflects its coverage.

### Expected outcome

- Correct `docs/STATUS.md` completion markers so the cadre-core section and the storage/ring/profile items reflect actual state (stubbed vs implemented). The "Profile Configuration" and storage-ring claims must not read as complete while `arachnode-stub.ts` is a no-op stub.
- Update the "Cadre Management" and "Cohort Management" checklists in `docs/STATUS.md` to reflect work that already exists (`schemas/control.qsql`, `docs/architecture.md`, built `@serfab/cadre-core`) rather than presenting it as untouched todo.
- Fix the `packages/cadre-core/README.md` profile table so its Ring Zulu / transaction-vs-storage description matches the code (`strand-instance-manager.ts:210`) and `docs/architecture.md:92,107`.
- Reconcile `docs/architecture.md:84-108`'s presentation of storage rings / keyspace partitioning / capacity quotas with their stubbed implementation status (e.g. mark as designed-but-not-yet-implemented).
- Complete or relabel the unfinished sections in `docs/strands.md:85-88`.

### Related

- `tickets/backlog/later/5-ring-zulu-storage-rings.md` tracks the actual implementation of Ring Zulu / storage-ring participation (blocked on Arachnode). This ticket is purely about doc/status accuracy, not building the subsystem.
- `tickets/plan/hibernation-no-resource-release-and-stub-checkin.md` already owns correcting the hibernation backoff / check-in doc claims in `docs/architecture.md` and `docs/STATUS.md`; those are out of scope here to avoid overlap.
