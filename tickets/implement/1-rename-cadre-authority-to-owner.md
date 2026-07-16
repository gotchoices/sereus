----
description: Rename the "authority" term we use for a cadre's owning party to "owner" everywhere, because it collides with the "authority" concept sApps like VoteTorrent use in their own data and confuses users. No production sApps exist yet, so now is the cheapest time.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/authority-key.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-cohort.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/index.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-host/src/authority/, packages/cadre-host/src/orchestrator/, packages/cadre-host/src/bin/host.ts, docs/architecture.md, docs/cadre-host.md, docs/STATUS.md
difficulty: hard
----

# Rename cadre-owner "authority" → "owner"

## Why

"Authority" is Sereus's name for the party that owns and controls a **cadre** (a party's cluster of nodes). That word collides with domain concepts sApps carry in their own databases — the VoteTorrent sApp calls an election administrator an "authority" — so a user looking at their strand data sees "authority" meaning two unrelated things. There are no production sApps yet, so renaming the Sereus concept now is essentially free and permanent later. The owning party is what we informally call the **owner**; make the code, schema, CLI, config, and docs say "owner".

## Scope — three distinct "authority" concepts, only #1 here

1. **Cadre owner** (THIS ticket → `owner`): the party owning a cadre. Lives in the `CadreControl` schema — the `AuthorityKey` table and every `context.AuthorityKey` gate in the control tables, the `VouchAuthority` column on `CadrePeer`, the `isAuthority` peer flag, the "authority node"/"authority peer" (always-on node holding the owner key), the `--authority` CLI flag, seed-trust owner anchors, and the cadre-host authority-node delegation surface.
2. **Strand membership RBAC role** (SEPARATE ticket `rename-strand-authority-to-manager` → `manager`): `schemas/strand.qsql` `Strand.Authority` table and its `context.AuthorityKey`/`AuthoritySignature`. **Do not touch** — that ticket depends on this one.
3. **Consistency/quorum "Authority layer"** (`docs/cadre-consistency.md` — "Authority Model: Asynchronous Right-is-Right", the M-of-N quorum term): a genuinely different concept. **Leave untouched.** If overloading "authority" across the three ever needs a fourth decision, that is a future human call, not this ticket.

Also **leave untouched**: the generic-English "central authority" in `docs/web/*.html` (political/decentralization prose, sApp-facing), and any sApp's own "authority".

## Naming decisions (resolved)

Canonical symbol renames:

| Old | New |
|---|---|
| `AuthorityKey` (CadreControl table) | `OwnerKey` |
| `context.AuthorityKey` (control tables) | `context.OwnerKey` |
| `VouchAuthority` (CadrePeer column) | `VouchOwner` |
| `isAuthority` (SeedPeer flag / peer classification) | `isOwner` |
| `--authority` (CLI flag) | `--owner` |
| `--pin-authority-key` / `CADRE_AUTHORITY_KEYS` | `--pin-owner-key` / `CADRE_OWNER_KEYS` |
| `--authority-key` (enroll) | `--owner-key` |
| `AuthorityNodeClient` / `AuthorityNodeUnavailableError` / `AuthorityNodeClientOptions` | `OwnerNodeClient` / `OwnerNodeUnavailableError` / `OwnerNodeClientOptions` |
| `AuthorityAdminEndpoint` / `AuthoritySpawnConfig` | `OwnerAdminEndpoint` / `OwnerSpawnConfig` |
| `AUTHORITY_CONTAINER_ID` (value `'authority'`) | `OWNER_CONTAINER_ID` (value `'owner'`) |
| `getIdentityAuthorityKey` / `ensureAuthorityKey` / `hasAuthorityKey` / `getAuthorityKeys` / `insertAuthorityKey` | `getIdentityOwnerKey` / `ensureOwnerKey` / `hasOwnerKey` / `getOwnerKeys` / `insertOwnerKey` |
| `knownAuthorityKeys` (SeedTrustContext) | `knownOwnerKeys` |
| invite `authorityKeys` / `authorityAddrs` | `ownerKeys` / `ownerAddrs` |
| config `authorityPrivateKey` / `authorityPublicKey` (SeedBootstrapService) | `ownerPrivateKey` / `ownerPublicKey` |
| orchestrator handles/methods `authority`/`authorityConfig`/`ensureAuthorityNode`/`stopAuthorityNode`/`restartAuthorityNode`/`isAuthorityNode`/`hasAuthorityConfig`/`getAuthorityAdminEndpoint`/`findAuthorityHandle`/`buildAuthorityChildConfig` | `owner`-prefixed equivalents |

**Generic-crypto neutralization (do this FIRST, it is a mechanical prerequisite inside this ticket).** `packages/cadre-core/src/authority-key.ts` is NOT owner-specific — it derives a node's Ed25519 keypair from its libp2p identity and is reused by strand-membership code (member keys) as well as owner genesis. Renaming its type to `OwnerKeyPair` would drag "owner" into manager code. Instead rename it **neutral**:

| Old | New |
|---|---|
| file `authority-key.ts` | `ed25519-key.ts` |
| `AuthorityKeyPair` | `Ed25519KeyPair` |
| `authorityKeyFromLibp2p` | `ed25519KeyPairFromLibp2p` |
| `authorityPublicKeyFromPrivate` | `ed25519PublicKeyFromPrivate` |

Update the file's JSDoc to drop "authority" (it's a generic keypair bridge). Update `index.ts` re-export + path, and **every importer repo-wide** (owner code, strand code, tests, reference apps) — TypeScript build surfaces them all. The manager ticket then consumes `Ed25519KeyPair` with no owner bleed.

**Do NOT rename** the already-neutral `Signature` / `VouchSig` context params (they are generic, not `Authority`-prefixed). **Do NOT touch** `AuthoritySignature` — that identifier only exists in the Strand schema (manager ticket).

**No backwards compat** (per AGENTS.md): change the CLI flags, `CADRE_OWNER_KEYS` env var, and the `'authority'`→`'owner'` container-id value outright — no migration shim, no alias. The container-id value flows into the host orchestrator's persisted `state-store` JSON and the `/api/nodes/authority/*` admin route path; both become `owner`. Dev state dirs holding a stale `'authority'` id are acceptable collateral (no production deployments).

## Change points

Two agents mapped the surface; details below. Treat file:line as a starting index — a whole-word rename plus a build/typecheck pass finds the rest.

### (a) Schema DDL — two byte-identical copies, edit both in lockstep
- `schemas/control.qsql` (canonical) and `packages/cadre-core/src/control-schema.ts` (`CONTROL_SCHEMA` embedded string). `control-schema-drift.spec.ts` enforces byte-equality — any drift fails the test.
- Rename: `table AuthorityKey` → `table OwnerKey`; every `from AuthorityKey A` and `context.AuthorityKey` across all seven tables' `Authorized` checks (`AuthorityKey`, `ValidationKey`, `Strand`, `CadrePeer`, `DeviceToken`, `FormationInvite`, `FormationUsage`); every `with context (AuthorityKey text …)` clause; the `CadrePeer.VouchAuthority` column + its refs in the `AuthorizedInsert`/`AuthorizedUpdate` checks and comments (`new.VouchAuthority = context.AuthorityKey`). Keep SQL reserved words lowercase (human-review rule).

### (b) cadre-core runtime (`packages/cadre-core/src`)
- **Neutral crypto first**: `authority-key.ts` → `ed25519-key.ts` (see table above) + `index.ts` re-export.
- `control-database.ts`: `ControlTableName` union `'AuthorityKey'`→`'OwnerKey'`; methods `hasAuthorityKey`/`ensureAuthorityKey`/`getAuthorityKeys`/`insertAuthorityKey` + their SQL (`from CadreControl.AuthorityKey`, `insert into CadreControl.AuthorityKey`); `queryCadrePeers` field `vouchAuthority`→`vouchOwner` + `select … VouchAuthority` SQL; `with context AuthorityKey = …` in insertStrand/ValidationKey/FormationInvite/genesis; params `authorityKey`→`ownerKey`.
- `seed-bootstrap.ts` (`SeedBootstrapService`): config `authorityPrivateKey`/`authorityPublicKey` fields → `ownerPrivateKey`/`ownerPublicKey`; CadrePeer/DeviceToken SQL `VouchAuthority`/`context AuthorityKey`; `getAuthorityKeys` calls; `isAuthority` filter/set on SeedPeer; `knownAuthorityKeys`; invite `authorityAddrs`/`authorityKeys` + any `dialInviteAuthority`-style method.
- `control-cohort.ts`: `SelectResult.cappedNonAuthority`→`cappedNonOwner`; param/local `authorityKeys`→`ownerKeys`; "authority/backbone node" doc comments.
- `cadre-node.ts`: import from `./ed25519-key.js`; `getIdentityAuthorityKey`→`getIdentityOwnerKey`; `getAuthorityKeys`/`authorityKeys`/`cappedNonAuthority` locals; the `capped %d non-authority sibling(s)` log; genesis error strings mentioning `--authority`/`AuthorityKey`/`ensureAuthorityKey`.
- `types.ts`: `SeedPeer.isAuthority`→`isOwner`; invite type `authorityAddrs`→`ownerAddrs`, `authorityKeys`→`ownerKeys`; doc comments.
- `seed-trust-policy.ts`: `SeedTrustContext.knownAuthorityKeys`→`knownOwnerKeys`; rejection-reason strings ("not a known authority…"); comments referencing `isAuthority`/`AuthorityKey`.
- Comment-only + one real param: `peer-authorization.ts` param `authorityPublicKey`→`ownerPublicKey` (+ comments); `key-store.ts`, `device-token.ts`, `control-formation-recorder.ts` comment wording.

### (c) cadre-cli (`packages/cadre-cli/src`)
- `commands/start.ts`: `--authority` option + help ("Run as the authority node…"); `--pin-authority-key`+`CADRE_AUTHORITY_KEYS`→`--pin-owner-key`+`CADRE_OWNER_KEYS`; `collectPinnedAuthorityKeys`→`collectPinnedOwnerKeys`; `options.authority`/`options.pinAuthorityKey`; `ensureAuthorityKey` call; console strings ("Genesis: inserted founding authority key", "Authority seed-bootstrap initialized", …).
- `commands/enroll.ts`: `--authority-key`→`--owner-key`; `options.authorityKey`→`options.ownerKey`; all help/console strings ("Authority key is required", "the running authority node", `cadre start --authority`).
- `server/health.ts`, `server/admin-server.ts`: comment wording (`CADRE_AUTHORITY_KEYS`, "authority cadre node").

### (d) cadre-host (`packages/cadre-host/src`)
- **Dir/file rename**: `authority/` → `owner/`; `authority/authority-node-client.ts` → `owner/owner-node-client.ts`; keep `owner/index.ts`.
- `owner/owner-node-client.ts`: classes `AuthorityNodeClient`/`AuthorityNodeUnavailableError` + `AuthorityNodeClientOptions`; type `AuthorityAdminEndpoint`; `debug('cadre:host:authority-client')`→`owner-client`; thrown "Authority node…" strings.
- `orchestrator/host-process-orchestrator.ts`: `AUTHORITY_CONTAINER_ID`→`OWNER_CONTAINER_ID` (value `'owner'`); `AuthorityAdminEndpoint`/`AuthoritySpawnConfig`; `authorityConfig`; the `authority?: boolean` handle/opts flag; methods `ensureAuthorityNode`/`findAuthorityHandle`/`getAuthorityAdminEndpoint`/`hasAuthorityConfig`/`isAuthorityNode`/`stopAuthorityNode`/`restartAuthorityNode`/`buildAuthorityChildConfig`; `extraArgs: ['--authority', …]`→`['--owner', …]`.
- `orchestrator/index.ts`, `orchestrator/types.ts`, `orchestrator/state-store.ts`: re-exports + `AuthoritySpawnConfig`/`authority?`/`authorityConfig`.
- `owner/index.ts`, top-level `index.ts`: re-exports of the renamed classes/consts + `./authority/index.js`→`./owner/index.js` paths.
- `bin/host.ts`: import path + `ensureAuthorityNode`/`getAuthorityAdminEndpoint`/`stopAuthorityNode` calls + console strings.
- `auth/trust-circle.ts`, `nat/nat-service.ts`: `instanceof AuthorityNodeUnavailableError`, "Authority node unavailable" strings, `authorityAddrs`, comments.
- `server/routes/nodes.ts`: `isAuthorityNode`/`hasAuthorityConfig`/`ensureAuthorityNode`/`restartAuthorityNode` calls; the `/api/nodes/authority/*` route path literal → `/api/nodes/owner/*`; response strings "authority node…".

### (e) Downstream consumers (build breaks if skipped)
- `packages/integration-tests/src/**` — harness (`test-network.ts`, `test-party.ts`, `types.ts`, `test-cadre-host.ts`) and scenarios (`cadre-host-authority-node.integration.ts` → consider file rename to `…-owner-node…`, `push-wake-e2e`, `control-*-convergence`, `enrollment-e2e`, `seed-bootstrap`, `basic-connectivity`, `deliver-seed-cross-network`, `multi-party-sync`, `happy-path`, `rbac-signed-write`) consume `isAuthority`, invite `authorityKeys`/`authorityAddrs`, `--authority`, `ensureAuthorityNode`, `authorityPublicKey`.
- `packages/reference-app-web` (`cadre-web.ts`, `store.svelte.ts`, `diagnostics.svelte.ts`, `Diagnostics.svelte`, `Activity.svelte`, `Home.svelte`) and `packages/reference-app-rn`/`reference-app-ns` (`cadre-phone.ts`, `use-cadre.ts`, `settings.tsx`, `secure-key-store.ts`) — consume `isAuthority`, `--authority`, owner-genesis calls, and carry `"Verify authority gate"`-style **UI strings** (reference-app-web) → update label + any `test-id`.

### (f) Tests (rename + update)
- File renames: `cadre-core/test/authority-key.spec.ts`→`ed25519-key.spec.ts`; `cadre-host/src/__tests__/orchestrator-authority.test.ts`→`orchestrator-owner.test.ts`; `host-authority.smoke.test.ts`→`host-owner.smoke.test.ts`; `cadre-host/src/authority/__tests__/authority-node-client.test.ts`→`owner/__tests__/owner-node-client.test.ts`.
- Update all cadre-core control/seed/peer/device specs, `cadre-cli/test/start-pins.spec.ts`, and cadre-host tests per the symbol table. **Mixed files** (`control-authorization-binding.spec.ts`, `control-schema-drift.spec.ts`): they exercise both `AuthorityKey` (owner) and Strand `Authority` (manager) — edit **only** the owner/`OwnerKey`/`CadrePeer`/`VouchOwner` lines; leave the Strand `Authority` lines for the manager ticket.

### (g) Docs & config
- `docs/architecture.md`: owner surface throughout — the `AuthorityKey` control-table row, the `isAuthority`/`SeedPeer` prose, the seed-trust section (315–320), the owner-key derivation prose (765–769, 816–828), the mermaid participant labels `(Authority)`→`(Owner)` (197/227/245/284/664), and the authority-node lifecycle/delegation prose (1114–1117). **Leave the strand-RBAC sub-sections (509–553) for the manager ticket** except where they name owner concepts.
- `docs/cadre-host.md`: this file is largely *about* the owner node — rewrite the "authority node" narrative + both topology mermaid diagrams coherently to "owner node"; `AuthoritySpawnConfig`/`AuthorityNodeClient` refs.
- `docs/STATUS.md`, `docs/api.md`, `docs/reference-app-rn.md`, `README.md`, `packages/*/README.md`: owner word-swaps + ascii-diagram `(authority)`→`(owner)` labels + ticket-name refs (mirror landed identifiers, don't invent).
- Config: `ops/docker/sereus-node/{env.example,docker-compose.yml}`, `packages/cadre-cli/docker/{env.example,docker-compose.yml}` — `CADRE_AUTHORITY_KEYS`→`CADRE_OWNER_KEYS`, `--pin-authority-key`→`--pin-owner-key`, `AuthorityKey`/"authority keys" prose. Env-var names MUST match the code.
- **Do not edit** `docs/cadre-consistency.md` (concept #3) or `docs/web/*.html` (generic "central authority").

## Edge cases & interactions

- **Byte-equal schema copies.** `control.qsql` and `control-schema.ts` must stay identical; edit both, run `control-schema-drift.spec.ts`.
- **Neutral-crypto ordering.** Rename `authority-key.ts`→`ed25519-key.ts` and fix all importers *before* the semantic owner renames, so the manager ticket's `prereq` on this ticket yields a clean `Ed25519KeyPair` with no owner bleed.
- **Container-id value change is stateful.** `'authority'`→`'owner'` alters persisted `state-store` JSON keys and the admin route path. Confirm no code compares the id against a hardcoded `'authority'` string outside `OWNER_CONTAINER_ID`. Grep for the literal `'authority'` after renaming symbols.
- **Mixed spec files** (`control-authorization-binding.spec.ts`, `control-schema-drift.spec.ts`): partial edit only — the manager ticket finishes the Strand `Authority` lines. Ensure your partial edit still compiles/passes standalone (the Strand tables are still named `Authority` until the manager ticket lands).
- **`AuthorityKeyPair` importers in strand code** (`strand-member-key.ts`, `strand-membership-writer.ts`, `strand-member-registry.ts`, strand tests): they import the shared type — update the import to `Ed25519KeyPair` here (mechanical), even though their `Authority`-role renames belong to the manager ticket.
- **User-facing strings**: CLI help, `console.log`/`debug` lines, reference-app-web UI labels/test-ids, and error messages all carry "authority" — update text, not just identifiers.
- **Distinct concept guard**: do not let a global find/replace touch `docs/cadre-consistency.md`, `docs/web/*.html`, `AuthoritySignature`, or Strand `Authority` — scope the replace to owner sites.

## TODO

### Phase 1 — Neutral crypto helper
- Rename `authority-key.ts`→`ed25519-key.ts`; `AuthorityKeyPair`→`Ed25519KeyPair`, `authorityKeyFromLibp2p`→`ed25519KeyPairFromLibp2p`, `authorityPublicKeyFromPrivate`→`ed25519PublicKeyFromPrivate`; scrub owner language from its JSDoc.
- Update `index.ts` re-export + path and every importer repo-wide (build to find them). Rename `authority-key.spec.ts`→`ed25519-key.spec.ts`.

### Phase 2 — Schema
- Rename `AuthorityKey` table→`OwnerKey`, all `context.AuthorityKey`→`context.OwnerKey`, `CadrePeer.VouchAuthority`→`VouchOwner` in `control.qsql` AND `control-schema.ts` (byte-equal). Run `control-schema-drift.spec.ts`.

### Phase 3 — cadre-core runtime
- `control-database.ts`, `seed-bootstrap.ts`, `control-cohort.ts`, `cadre-node.ts`, `types.ts`, `seed-trust-policy.ts`, `peer-authorization.ts` per (b). Update owner-side specs (partial edits on mixed files).

### Phase 4 — cadre-cli
- `commands/start.ts`, `commands/enroll.ts`, server comments; flags/env/help/console strings. Update `start-pins.spec.ts`.

### Phase 5 — cadre-host
- Rename `authority/`→`owner/` dir + client file; orchestrator + routes + bin + auth/nat + index re-exports; container-id value + route path. Rename the three host test files; update host tests.

### Phase 6 — Downstream + docs + config
- Fix `integration-tests`, `reference-app-web`, `reference-app-rn`/`ns` consumers + UI strings. Rewrite owner docs/diagrams; update `README`s and docker env/compose. Leave concept #2 (strand) and #3 (consistency) untouched.

### Phase 7 — Validate
- `yarn lint` (fully-enforced gate), `yarn build`/typecheck across affected packages, and the touched unit/integration suites. Grep the repo for residual owner-sense `authority`/`Authority`/`AUTHORITY` and confirm each remaining hit is concept #2 (strand, handled next), concept #3 (consistency doc), or generic-English/sApp. Hand off to review noting: manager ticket is the immediate follow-up (`prereq` on this), and the mixed spec files are only half-renamed until it lands.
