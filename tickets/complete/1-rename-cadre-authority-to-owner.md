description: Renamed the cadre-owner concept (the party that owns/controls a cadre) from "authority" to "owner" across code, schema, CLI, and docs, so it stops colliding with the unrelated "authority" concept sApps carry in their own data.
files:
  - schemas/control.qsql (AuthorityKey→OwnerKey; 21 refs, byte-aligned with control-schema.ts)
  - packages/cadre-core/src/control-schema.ts (CONTROL_SCHEMA mirror; drift guard green)
  - packages/cadre-core/src/ed25519-key.ts (neutral rename of authority-key.ts; Ed25519KeyPair)
  - packages/cadre-core/src/{cadre-node,control-database,seed-bootstrap,types,index}.ts (OwnerKey surface)
  - packages/cadre-cli/src/commands/{start,enroll}.ts (--owner / --pin-owner-key / CADRE_OWNER_KEYS)
  - packages/cadre-host/src/owner/owner-node-client.ts (was authority/authority-node-client.ts)
  - packages/cadre-host/src/orchestrator/host-process-orchestrator.ts (OWNER_CONTAINER_ID='owner', owner-node lifecycle)
  - packages/cadre-host/src/orchestrator/{types,state-store}.ts (owner/ownerConfig persisted keys)
  - packages/cadre-host/src/server/routes/nodes.ts (/api/nodes/owner/* + isOwnerNode)
  - docs/{architecture,cadre-host,STATUS}.md (owner surface; strand RBAC + trust-anchor slugs left on "authority")
  - packages/cadre-core/src/strand-member-key.ts, strand-formation-protocol.ts (review: 2 stale concept-#1 comments fixed)
difficulty: medium
---

# Complete: rename cadre-owner "authority" → "owner"

Repo-wide rename of the **cadre-owner** concept (the party owning/controlling a cadre — its
cluster of nodes) from "authority" to "owner". Motivated by collision with the separate
"authority" term sApps (e.g. VoteTorrent) carry in strand data. No production sApps, so free now.

Only **concept #1 (cadre owner)** was renamed. Two other "authority" concepts stay:
- **#2 Strand-membership RBAC role** (`schemas/strand.qsql` `Authority` table, `strand-schema.ts`,
  `strand-membership-writer.ts`, strand specs) → next ticket `rename-strand-authority-to-manager`
  (in `implement/`, prereq on this ticket) renames it to `manager`.
- **#3 Consistency/quorum "Authority layer"** (`docs/cadre-consistency.md`) — different concept, untouched.
- Generic-English "central authority" in `docs/web/*.html` — untouched.

The shared crypto helper `authority-key.ts` → `ed25519-key.ts` was made **neutral** (not owner):
`Ed25519KeyPair` / `ed25519KeyPairFromLibp2p` / `ed25519PublicKeyFromPrivate`. Strand membership
code consumes it with no owner bleed.

## Review findings

Adversarial pass over the implement diff (128 files, +2169/−2233). Read the diff before the
handoff. Verdict: **rename is complete and correct; owner/strand seam is clean.** Two stale
comments fixed inline; no tickets spawned; no tripwires.

**Checked — completeness of concept-#1 rename:**
- Grepped `[Aa]uthority` repo-wide. Every remaining hit is concept #2 (strand RBAC), #3
  (consistency doc), a ticket slug, generic English, or a gitignored `dist/` artifact. **No
  concept-#1 leak survives in source, schema, CLI, or owner-side docs.**
- Owner-side core (`cadre-node`, `control-database`, `seed-bootstrap`, `control-schema`,
  `ed25519-key`, `control-cohort`, `peer-authorization`, `seed-trust-policy`, …): 0 authority refs.
- `schemas/control.qsql` and `control-schema.ts`: both 21 `OwnerKey`, 0 `authority`, byte-consistent.
- `cadre-cli`, `cadre-host` src, ops env files, READMEs: 0 concept-#1 authority refs.
- Host orchestrator/state-store/types/route rename verified line-by-line — `OWNER_CONTAINER_ID`,
  `ownerConfig`/`owner` persisted keys, `/api/nodes/owner/*`, `isOwnerNode`, `OwnerNodeClient`,
  `cadre:host:owner-client` all consistent; the `--owner` spawn arg matches the CLI flag.

**Checked — owner/strand seam (where mislabeling would hide):**
- `publish-strand.spec.ts` (genuinely mixed): owner side renamed (`insertOwnerKey`,
  `startSelfOwnerNode`); strand-table reads kept as `Strand.Authority` (`countRow(…,'Authority')`,
  `select … from Strand.Authority`, `Header=1,Member=1,Authority=1` titles). No `Strand.Owner`
  typo — confirmed against test run.
- `control-authorization-binding.spec.ts` / `control-schema-drift.spec.ts`: exercise only
  `CadreControl.*` + `OwnerKey` (owner control-plane), not the strand `Authority` table — correctly
  full-renamed to owner.
- `docs/architecture.md`: owner surface renamed; the Strand-RBAC section (~508–553) and the
  strand-schema paragraph (line 59) correctly kept on `Authority`. Seam has no crossover.
- All strand-membership src (`strand-membership-writer.ts`, `strand-member-registry.ts`,
  `strand-schema.ts`, etc.) correctly retain concept-#2 `Authority` for the manager ticket.

**Found & fixed inline (minor — stale concept-#1 comments the rename missed):**
- `strand-member-key.ts:29` — "seed→public derivation used for node **authority** keys" →
  "node **owner** keys". Comment-only; the derivation is the cadre-owner key path.
- `strand-formation-protocol.ts:177` — "that strand was minted **authority-signed** earlier" →
  "**owner-signed**", matching `architecture.md:485` prose for the same host pre-create act.

**Noted, not actioned (out of this ticket's lane):**
- `docs/STATUS.md` future-work names a `TrustedAuthorityStore` class / `membership-node-local-
  authority-anchor` slug for a **not-yet-built** trust-anchor concept. The surrounding prose already
  says "trusted-**owner** anchor". This is a future ticket's chosen name, not existing concept-#1
  code — left as-is; the owner-vs-anchor naming is that ticket's call when it lands.
- The manager ticket's `files:` header omits `publish-strand.spec.ts`, whose kept `Strand.Authority`
  refs it will need to rename. Downstream ticket's hint list — left for that implementer (grep finds it).

**Tests / lint (re-run, not just trusted):**
- `yarn lint` (eslint, full gate) — clean, exit 0.
- `cadre-core` — 657 passed, 1 skipped (incl. `control-schema-drift` byte-equality guard: green ⇒
  the two schema copies stayed in lockstep).
- `cadre-cli` — 90 passed.
- `cadre-host` — 372 passed, 3 skipped, **2 pre-existing failures** (`release-key.test.ts`
  `isPlaceholderReleaseKey`) — tracked in `.pre-existing-known.md` as `release-key-placeholder-test-stale`
  (in-flight), in `src/update/` which this rename never touched. Not re-reported.

**Not exercised (documented floor, not agent-runnable):**
- `integration-tests` — real-network e2e, not agent-runnable per AGENTS.md. Renamed scenarios
  (incl. renamed `cadre-host-owner-node.integration.ts`) compile against renamed exports but their
  live runtime (`cadre start --owner`, `ensureOwnerNode`, `/api/nodes/owner/*`) was not driven. CI/human run is the real check.
- `reference-app-web` Playwright e2e (needs browser+server) — `check:svelte` + `typecheck:e2e` pass;
  the `diag-owner-keys`/`diag-owner` test-id round-trip was not driven live.
- `reference-app-rn` maestro `_setup.yaml` — renamed, not run.

**Categories with nothing found:** no major findings (no new fix/plan/backlog tickets spawned); no
tripwires (the `'authority'`→`'owner'` container-id change is deliberate stateful collateral, no
migration shim per "no backwards compat", self-describing as `OWNER_CONTAINER_ID` in code — no
dormant-path latent defect); no correctness/type-safety/resource/error-handling defects (pure rename,
no logic change).

## Follow-up

`rename-strand-authority-to-manager` (concept #2) sits in `implement/` with `prereq:
rename-cadre-authority-to-owner`. It renames the strand-membership `Authority` role → `manager`
across the strand schema (both byte-equal copies), writers, strand specs, `publish-strand.spec.ts`'s
kept `Strand.Authority` refs, and `architecture.md` 508–553. Those files consume the neutral
`Ed25519KeyPair` (done here) but correctly still say `Authority` until that ticket lands.
