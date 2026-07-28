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
import { readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { KeyId, KeyStore } from './key-store.js';
import { KeyStoreAccessError } from './key-store.js';
import { encodeFileSafeComponent, isNotFound, writeFileAtomically } from './fs-atomic.js';

const log = debug('sereus:cadre:key-store-file');

/** Suffix appended to the encoded keyId to form a slot filename. */
const SLOT_SUFFIX = '.key';

/**
 * Suffix for the transient file written then atomically renamed over the slot.
 * Distinct from {@link SLOT_SUFFIX}, so {@link FileKeyStore.list} (which matches
 * only `.key`) never surfaces an in-flight or crash-orphaned temp file.
 */
const TEMP_SUFFIX = '.tmp';

/**
 * Percent-encode a keyId into a filesystem-safe filename component (see
 * {@link encodeFileSafeComponent} — `.` is escaped so the `.key` suffix is the
 * only literal dot, making suffix-stripping in {@link decodeKeyId} unambiguous;
 * {@link decodeKeyId} reverses every escape via `decodeURIComponent`).
 */
function encodeKeyId(keyId: KeyId): string {
	return encodeFileSafeComponent(keyId);
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
	 * slot (see {@link writeFileAtomically}). A failure at any point removes the
	 * temp file and leaves the previous slot untouched.
	 */
	async set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void> {
		await writeFileAtomically(this.dir, this.tempPath(keyId), this.slotPath(keyId), keyMaterial);
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
