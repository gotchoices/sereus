description: On Android the NativeScript app opens its SQLite databases by bare file name, which makes the SQLite plugin borrow the current screen to create the file and fails when the app starts its node before any screen exists; open them by full path instead.
architecture: docs/reference-app-ns.md#storage
files: packages/reference-app-ns/src/cadre-phone.ts (`openIdentityDb`, ~124-135), packages/reference-app-ns/src/ns-storage.ts (`openStorage`, ~53-63), packages/reference-app-ns/test/stubs/nativescript-core.ts, packages/reference-app-ns/vitest.config.ts, docs/reference-app-ns.md (§ Storage ~60-80)
repro: static
----

# SQLite opened by bare name on Android

Reported on gotchoices/sereus#45 (point 2): a node started at app launch sometimes fails with `Cannot read properties of undefined (reading 'openOrCreateDatabase')`.

## Cause

Both open sites pass a bare database name to `openOptimysticNSDb` (`@optimystic/db-p2p-storage-ns`, `src/ns-opener.ts`), which hands it straight to the plugin's `openOrCreate`:

- `src/cadre-phone.ts` `openIdentityDb`: `openOptimysticNSDb(PEER_IDENTITY_DB_NAME)` (`'sereus-peer-identity'`).
- `src/ns-storage.ts` `openStorage`: `openOptimysticNSDb(dbName)` (`sereus-<strandId>`, `sereus-control-<party>`).

`@nativescript-community/sqlite` 3.5.9 (`sqlite.android.js`, `createDb`) branches on the name:

- contains `/` → `android.database.sqlite.SQLiteDatabase.openDatabase(path, null, CREATE_IF_NECESSARY | NO_LOCALIZED_COLLATORS)`, no Activity needed;
- otherwise → `(Application.android.foregroundActivity || Application.android.startActivity).openOrCreateDatabase(name, MODE_PRIVATE, null)`, which throws the reported error when neither Activity exists yet.

Read from the plugin's source; not reproduced (needs a device, and the timing is intermittent). Confirming it on device means launching with the node auto-starting from saved start options and seeing the error before the first Activity attaches; the fix removes the Activity dependency entirely, so the confirmation is that the error no longer appears.

## Fix

Add one helper, used by both open sites, that turns a database name into the path to open:

- Android: `Utils.android.getApplicationContext().getDatabasePath(name)`, after `getParentFile().mkdirs()`, returning `getAbsolutePath()`. `Context.openOrCreateDatabase(name)` — what the bare-name branch calls — stores the file at exactly `getDatabasePath(name)`, so existing installs keep their identity and strand data with no migration. The `mkdirs()` is needed because `SQLiteDatabase.openDatabase` creates the file but not a missing `databases/` directory, which `Context.openOrCreateDatabase` creates itself; on a fresh install that directory does not exist yet. (Static reasoning from the Android framework; confirm on a fresh install.)
- Elsewhere (iOS): return the name unchanged, keeping today's behaviour. iOS is not part of this report and was not examined.

`openOptimysticNSDb`'s doc comment allows a full path in place of a name (`../optimystic/packages/db-p2p-storage-ns/src/ns-opener.ts`, the comment above the function); the opener is a sibling repo and is not changed.

Keep the caches in both files keyed by the database **name**; only the argument to `openOptimysticNSDb` changes.

Place the helper in its own small module (for example `src/ns-db-path.ts`) importing `isAndroid` and `Utils` from `@nativescript/core`. The unit suite aliases `@nativescript/core` to `test/stubs/nativescript-core.ts`, which today exports only `Observable`/`ObservableArray`; add `isAndroid` (false under Node) and a minimal `Utils` export there, so `cadre-phone.spec.ts` and `ns-storage.spec.ts` keep receiving the plain names they assert on. Update the stub's "scope is deliberately these two modules" comment to say why it widened. Do not mock the new module in the specs.

No new unit test: the behaviour is a native call that cannot run under Node.

## Docs

`docs/reference-app-ns.md` § Storage: one sentence saying that on Android each database is opened by its full path under the app's databases directory, so no Activity is needed to open it, and that this is the same file the plugin used for a bare name.

## TODO

- Add the name → path helper module; use it in `openIdentityDb` (`src/cadre-phone.ts`) and `openStorage` (`src/ns-storage.ts`).
- Extend `test/stubs/nativescript-core.ts` with `isAndroid` and `Utils`, and update its scope comment.
- Run `yarn workspace @serfab/reference-app-ns typecheck`, `test`, and `test:bundle`.
- Update `docs/reference-app-ns.md` § Storage.
- On-device confirmation (fresh install, and an upgrade over an existing install keeping its PeerId) is out-of-band; say so in the review handoff if it was not run.
