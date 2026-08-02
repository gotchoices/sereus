description: The phone app's docs (and one code comment) said it stores data with MMKV, but MMKV was replaced by LevelDB and is no longer a dependency — every stale mention now names the real backend.
files: docs/reference-app-rn.md, docs/architecture.md, packages/reference-app-rn/README.md, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts
difficulty: easy
---

# Sweep stale MMKV mentions, replace with LevelDB — complete

Doc/comment-only ticket, no behavior change.

## What landed

Implement stage (commit `c62ab80`) fixed every site the plan named:

- `docs/reference-app-rn.md`: architecture diagram box, Node Topology table Storage column, Key Dependencies table (`@optimystic/db-p2p-storage-rn` row reworded, `react-native-mmkv` row replaced with `rn-leveldb`), First-Time Setup step 2, "When Native Rebuild Is Needed".
- `docs/architecture.md`: `rawStorageFactory` paragraph.
- `packages/reference-app-rn/README.md`: chat-storage sentence, file-tree comment.
- `packages/cadre-core/src/strand-instance-manager.ts`: comment.

Deliberately left alone (correct as-is): the peer-identity sentence in `docs/reference-app-rn.md`
about the key having lived in "plaintext MMKV, then plaintext LevelDB" — a true historical note
about `migrateLegacyIdentity`; and the MMKV mentions in archived/backlog tickets.

Review stage added three fixes (below).

## Review findings

**Checked:** the full implement diff read cold before the handoff summary; ASCII-diagram column
alignment; every remaining MMKV mention in tracked files (`git grep -iln mmkv`); every doc that
names the React Native storage backend or the `@optimystic/db-p2p-storage-rn` package, whether or
not the implement stage touched it (`docs/architecture.md`, `docs/STATUS.md`, `docs/strands.md`,
`docs/reference-app-ns.md`, `docs/reference-app-rn.md`, both RN app READMEs, `cadre-core/src`);
the real exports of `@optimystic/db-p2p-storage-rn` and the app's actual usage in
`packages/reference-app-rn/src/cadre-phone.ts`; `packages/reference-app-rn/package.json` dependency
list; `yarn lint`; `cadre-core` build and full test suite.

**Fixed inline (minor):**

- `docs/reference-app-rn.md:22` — the diagram edit widened the phone box's content by three
  characters without moving its right border, so `│  db-p2p-storage-rn (LevelDB)│` bled past the
  frame and the middle column was narrowed to compensate. Dropped the parenthetical instead of
  widening twelve diagram lines: the right-hand box already reads plain `db-p2p-storage-fs`, and
  the Node Topology table directly below still states the backend. All box lines now measure equal.
- `docs/architecture.md` React Native config sample and `packages/cadre-core/src/types.ts`
  `storage.provider` JSDoc both imported a class named `RNRawStorage` taking a strand id. That
  class does not exist — it was the MMKV-era name. The package exports `LevelDBRawStorage`, whose
  constructor takes an open LevelDB handle. Both snippets now match what `cadre-phone.ts` actually
  does (`openOptimysticRNDb` over `rn-leveldb`, then `new LevelDBRawStorage(db)`). Same stale-name
  debt as the ticket, at sites the plan missed.

**New tickets filed:** none. Everything found was a one-line doc correction resolvable in this pass.

**Tripwires:** none. No conditional/"only matters if X later" concerns surfaced — this change has
no runtime surface to grow into one.

**Handoff claims re-verified:**

- "grep returns only the intentional historical sentence" — true for tracked files. The implement
  stage's raw `grep -ril` would also have hit gitignored build artifacts
  (`packages/cadre-core/dist/`, `reference-app-rn/android/app/.cxx/` CMake caches naming the
  still-installed `react-native-mmkv` node_modules copy, an NS bundle). All build output, none
  tracked, none actionable. `scripts/smoke-shots/05-settings.png` also byte-matches; it is a
  screenshot, out of scope.
- The `_protocolPrefix` unused-variable note at `strand-instance-manager.ts:261` is real dead code
  but pre-existing, underscore-prefixed per the repo convention, and lint-clean. Untouched.

**Validation:** `yarn lint` exit 0. `yarn workspace @serfab/cadre-core build` exit 0. `cadre-core`
test suite: 83/85 files, 1370 passed, **5 failed** — exactly the two files and five tests already
listed in `tickets/.pre-existing-known.md` under the blocked ticket
`10-revocation-reissue-same-pk-update-unique-collision`
(`control-revocation-reissue.spec.ts` ×4, `control-revocation-replay.spec.ts` ×1, same
`context.OwnerKey isn't a column` fingerprint). Known and tracked, not re-triaged, nothing skipped
or loosened. No `.pre-existing-error.md` written.
