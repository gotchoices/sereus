description: The phone app's docs (and one code comment) still said it stores data with MMKV, but MMKV was replaced by LevelDB and is no longer a dependency at all — every stale mention now names the real backend.
files: docs/reference-app-rn.md, docs/architecture.md, packages/reference-app-rn/README.md, packages/cadre-core/src/strand-instance-manager.ts
difficulty: easy
---

# Sweep stale MMKV mentions, replace with LevelDB — implementation summary

Doc/comment-only ticket, no code or behavior change. All sites from the ticket spec fixed:

- `docs/reference-app-rn.md`: architecture diagram box, Node Topology table Storage column, Key Dependencies table (`@optimystic/db-p2p-storage-rn` row reworded; `react-native-mmkv` row replaced with `rn-leveldb` row, same shape), First-Time Setup step 2, "When Native Rebuild Is Needed" paragraph.
- `docs/architecture.md`: `rawStorageFactory` paragraph (~line 505).
- `packages/reference-app-rn/README.md`: chat-storage sentence (~line 73), file-tree comment (~line 299).
- `packages/cadre-core/src/strand-instance-manager.ts`: comment (~line 316).

Left untouched, on purpose: `docs/reference-app-rn.md`'s Peer-identity section sentence about the app's key having lived in "plaintext MMKV, then plaintext LevelDB" — that's a correct historical note about `migrateLegacyIdentity`, not a stale claim. Also left `tickets/complete/2.2-rn-durable-node-local-stores-tests.md` and `tickets/backlog/later/6-first-eas-build.md` alone — archived/backlog tickets are historical record, out of scope per the ticket.

## Verification

- `grep -ril mmkv docs packages/reference-app-rn packages/cadre-core/src` (case-insensitive) now returns only `docs/reference-app-rn.md` (the intentional historical sentence). Confirmed clean.
- No build/test impact — pure text/comment edits. Did not run `yarn lint` or the full test suite; nothing in scope touches lint-checked code paths besides one `.ts` comment, and comment-only changes don't affect TypeScript type-checking or ESLint rules. A pre-existing, unrelated TS diagnostic (`'_protocolPrefix' is declared but its value is never read`, `strand-instance-manager.ts:261`) surfaced during editing — not caused by this change (only a comment above it was touched), not investigated further.

## Suggested review checks

- Confirm the four files render/parse correctly (markdown tables still aligned, diagram box still monospace-aligned).
- Confirm no other MMKV references were missed outside the four files in scope (grep above already covers this).
