description: Review of documentation-accuracy fix — verify the storage-ring/keyspace/quota subsystem is no longer presented as implemented, the cadre-core README profile table matches code, STATUS.md checklists reflect landed work, and strands.md empty sections are relabeled
files: docs/architecture.md, docs/STATUS.md, packages/cadre-core/README.md, docs/strands.md, packages/cadre-core/src/arachnode-stub.ts, packages/cadre-core/src/strand-instance-manager.ts, schemas/control.qsql
prereq:
----

Documentation-only accuracy fix. No code changed, no build/test run (markdown only). Reviewer should sanity-read the edited sections against ground truth.

## Ground truth (verified)

- Storage-ring/keyspace/quota lives in `packages/cadre-core/src/arachnode-stub.ts` — `start()`/`stop()` are no-op stubs (`:48-101`), keyspace calcs are placeholders (`:124-142`). `ArachnodeStub`/`createArachnodeStub` are exported from `index.ts` but never instantiated in the runtime path (dead stub code).
- Only real effect of profile selection is in `strand-instance-manager.ts`: `:202` FRET `core` (storage) vs `edge` (transaction); `:210` `enableRingZulu: config.profile === 'storage'`. **Ring Zulu = storage profile**, not transaction.
- `schemas/control.qsql` (schema `CadreControl`) defines `AuthorityKey`, `ValidationKey`, `Strand`, `CadrePeer`, `FormationInvite`, `FormationUsage`.

## Changes made

- **docs/architecture.md**
  - `## Implementation Status` → Profile Configuration bullet (~`:806`): now states only the wired effect (FRET edge/core + Ring Zulu hint) and flags storage-ring/keyspace/quota as not implemented, pointing to the stub and backlog ticket.
  - `## Node Profiles`: added a `> **Designed, not yet implemented:**` callout at the top; reframed the "skip Arachnode initialization" paragraph (StorageMonitor/RingSelector/RestorationCoordinator) as designed-but-absent.
- **packages/cadre-core/README.md** — Node Profiles table corrected: transaction = Arachnode disabled / FRET-only / Ring Zulu **No**; storage = Ring Zulu + (stub) storage rings / Ring Zulu **Yes**. Replaced the "Both profiles participate in transaction consensus" sentence; added a stub note linking architecture.md.
- **docs/STATUS.md** — Cadre Management & Cohort Management checklists: definitions marked `[x]` (point to strands.md/architecture.md), schema-tables items `[~]` (control.qsql exists, shape differs from proposed), "where schema lives" `[x]` (.qsql under schemas/). Added a sources-of-truth note atop each section. Genuinely-unstarted items left `[ ]`.
- **docs/strands.md** — empty trailing `## Strand Creation` / `## Inviting Parties` headings now have explicit TODO/see-also notes instead of blank bodies.

## Review focus / known gaps

- Confirm no remaining sentence in the four docs claims storage rings / keyspace partitioning / capacity quotas are implemented, and nothing says the *transaction* profile is the Ring-Zulu one.
- **Out of scope (do not touch):** the Hibernation bullet (`architecture.md:805`) is owned by `hibernation-no-resource-release-and-stub-checkin`; Ring Zulu implementation is `tickets/backlog/later/5-ring-zulu-storage-rings.md`.
- Line numbers in the bullets above are approximate post-edit (file shifted as content was added). Markdown link targets (`#node-profiles`, relative `../../docs/...`) were added by hand — reviewer may want to eyeball anchor/path correctness.
