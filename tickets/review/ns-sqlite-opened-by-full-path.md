description: On Android the NativeScript app opened its SQLite databases by bare file name, which made the SQLite plugin borrow the current screen to create the file and fail when the node started before any screen existed; it now opens them by full path.
architecture: docs/reference-app-ns.md#storage
files: packages/reference-app-ns/src/ns-db-path.ts (new), packages/reference-app-ns/src/cadre-phone.ts (`openIdentityDb`), packages/reference-app-ns/src/ns-storage.ts (`openStorage`), packages/reference-app-ns/test/stubs/nativescript-core.ts, packages/reference-app-ns/vitest.config.ts (comment only), docs/reference-app-ns.md (§ Storage)
repro: static
----

# SQLite opened by full path on Android

From gotchoices/sereus#45, point 2: a node started at app launch sometimes failed with `Cannot read properties of undefined (reading 'openOrCreateDatabase')`. On Android, `@nativescript-community/sqlite` 3.5.9 (`sqlite.android.js`, `createDb`) opens a name with no `/` through `(foregroundActivity || startActivity).openOrCreateDatabase(...)`. Neither Activity exists yet when the node auto-starts before the first screen. A name containing `/` goes to `SQLiteDatabase.openDatabase(path, …)` instead, which needs no Activity.

## What changed

- **`src/ns-db-path.ts`** (new): `nsDbPath(name)`.
  - On Android it returns `Utils.android.getApplicationContext().getDatabasePath(name).getAbsolutePath()`, after `getParentFile().mkdirs()`.
  - Everywhere else it returns `name` unchanged. iOS was not examined.
  - `getApplicationContext()` goes through `Application.android.getNativeApplication()`, the native Application, not an Activity (checked in `@nativescript/core/utils/android/index.js`).
- **`openIdentityDb`** (`src/cadre-phone.ts`) and **`openStorage`** (`src/ns-storage.ts`) now pass `nsDbPath(name)` to `openOptimysticNSDb`. Both caches are still keyed by the database **name**.
- **`test/stubs/nativescript-core.ts`** now exports `isAndroid = false` and a `Utils` whose `android.getApplicationContext()` throws if anything reaches it. The scope comment says why it grew, and why the real `utils` module can't be used: it ships only `index.android.js` / `index.ios.js`. The specs do not mock `ns-db-path`. They go through it and still receive the plain names they assert on.
- **`docs/reference-app-ns.md` § Storage**: one sentence on opening by full path, and that this is the same file the plugin used for a bare name.

## Why existing installs keep their data

`Context.openOrCreateDatabase(name)`, which the old bare-name branch called, stores the file at `Context.getDatabasePath(name)`. The new path is that same file, so the PeerId and strand data should carry over with no migration. This comes from reading the Android framework, not from a device run.

## Validation run

- `yarn workspace @serfab/reference-app-ns typecheck`: clean.
- `yarn workspace @serfab/reference-app-ns test`: 9 files, 118 tests passed. The first run was refused by the stale-build guard: `@serfab/cadre-core`'s `dist` was out of date with already-committed source (no uncommitted edits there). I rebuilt it with `yarn workspace @serfab/cadre-core build` and the suite passed.
- `yarn workspace @serfab/reference-app-ns test:bundle`: webpack compiled the whole import graph with 0 errors and 0 warnings. This confirms `isAndroid` / `Utils` resolve from the real `@nativescript/core` in the app bundle.
- ESLint on the changed files: clean.

## Tests added

None, as the ticket specified. The changed behaviour is a native Android call that can't run under Node. The existing `cadre-phone.spec.ts` / `ns-storage.spec.ts` run the non-Android path and confirm the cache keys and names are unchanged.

## Known gaps (for the reviewer)

- **Not confirmed on a device.** Three checks are still to run out-of-band:
  - Fresh install: confirms the `databases/` directory gets created and the first open succeeds.
  - Upgrade over an existing install: confirms the same PeerId and strand data are present afterwards.
  - Launch with the node auto-starting from saved start options: confirms the `openOrCreateDatabase` error no longer appears.
- **Ignored `mkdirs()` result.** The return value of `mkdirs()` isn't checked: it returns `false` when the directory already exists, the normal case. If it genuinely fails, `openDatabase` throws its own error on the next line.
- **Different open flags.** The path branch opens with `CREATE_IF_NECESSARY | NO_LOCALIZED_COLLATORS`. The old Activity branch used `MODE_PRIVATE`. The old call also set up the `android_metadata` table and localized collators by default; the new one does neither. Optimystic's schema uses no locale-dependent collation, so I expect no difference, but this is unverified on device.
