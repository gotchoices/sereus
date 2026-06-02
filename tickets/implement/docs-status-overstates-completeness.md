description: Correct doc-status accuracy — stop presenting the stubbed storage-ring/keyspace/quota subsystem as complete, fix the cadre-core README profile table to match code, update the STATUS.md Cadre/Cohort checklists to reflect landed work, and relabel the empty strands.md sections
files: docs/architecture.md, docs/STATUS.md, packages/cadre-core/README.md, docs/strands.md, packages/cadre-core/src/arachnode-stub.ts, packages/cadre-core/src/strand-instance-manager.ts, schemas/control.qsql
prereq:
effort: low
----

This is a **documentation-only accuracy fix**. No code changes, no tests to add — just bring the status/architecture/README docs into agreement with what the code actually does. Build/test impact is nil (markdown only), but run a quick markdown sanity read after editing.

## Research findings (already done — apply these, don't re-discover)

### IMPORTANT: the original ticket's file:line references were partly wrong

The original fix ticket attributed the `(Complete)` headings and the "Profile Configuration" item to `docs/STATUS.md:795/806`. **Those are actually in `docs/architecture.md`**, in its `## Implementation Status` section (starts at `architecture.md:793`). The real `docs/STATUS.md` is only **188 lines** and contains the Cadre/Cohort Management checklists (`STATUS.md:150-181`) and nothing about cadre-core completeness. Treat the file references below as authoritative — they were re-verified against the current tree.

### What the code actually does (ground truth)

- The concentric-ring / keyspace / capacity-quota subsystem in cadre-core is `packages/cadre-core/src/arachnode-stub.ts`. `start()`/`stop()` are no-op logging stubs (`arachnode-stub.ts:48-101`) and `calculateKeyspaceStart`/`calculateKeyspaceEnd` are explicitly "placeholder/stub" (`arachnode-stub.ts:124-142`).
- `ArachnodeStub`/`createArachnodeStub` are **exported from `index.ts` but never instantiated anywhere in the runtime path** (verified: only defs in `arachnode-stub.ts` + re-export in `index.ts`). So the ring/keyspace code is currently dead stub code.
- The only real, observable effect of profile selection is in `packages/cadre-core/src/strand-instance-manager.ts`:
  - `:202` — `fretProfile: config.profile === 'storage' ? 'core' : 'edge'`
  - `:210` — `arachnode: { enableRingZulu: config.profile === 'storage' }`
  - i.e. **Ring Zulu is enabled for the `storage` profile, NOT `transaction`.** This is passed as a hint to optimystic's `createLibp2pNode`; cadre-core itself does no ring/keyspace/quota work.
- `schemas/control.qsql` (schema `CadreControl`) already defines the control/cadre schema with tables: `AuthorityKey`, `ValidationKey`, `Strand`, `CadrePeer`, `FormationInvite`, `FormationUsage` (different — and better — shape than the STATUS.md checklist's proposed `cadres`/`cadre_nodes`/`node_keys`).
- `@serfab/cadre-core` is built and shipping (`packages/cadre-core/dist/` present); `docs/architecture.md` documents the cadre/cohort model; `docs/strands.md` defines party/node/cadre/strand/cohort.

### Out of scope (avoid overlap)

- Building Ring Zulu / storage rings is tracked by `tickets/backlog/later/5-ring-zulu-storage-rings.md` (blocked on Arachnode). This ticket does **not** implement anything — only marks docs as designed-but-not-implemented.
- Hibernation backoff / stub check-in doc claims in `architecture.md`/`STATUS.md` are owned by `tickets/plan/hibernation-no-resource-release-and-stub-checkin.md` — **do not touch the Hibernation bullet** (`architecture.md:805`).

---

## TODO

### docs/architecture.md — `## Implementation Status` → `### @serfab/cadre-core (Complete)`

- Revise the **Profile Configuration** bullet (`architecture.md:806`). It currently reads:
  `- **Profile Configuration**: Transaction vs storage mode with FRET profile mapping`
  Rewrite so it states only what is wired and explicitly flags the rest as unimplemented. Suggested:
  `- **Profile Configuration**: Transaction vs storage mode selects the FRET profile (`edge`/`core`) and toggles the Ring Zulu hint passed to the libp2p node (`strand-instance-manager.ts:202,210`). _The concentric storage-ring / keyspace-partitioning / capacity-quota subsystem is **not implemented** — `arachnode-stub.ts` is a no-op stub (exported but currently unused). See [Node Profiles](#node-profiles) and `tickets/backlog/later/5-ring-zulu-storage-rings.md`._`
- The `(Complete)` heading itself can stay (the package is substantially complete), but the qualifier above must make clear the storage-ring portion is not. If you prefer, append a short parenthetical to the heading note rather than only the bullet — author's choice, as long as a reader cannot conclude storage rings are implemented.

### docs/architecture.md — `## Node Profiles` (`architecture.md:83-108`)

- This section presents storage rings, keyspace partitioning, and "capacity quotas" as live behavior. Add a clearly-visible callout near the top of the section (e.g. a `> **Designed, not yet implemented:**` blockquote) stating that the concentric storage-ring model (Ring Zulu participation aside from the on/off hint, Rings 0–3, keyspace partitioning, capacity quotas) describes the **intended design**; the current implementation is the `arachnode-stub.ts` no-op stub, and the only wired effect of profile selection is the FRET `edge`/`core` choice plus the Ring Zulu enable flag.
- Keep the table/design prose (it's a useful design reference) — just ensure it reads as design, not shipped behavior. The line `Transaction-profile nodes skip Arachnode initialization entirely (no StorageMonitor, RingSelector, or RestorationCoordinator)` (`architecture.md:92`) describes components that don't exist yet — fold it under the same "designed, not implemented" framing.

### packages/cadre-core/README.md — Node Profiles table (`README.md:94-99`)

The table is backwards vs the code and contradicts architecture.md. Fix both the table and the trailing sentence:
- Current table says `transaction` = "Ring Zulu only" and `storage` = "Ring Zulu + Storage Rings". Per `strand-instance-manager.ts:210` and `architecture.md:92,107`, **Ring Zulu is the storage profile's**; the transaction profile does FRET-only transaction verification with Arachnode disabled. Rewrite so:
  - `transaction` → Arachnode disabled; transaction verification via FRET only; Ring Zulu: no.
  - `storage` → Ring Zulu + storage rings (note storage rings are not yet implemented — stub); full archival storage; Ring Zulu: yes.
- Replace the sentence `Both profiles participate in transaction consensus. The distinction is long-term storage commitment.` (`README.md:99`) with wording that matches architecture.md: transaction-profile nodes verify transactions via FRET only; storage-profile nodes additionally join Ring Zulu and (when implemented) the concentric storage rings. Add a one-line note that the storage-ring subsystem is currently a stub, linking the design to `docs/architecture.md` Node Profiles.

### docs/STATUS.md — Cadre Management & Cohort Management checklists (`STATUS.md:150-181`)

Update the markers so landed work isn't shown as untouched todo. Use `[x]`/`[~]` per the file's legend (`[~]` = partially done). Specifically:
- **Cadre Management** (`:150-167`):
  - Definitions (cadre vs node vs device identity) — covered in `docs/strands.md` + `docs/architecture.md` → `[x]` (point to those docs instead of the suggested new `docs/cadre.md`).
  - Schema tables item (`:161`) — mark `[~]`: a control/cadre schema already exists at `schemas/control.qsql` (schema `CadreControl`) with tables `AuthorityKey`, `ValidationKey`, `Strand`, `CadrePeer`, `FormationInvite`, `FormationUsage` — note the actual shape differs from the proposed `cadres`/`cadre_nodes`/`node_keys`.
  - "Decide where the schema lives long-term" (`:164-166`) — resolved → `[x]`: `.qsql` artifacts under `schemas/`.
- **Cohort Management** (`:168-181`):
  - Definitions (strand vs cohort vs cadre) — covered in `docs/strands.md:6-11` → `[x]`.
  - Strand/membership schema item (`:178-179`) — `[~]`: `Strand` + formation/invite tables exist in `control.qsql`; full `strand_members`/`roles` modelling still pending.
- Leave genuinely-unstarted items (`docs/cohort.md` spec doc, RBAC model, audit trail, multi-party bootstrap roadmap) as `[ ]`. The goal is to stop the section reading as "nothing done", not to over-claim. Add a short note at the top of each section pointing to `schemas/control.qsql`, `docs/architecture.md`, and built `@serfab/cadre-core` as the current sources of truth.

### docs/strands.md — empty trailing sections (`strands.md:85-88`)

The doc ends with empty `## Strand Creation` and `## Inviting Parties` headings. Relabel them so they don't read as missing content: replace the empty headings with a brief "not yet written here — see …" note pointing readers to the live coverage in `docs/architecture.md` (Enrollment and Bootstrap / seed bootstrap / strand-formation sections) and the cadre-core README. Either remove the bare headings or keep them with an explicit `_(TODO: not yet documented; see architecture.md)_` line under each — do not leave them blank.

### Verify

- Re-read each edited section to confirm no remaining sentence claims storage rings / keyspace partitioning / capacity quotas are implemented, and that no doc still says the transaction profile (rather than storage) is the Ring-Zulu one.
- No build/test run required (markdown only).
