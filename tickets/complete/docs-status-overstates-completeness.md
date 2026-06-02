description: Documentation-accuracy fix — stop presenting the stubbed storage-ring/keyspace/quota subsystem as implemented, correct the cadre-core README profile table to match code, update STATUS.md Cadre/Cohort checklists to reflect landed work, and relabel empty strands.md sections. Reviewed and accepted.
files: docs/architecture.md, docs/STATUS.md, packages/cadre-core/README.md, docs/strands.md, packages/cadre-core/src/arachnode-stub.ts, packages/cadre-core/src/strand-instance-manager.ts, schemas/control.qsql
prereq:
----

Documentation-only accuracy fix (no code changed). Implemented in `1c61529`, reviewed here. The four docs now agree with code: the concentric storage-ring / Ring-Zulu / keyspace-partitioning / capacity-quota subsystem is presented as **designed but not implemented** (a no-op `arachnode-stub.ts`), the cadre-core README profile table matches `strand-instance-manager.ts` (Ring Zulu = **storage** profile, not transaction), the STATUS.md Cadre/Cohort checklists mark landed work, and strands.md's empty trailing headings carry explicit see-also notes.

## Review findings

### What was checked

- **Implement diff re-read with fresh eyes** (`git show 1c61529`) before reading the handoff: all edits are markdown across `docs/architecture.md`, `docs/STATUS.md`, `packages/cadre-core/README.md`, `docs/strands.md`. Zero source files touched.
- **Ground-truth re-verification against code (not just the handoff):**
  - `packages/cadre-core/src/arachnode-stub.ts` — `start()`/`stop()` are no-op logging stubs (`:48-101`); `calculateKeyspaceStart/End` are explicit placeholders (`:124-142`). Confirmed.
  - `ArachnodeStub`/`createArachnodeStub` — repo-wide grep shows only the definition (`arachnode-stub.ts`) plus a re-export in `index.ts:38-41`; **never instantiated in the runtime path**. The "dead stub code" claim holds.
  - `strand-instance-manager.ts:202` → `fretProfile: profile === 'storage' ? 'core' : 'edge'`; `:210` → `enableRingZulu: profile === 'storage'`. Confirms **Ring Zulu is the storage profile's**, passed only as a hint to optimystic's `createLibp2pNode`; cadre-core does no ring/keyspace/quota work. Matches the corrected README table.
  - `schemas/control.qsql` (schema `CadreControl`) tables cited in STATUS.md (`AuthorityKey`, `ValidationKey`, `Strand`, `CadrePeer`, `FormationInvite`, `FormationUsage`) — accurate.
- **No-overstatement sweep:** searched every `Ring Zulu`/`storage ring`/`keyspace`/`capacity quota`/`Arachnode` mention repo-wide. No doc claims the subsystem is implemented; none says the *transaction* profile is the Ring-Zulu one. Mentions outside the four docs (`reference-app-web/README.md:181` Arachnode-ring-membership metric, `navigator.storage` quota) are observability/browser-storage references — correctly out of scope, not overstating.
- **Cross-reference / anchor / link correctness (verified by hand):**
  - `#node-profiles` anchors (architecture.md callout + README note) resolve to the `## Node Profiles` heading.
  - README's `../../docs/architecture.md#node-profiles` resolves from `packages/cadre-core/` to repo-root `docs/`. Correct.
  - strands.md's `architecture.md` and `../packages/cadre-core/README.md` relative links resolve from `docs/`. Correct.
  - strands.md points at architecture.md's "Enrollment and Bootstrap" — heading exists at `architecture.md:112`.
  - STATUS.md cites `docs/strands.md:6-11` for cadre/strand/cohort definitions — those lines do contain the Terminology block.
  - STATUS.md uses `[~]`, which is defined in the file's legend (`STATUS.md:5-8`).

### What was found

- **No major findings** — no new tickets filed.
- **Minor (left as-is, documented):** pre-existing ring bullets at `architecture.md:109-110` ("Storage-profile nodes participate …") use present tense, but they sit below the new "Designed, not yet implemented" callout (`:87`), which explicitly says to read the table and ring prose below as design reference. They are also consistent with the corrected understanding (Ring Zulu = storage profile). Not introduced by this ticket; reframing them further is unnecessary. No change made.
- **Minor (intentional, acceptable):** in STATUS.md a child item is `[x]` under an unstarted `[ ]` parent ("Definitions …" under "Create a Cadre management spec doc"). This is deliberate and explained inline — the definitions are covered in `strands.md`/`architecture.md` rather than in the suggested-but-absent `docs/cadre.md`. No change made.

### Lint / tests

- **Not applicable — markdown-only diff.** The change touches zero source files. Repo lint/test scripts (`yarn lint`, `yarn test`) run eslint/tsc/vitest over code workspaces unrelated to this diff; there is no markdown/docs linter configured (no `markdownlint`/`remark-lint` dependency or config). Running the full monorepo suite would exercise only unrelated subsystems and is not agent-runnable within the idle window. No code behavior changed, so there is nothing for this ticket's diff to break. No `tickets/.pre-existing-error.md` written (no test was run).

### Disposition

Accepted as-is. Documentation now faithfully reflects the implemented vs. designed boundary of the storage-ring subsystem. Ring Zulu / storage-ring implementation remains tracked by `tickets/backlog/later/5-ring-zulu-storage-rings.md`; the Hibernation bullet (`architecture.md:805`) was correctly left untouched (owned by `hibernation-no-resource-release-and-stub-checkin`).
