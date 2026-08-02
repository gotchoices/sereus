description: The phone app's docs (and one code comment) still say it stores data with MMKV, but MMKV was replaced by LevelDB and is no longer a dependency at all — update every stale mention to name the real backend.
files: docs/reference-app-rn.md, docs/architecture.md, packages/reference-app-rn/README.md, packages/cadre-core/src/strand-instance-manager.ts
difficulty: easy
---

# Sweep stale MMKV mentions, replace with LevelDB

Confirmed via `packages/reference-app-rn/package.json`: `react-native-mmkv` is gone,
`rn-leveldb` and `@optimystic/db-p2p-storage-rn` (now LevelDB-backed) are the real
deps. All sites below are plain text/comment edits — no code or behavior change.

## Sites to fix

### `docs/reference-app-rn.md`

- Architecture diagram box (~line 22): `db-p2p-storage-rn (MMKV)` → `db-p2p-storage-rn (LevelDB)`.
- Node Topology table (~line 36): Phone row's Storage column `MMKV (\`db-p2p-storage-rn\`)` → `LevelDB (\`db-p2p-storage-rn\`)`.
- Key Dependencies table (~lines 328-341):
  - `@optimystic/db-p2p-storage-rn` row: `MMKV-backed \`IRawStorage\`` → `LevelDB-backed \`IRawStorage\``.
  - `react-native-mmkv` row: delete (dependency no longer exists). Add a `rn-leveldb` row in its place, same shape as the deleted row (`npm` source, "Native KV store (requires native compilation)" purpose) — it's the native module that now drives the rebuild trigger below.
- Build & Development Workflow:
  - First-Time Setup step 2 (~line 521): "cloud-compiles a dev client with MMKV native module" → "... with `rn-leveldb` native module" (or equivalent phrasing naming `rn-leveldb`).
  - "When Native Rebuild Is Needed" (~line 530-532): "Only when `react-native-mmkv` or another native dependency version changes" → "Only when `rn-leveldb` or another native dependency version changes".
- **Leave alone**: the Node-Local Persistence → Peer identity section's line "An earlier version of the app kept the key in plaintext MMKV, then plaintext LevelDB; `migrateLegacyIdentity` lifts a pre-existing plaintext identity into the enclave..." — this is a correct historical note about a legacy migration, not a stale claim.

### `docs/architecture.md`

- `rawStorageFactory` paragraph (~line 505): "...lands on the host's persistent backend (e.g. file system on Node, MMKV on React Native)..." → "...(e.g. file system on Node, LevelDB on React Native)...".

### `packages/reference-app-rn/README.md`

- ~line 73: "Messages are stored locally in MMKV." → "Messages are stored locally in LevelDB."
- ~line 299 (file tree comment): "CadreNode singleton (WebSocket + MMKV config)" → "CadreNode singleton (WebSocket + LevelDB config)".

### `packages/cadre-core/src/strand-instance-manager.ts`

- Comment ~line 316: "DML lands on the host's persistent storage (e.g. MMKV on RN)." → "(e.g. LevelDB on RN)." — mirrors the `architecture.md` fix at the same conceptual site.

## Verification

- `grep -ril mmkv docs packages/reference-app-rn packages/cadre-core/src` after the edit should return nothing except the intentional historical-migration sentence in `docs/reference-app-rn.md`.
- No code changes, no build/test impact expected — this is a doc/comment-only ticket. Still run `yarn lint` on touched files if convenient (markdown/comment edits shouldn't trip anything), but it isn't the point of this ticket.

## Edge cases & interactions

- Don't touch the legacy-migration sentence in `docs/reference-app-rn.md` — it describes real history (`migrateLegacyIdentity`) and must stay accurate, not be swept away with the rest.
- `tickets/complete/2.2-rn-durable-node-local-stores-tests.md` and `tickets/backlog/later/6-first-eas-build.md` also mention MMKV — out of scope (archived/backlog tickets are historical record, not docs describing current behavior); do not edit them.
