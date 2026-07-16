----
description: The cadre-owner concept that code/schema/CLI/docs called "authority" is now called "owner", so it stops colliding with the separate "authority" concept sApps carry in their own data. Review the rename for completeness and for any owner/strand mislabeling.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/ed25519-key.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-host/src/owner/owner-node-client.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, docs/architecture.md, docs/cadre-host.md, docs/STATUS.md
difficulty: medium
----

# Review: rename cadre-owner "authority" → "owner"

## What this was

A repo-wide rename of Sereus's **cadre-owner** concept (the party that owns/controls a cadre — its cluster of nodes) from the word "authority" to "owner", because sApps (e.g. VoteTorrent) carry their own unrelated "authority" concept in strand data and the collision confuses users. No production sApps exist, so the rename is free now.

**Only concept #1 (cadre owner) was renamed.** Two other "authority" concepts were deliberately left:
- **#2 Strand membership RBAC role** (`schemas/strand.qsql` `Authority` table, `quereus-plugin-sereus/src/strand-schema.ts`, `strand-membership-writer.ts`, strand-*.spec.ts) → the follow-up ticket `rename-strand-authority-to-manager` renames this to `manager`. It has a `prereq` on this ticket.
- **#3 Consistency/quorum "Authority layer"** (`docs/cadre-consistency.md`) → genuinely different concept, untouched.
- Generic-English "central authority" in `docs/web/*.html` → untouched.

## Canonical renames that landed

| Old | New |
|---|---|
| `AuthorityKey` (CadreControl table + `context.AuthorityKey`) | `OwnerKey` / `context.OwnerKey` |
| `CadrePeer.VouchAuthority` | `VouchOwner` |
| `SeedPeer.isAuthority` | `isOwner` |
| `--authority` / `--pin-authority-key` / `CADRE_AUTHORITY_KEYS` / `--authority-key` | `--owner` / `--pin-owner-key` / `CADRE_OWNER_KEYS` / `--owner-key` |
| `AuthorityNodeClient` / `AuthorityNodeUnavailableError` / `AuthorityNodeClientOptions` | `OwnerNodeClient` / `OwnerNodeUnavailableError` / `OwnerNodeClientOptions` |
| `AuthorityAdminEndpoint` / `AuthoritySpawnConfig` | `OwnerAdminEndpoint` / `OwnerSpawnConfig` |
| `AUTHORITY_CONTAINER_ID` value `'authority'` | `OWNER_CONTAINER_ID` value `'owner'` |
| `ensure/has/get/insertAuthorityKey`, `getIdentityAuthorityKey`, `knownAuthorityKeys` | `…OwnerKey(s)`, `getIdentityOwnerKey`, `knownOwnerKeys` |
| invite `authorityKeys` / `authorityAddrs`; config `authorityPrivateKey`/`authorityPublicKey` | `ownerKeys` / `ownerAddrs`; `ownerPrivateKey`/`ownerPublicKey` |
| orchestrator `authorityConfig`/`ensure/stop/restartAuthorityNode`/`isAuthorityNode`/`hasAuthorityConfig`/`getAuthorityAdminEndpoint`/`findAuthorityHandle`/`buildAuthorityChildConfig` | `owner`-prefixed |
| admin route `/api/nodes/authority/*`; debug `cadre:host:authority-client` | `/api/nodes/owner/*`; `cadre:host:owner-client` |

**Neutral-crypto rename (done first, as the ticket required):** `authority-key.ts` → `ed25519-key.ts`; `AuthorityKeyPair`→`Ed25519KeyPair`, `authorityKeyFromLibp2p`→`ed25519KeyPairFromLibp2p`, `authorityPublicKeyFromPrivate`→`ed25519PublicKeyFromPrivate`. This file is shared by strand-membership (member keys) code, so it was made **neutral, not owner** — the manager ticket consumes `Ed25519KeyPair` with no owner bleed. Strand code (`strand-member-key.ts`, `strand-membership-writer.ts`, `strand-member-registry.ts`, strand specs) was updated to the new `Ed25519KeyPair` import only; its `Authority`-role symbols are untouched.

## How to validate (what a reviewer should re-run)

All green locally (Windows, yarn):
- **Builds**: `cadre-core`, `cadre-cli`, `cadre-host` (incl. vite UI), `quereus-plugin-sereus` — all build.
- **Typecheck**: cadre-core, cadre-cli, cadre-host, integration-tests, reference-app-web (`typecheck` + `typecheck:e2e` + `check:svelte` → 852 files, 0 errors), reference-app-rn, reference-app-ns — all clean.
- **Lint**: `yarn lint` (`eslint .`) — clean (the fully-enforced gate).
- **Unit tests**:
  - `cadre-core`: 657 passed, 1 skipped (includes `control-schema-drift.spec.ts` byte-equality guard — passes, so the two schema copies stayed in lockstep).
  - `cadre-cli`: 90 passed (incl. `start-pins.spec.ts`, `admin-server.spec.ts`).
  - `cadre-host`: 372 passed, 3 skipped, **2 pre-existing failures** (see below).
  - `reference-app-rn`: 133 passed.

**Highest-value things to scrutinize** (where owner/strand can be mislabeled):
- `packages/cadre-core/test/publish-strand.spec.ts` — **genuinely mixed**: it enrolls an `OwnerKey` (CadreControl, owner) *and* counts the strand-membership `Strand.Authority` table rows in founder bootstrap. The owner side was renamed (`insertOwnerKey`, `startSelfOwnerNode`); the `Strand.Authority` table refs (`countRow(db,'Authority')`, `select … from Strand.Authority`, the `Header=1,Member=1,Authority=1` test titles) were **kept as `Authority`** for the manager ticket. Confirm none of those strand-table reads regressed to `Owner` (a `Strand.Owner` typo would throw "Table not found" — it did during implementation and was fixed).
- `control-authorization-binding.spec.ts` and `control-schema-drift.spec.ts` — the original ticket flagged these as "mixed / half-rename". On inspection they only exercise **`CadreControl.Strand`** (the owner control-plane strand registry) + `OwnerKey`, **not** the strand-membership `Authority` table, so they were **fully** renamed to owner. Verify that reading — if the reviewer disagrees, this is the place to look.
- `docs/architecture.md` — mixed doc. Owner surface (control-table row, `SeedPeer`, seed-trust, key-derivation prose, mermaid `(Owner)` labels, owner-node lifecycle) renamed; the **"Strand RBAC layer" section (~509–553) and the strand-schema paragraph (line 59) were kept on `Authority`**. Confirm the owner/strand seam in that file is clean (no owner word leaked into 509–553; no strand `Authority` leaked into the owner sections).

## Known gaps / not exercised (treat tests as a floor)

- **Integration tests were only typechecked, not run.** Per AGENTS.md the cross-package `integration-tests` suite is real-network e2e and **not agent-runnable**. The renamed scenarios (`cadre-host-owner-node.integration.ts` [file renamed], `push-wake-e2e`, `control-*-convergence`, `enrollment-e2e`, `seed-bootstrap`, `happy-path`, `multi-party-sync`, `deliver-seed-cross-network`, `basic-connectivity`, `strand-formation-e2e`, `strand-creation`, harness `test-party.ts`/`test-network.ts`/`test-cadre-host.ts`) compile against the renamed exports but their **runtime** behavior (spawning `cadre start --owner`, `ensureOwnerNode`, the `/api/nodes/owner/*` route) was not observed live. A CI/human run is the real check.
- **reference-app-web Playwright e2e not run** (needs browser+server). The UI test-ids `diag-authority-keys`→`diag-owner-keys` and `diag-authority`→`diag-owner` were renamed consistently in both `Diagnostics.svelte`/`diagnostics.svelte.ts` (source) and the specs (`formation-rbac.spec.ts`, `diagnostics.spec.ts`); `check:svelte`+`typecheck:e2e` pass, but the label/test-id round-trip wasn't driven in a live browser.
- **reference-app-rn maestro** (`_setup.yaml`) renamed but not run.
- **`cadre-provider`** has no authority references and was not modified; it builds transitively but was not independently exercised.
- **Stateful container-id change is deliberate collateral.** `'authority'`→`'owner'` alters persisted `state-store` JSON keys and the admin route path with **no migration shim** (per AGENTS.md "no backwards compat"). Any dev state dir holding a stale `'authority'` node id is acceptable collateral (no production deployments). No code compares the id against a hardcoded `'authority'` outside `OWNER_CONTAINER_ID` (grepped).

## Pre-existing failures (NOT caused by this ticket)

Both already tracked in `tickets/.pre-existing-known.md`; not re-reported:
- `packages/cadre-host/src/update/__tests__/release-key.test.ts` (2 failing: `isPlaceholderReleaseKey`) → slug `release-key-placeholder-test-stale` (in-flight). `packages/cadre-host/src/update/` was **not** touched by this rename.
- `control-db-two-node-convergence.integration.ts` (blocked) → slug `control-db-convergence-optimystic-p2p`. This ticket **renamed that test's title** ("authority-written" → "owner-written" CadrePeer row); the `.pre-existing-known.md` entry's test-name string was updated to match (slug/status unchanged).

## Tripwires recorded

- No new tripwires. The stateful container-id change is documented above and in-code as `OWNER_CONTAINER_ID = 'owner'` in `host-process-orchestrator.ts` (self-describing); no dormant-path latent defect was introduced.

## Follow-up

- **`rename-strand-authority-to-manager`** (concept #2) is the immediate next ticket and `prereq`s on this one. It renames the strand-membership `Authority` table/role → `manager` across `schemas/strand.qsql`, `quereus-plugin-sereus/src/strand-schema.ts` (byte-equal `STRAND_SCHEMA`), `strand-membership-writer.ts`, the strand-*.spec.ts files, `strand-schema.e2e.spec.ts`, `publish-strand.spec.ts`'s kept `Strand.Authority` refs, and the architecture.md 509–553 section. Those files are the only remaining owner-adjacent "half-rename" — they consume the neutral `Ed25519KeyPair` (done here) but still say `Authority` for the strand role (correct until the manager ticket lands).
