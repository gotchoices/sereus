description: On Android the NativeScript app opened its SQLite databases by bare file name, which made the SQLite plugin borrow the current screen to create the file and fail when the node started before any screen existed; it now opens them by full path.
architecture: docs/reference-app-ns.md#storage
files: packages/reference-app-ns/src/ns-db-path.ts, packages/reference-app-ns/src/cadre-phone.ts (`openIdentityDb`), packages/reference-app-ns/src/ns-storage.ts (`openStorage`), packages/reference-app-ns/test/stubs/nativescript-core.ts, packages/reference-app-ns/vitest.config.ts, docs/reference-app-ns.md
repro: static
----

# SQLite opened by full path on Android

From gotchoices/sereus#45, point 2: a node auto-started at app launch could fail with `Cannot read properties of undefined (reading 'openOrCreateDatabase')`. `@nativescript-community/sqlite` 3.5.9 (`sqlite.android.js`, `createDb`) opens a name with no `/` through `(foregroundActivity || startActivity).openOrCreateDatabase(...)`, and neither Activity exists before the first screen. A name containing `/` goes to `SQLiteDatabase.openDatabase(path, …)`, which needs no Activity.

## What landed

- `src/ns-db-path.ts` — `nsDbPath(name)`: on Android, `Utils.android.getApplicationContext().getDatabasePath(name)` with its parent directory created, returned as an absolute path; elsewhere the name unchanged (iOS behaviour is as before, not examined).
- `openIdentityDb` (`src/cadre-phone.ts`) and `openStorage` (`src/ns-storage.ts`) pass `nsDbPath(name)` to `openOptimysticNSDb`; both caches remain keyed by name.
- `test/stubs/nativescript-core.ts` exports `isAndroid = false` and a `Utils` whose `getApplicationContext()` throws if reached.
- `docs/reference-app-ns.md` § Storage states the full-path open.

`Context.openOrCreateDatabase(name)` stores at `Context.getDatabasePath(name)`, so existing installs open the same file with no migration (from reading the framework, not a device run).

## Review findings

Read the diff of `ticket(implement): ns-sqlite-opened-by-full-path` before the handoff.

- **Correctness, checked against the installed plugin and opener.** `openOptimysticNSDb` passes the name straight to `plugin.openOrCreate`, which stores it as `filePath` untouched and hands it to `createDb`; the `/` branch is taken for the absolute path. `getApplicationContext()` in `@nativescript/core/utils/android/index.js` goes through the native Application, not an Activity. No other `openOptimysticNSDb` caller exists in `src/`. No issue found.
- **Edge case: names with a path separator.** `getDatabasePath` throws on a `/` in the name; every scope key is within `[a-z0-9._-]` (documented at `makeLazyNsStorage`), and the identity name is a constant, so it cannot arise. Before this change such a name would also have failed. No action.
- **Error path.** If `nsDbPath` throws, it throws synchronously from `openStorage` / `openIdentityDb` before anything is cached; every caller awaits inside an `async` function, so it arrives as a rejection and the next operation retries, the same as a failed open. No action.
- **Open-flag difference** (`CREATE_IF_NECESSARY | NO_LOCALIZED_COLLATORS` vs the old `MODE_PRIVATE` path, which also created `android_metadata` and set a locale): the optimystic schema has no `collate` clauses (grepped `db-p2p-storage-ns/src`), and opening an existing file that already has `android_metadata` with `NO_LOCALIZED_COLLATORS` only skips the locale step. No action; still unverified on device.
- **Ignored `mkdirs()` result:** `false` is the normal already-exists case and a real failure surfaces from `openDatabase` on the next line. Acceptable as written.
- **Docs.** § Storage was updated by the implementer. The testing section of `docs/reference-app-ns.md` described the `@nativescript/core` stub as re-exporting only `Observable` / `ObservableArray`; added a sentence that it also fixes `isAndroid` at false so the storage and identity suites get plain names. The stub's own scope comment and the `vitest.config.ts` comment are accurate.
- **Tests.** None added and none cut: the changed branch is a native Android call that cannot run under Node, and the existing `cadre-phone.spec.ts` / `ns-storage.spec.ts` already exercise the non-Android path through the real `nsDbPath`, with the throwing `Utils` stub guarding against the Android branch being reached.
- **Source hygiene / DRY / types:** one 27-line module with a single function; no `any`; comments state constraints (why the directory is created, why the path form is used). Nothing to change.
- **Tripwires / new tickets:** none — no conditional concern or major finding surfaced.
- **Validation:** `yarn workspace @serfab/reference-app-ns typecheck` clean; `yarn workspace @serfab/reference-app-ns test` 9 files / 118 tests passed; ESLint on the four changed source files clean. `test:bundle` not rerun (no source change in review; implementer reported 0 errors / 0 warnings).
- **Still outstanding, out-of-band (needs a device):** fresh install (directory created, first open succeeds); upgrade over an existing install (same PeerId and strand data); launch with the node auto-starting from saved start options (no `openOrCreateDatabase` error).
