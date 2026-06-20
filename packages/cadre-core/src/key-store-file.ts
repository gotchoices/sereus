/**
 * Node-only file-backed {@link KeyStore}: one file per slot under a configured
 * directory, holding the raw key material bytes.
 *
 * This module imports `node:fs/promises`, `node:path`, and `node:crypto`, so it
 * is deliberately kept OUT of the package's cross-platform default entry
 * (`./index.js`). Import it from the dedicated subpath instead:
 *
 * ```ts
 * import { FileKeyStore } from '@serfab/cadre-core/key-store-file';
 * ```
 *
 * A React Native / browser entry graph never resolves this path, so the
 * `node:fs` edge never reaches a bundler that cannot satisfy it.
 */
import debug from 'debug';
import { mkdir, readFile, rm, readdir, rename, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { KeyId, KeyStore } from './key-store.js';
import { KeyStoreAccessError } from './key-store.js';

const log = debug('sereus:cadre:key-store-file');

/** Suffix appended to the encoded keyId to form a slot filename. */
const SLOT_SUFFIX = '.key';

/**
 * Suffix for the transient file written then atomically renamed over the slot.
 * Distinct from {@link SLOT_SUFFIX}, so {@link FileKeyStore.list} (which matches
 * only `.key`) never surfaces an in-flight or crash-orphaned temp file.
 */
const TEMP_SUFFIX = '.tmp';

/** Best-effort POSIX permissions (ignored on Windows / unsupported FSes). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Percent-encode a keyId into a filesystem-safe filename component. Beyond
 * `encodeURIComponent` (which already escapes `/`, spaces, and unicode), this
 * also escapes the unreserved characters `encodeURIComponent` leaves intact but
 * that are unsafe in filenames on some platforms (notably `*` on Windows) — and
 * `.` so the `.key` suffix is the only literal dot, making suffix-stripping in
 * {@link decodeKeyId} unambiguous. {@link decodeKeyId} reverses every escape via
 * `decodeURIComponent`. The result contains only `A-Za-z0-9-_` and `%XX`.
 */
function encodeKeyId(keyId: KeyId): string {
	return encodeURIComponent(keyId).replace(
		/[!'()*~.]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

/**
 * Reverse {@link encodeKeyId}: strip the slot suffix and percent-decode. Returns
 * `undefined` for a `.key` filename this store did not write (a foreign file
 * with an invalid percent-sequence), so {@link FileKeyStore.list} can skip it
 * rather than letting one undecodable entry throw and break enumeration of every
 * real slot.
 */
function decodeKeyId(fileName: string): KeyId | undefined {
	const encoded = fileName.slice(0, -SLOT_SUFFIX.length);
	try {
		return decodeURIComponent(encoded);
	} catch (error) {
		log('FileKeyStore: skipping undecodable slot filename %s: %o', fileName, error);
		return undefined;
	}
}

/** Whether an unknown error is a Node "file/dir not found" (ENOENT). */
function isNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null
		&& (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * File-backed {@link KeyStore}. Each slot is `<dir>/<encoded keyId>.key`
 * containing the raw material bytes. The directory is created lazily on first
 * {@link set}. Suitable for headless Node cadre nodes and tests; for mobile use
 * a platform secure-enclave backend instead.
 */
export class FileKeyStore implements KeyStore {
	constructor(private readonly dir: string) {}

	private slotPath(keyId: KeyId): string {
		return join(this.dir, `${encodeKeyId(keyId)}${SLOT_SUFFIX}`);
	}

	/**
	 * Sibling path for the temp file written before the atomic rename. The random
	 * component makes concurrent {@link set}s to the same slot (and crash-orphaned
	 * leftovers) collide-free; it lives in the same directory as the slot so the
	 * final {@link rename} stays within one filesystem and is therefore atomic.
	 */
	private tempPath(keyId: KeyId): string {
		const unique = randomBytes(6).toString('hex');
		return join(this.dir, `${encodeKeyId(keyId)}.${unique}${TEMP_SUFFIX}`);
	}

	async get(keyId: KeyId): Promise<Uint8Array | undefined> {
		try {
			const buf = await readFile(this.slotPath(keyId));
			// Copy into a plain Uint8Array decoupled from Node's Buffer pool.
			return new Uint8Array(buf);
		} catch (error) {
			// A missing slot is "empty" (undefined), NOT an error — so a
			// load-or-create caller generates a key rather than mistaking a
			// permission failure for absence. Any other failure (e.g. EACCES) is
			// surfaced as access-denied so callers do not clobber an existing key.
			if (isNotFound(error)) return undefined;
			throw new KeyStoreAccessError(keyId, `FileKeyStore: failed to read key slot ${keyId}`, { cause: error });
		}
	}

	/**
	 * Crash-atomic write: a concurrent reader sees either the complete previous
	 * bytes or the complete new bytes, never a torn slot. The new material is
	 * written to a sibling temp file, fsync'd, then atomically renamed over the
	 * slot. A failure at any point removes the temp file and leaves the previous
	 * slot untouched.
	 */
	async set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
		await this.writeSlotAtomically(this.tempPath(keyId), this.slotPath(keyId), keyMaterial);
	}

	/**
	 * Write material to `tmpPath`, durably land it, then atomically swap it onto
	 * `finalPath`.
	 *
	 * Durability bar: the temp file is fsync'd before the rename so a power loss
	 * cannot surface a slot whose bytes never reached the platter, and the slot
	 * directory is fsync'd afterwards (best-effort — see {@link syncDir}) so the
	 * rename itself survives a crash. On POSIX `rename(2)` replaces atomically;
	 * Node maps to `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` on Windows, which is
	 * also atomic — though it can fail with `EPERM`/`EBUSY` if another process
	 * holds the destination open. That cross-process case is out of scope here
	 * (the in-process identity path is single-flight); such a failure surfaces
	 * to the caller with the previous slot left intact.
	 */
	private async writeSlotAtomically(tmpPath: string, finalPath: string, keyMaterial: Uint8Array): Promise<void> {
		// 'wx' creates the temp file exclusively; a name collision (astronomically
		// unlikely given the random component) fails here before we own anything.
		const handle = await open(tmpPath, 'wx', FILE_MODE);
		try {
			try {
				await handle.writeFile(keyMaterial);
				await handle.sync(); // land bytes on disk before the rename exposes them
			} finally {
				await handle.close().catch(() => {});
			}
			await rename(tmpPath, finalPath);
		} catch (error) {
			// Any failure after creation (write, sync, or rename): drop the temp
			// file so a retry leaves no `.tmp` debris. The slot is only ever
			// swapped by the atomic rename, so the previous bytes stay intact.
			await rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
		await this.syncDir();
	}

	/**
	 * Best-effort fsync of the slot directory so a fresh slot's directory entry is
	 * durable across power loss. Opening a directory for fsync is not portable
	 * (unsupported on Windows and some filesystems), and rename atomicity does not
	 * depend on it — so a failure here is logged and swallowed, never surfaced.
	 */
	private async syncDir(): Promise<void> {
		let dirHandle: FileHandle | undefined;
		try {
			dirHandle = await open(this.dir, 'r');
			await dirHandle.sync();
		} catch (error) {
			log('FileKeyStore: directory fsync skipped for %s: %o', this.dir, error);
		} finally {
			await dirHandle?.close().catch(() => {});
		}
	}

	async delete(keyId: KeyId): Promise<void> {
		// force:true makes removing an absent slot a no-op (idempotent).
		await rm(this.slotPath(keyId), { force: true });
	}

	async list(): Promise<KeyId[]> {
		let entries: string[];
		try {
			entries = await readdir(this.dir);
		} catch (error) {
			// An absent directory means no slots yet — not a failure.
			if (isNotFound(error)) return [];
			throw new Error('FileKeyStore: failed to list key directory', { cause: error });
		}
		return entries
			.filter((name) => name.endsWith(SLOT_SUFFIX))
			.map(decodeKeyId)
			.filter((id): id is KeyId => id !== undefined);
	}
}
