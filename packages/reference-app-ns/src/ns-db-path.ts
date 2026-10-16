/**
 * ns-db-path.ts — what to pass `openOptimysticNSDb` for a database name.
 *
 * On Android, `@nativescript-community/sqlite` opens a name containing no `/` through
 * `Activity.openOrCreateDatabase`, borrowing the foreground (or start) Activity, and
 * throws when neither exists yet — as when the node auto-starts at launch. A name
 * containing `/` is opened as a path by `SQLiteDatabase.openDatabase`, which needs no
 * Activity.
 */

import { isAndroid, Utils } from '@nativescript/core';

/**
 * Android: the absolute path of `name` under the app's databases directory. It is
 * `Context.getDatabasePath(name)`, the same file `openOrCreateDatabase(name)` uses, so a
 * database an earlier build opened by bare name is found where it was. The directory is
 * created first because `SQLiteDatabase.openDatabase` creates the file but not a missing
 * `databases/` directory, and a fresh install has none yet.
 *
 * Elsewhere: `name` unchanged.
 */
export function nsDbPath(name: string): string {
	if (!isAndroid) return name;
	const file = Utils.android.getApplicationContext().getDatabasePath(name);
	file.getParentFile().mkdirs();
	return file.getAbsolutePath();
}
