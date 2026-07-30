/**
 * Node-only filesystem helpers shared by the file-backed stores
 * (`key-store-file.ts`, `trusted-owner-store-file.ts`,
 * `bootstrap-peer-store-file.ts`).
 *
 * This module imports `node:fs/promises`, so — like its consumers — it is kept
 * OUT of the package's cross-platform default entry and is not itself an
 * exported subpath; it is only reachable through the Node-only store modules.
 */
import debug from 'debug';
import { mkdir, rm, rename, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DurableSlot } from './node-local-snapshot.js';

const log = debug('sereus:cadre:fs-atomic');

/** Best-effort POSIX permissions (ignored on Windows / unsupported FSes). */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * Percent-encode a string into a filesystem-safe filename component. Beyond
 * `encodeURIComponent` (which already escapes `/`, spaces, and unicode), this
 * also escapes the unreserved characters `encodeURIComponent` leaves intact but
 * that are unsafe in filenames on some platforms (notably `*` on Windows) — and
 * `.`, so a file suffix appended by the caller is the only literal dot, making
 * suffix-stripping unambiguous. Reversed by `decodeURIComponent`. The result
 * contains only `A-Za-z0-9-_` and `%XX`.
 */
export function encodeFileSafeComponent(component: string): string {
	return encodeURIComponent(component).replace(
		/[!'()*~.]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

/** Whether an unknown error is a Node "file/dir not found" (ENOENT). */
export function isNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null
		&& (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Crash-atomic file write: a concurrent reader sees either the complete
 * previous bytes or the complete new bytes, never a torn file. `dir` is created
 * (0700) if absent; the data is written to `tmpPath` (created exclusively,
 * 0600), fsync'd, then atomically renamed onto `finalPath`. A failure at any
 * point removes the temp file and leaves the previous file untouched.
 *
 * `tmpPath` must be a sibling of `finalPath` (same directory) so the rename
 * stays within one filesystem and is therefore atomic, and should carry a
 * random component so concurrent writers (and crash-orphaned leftovers) are
 * collide-free.
 *
 * Durability bar: the temp file is fsync'd before the rename so a power loss
 * cannot surface a file whose bytes never reached the platter, and `dir` is
 * fsync'd afterwards (best-effort — see {@link syncDirBestEffort}) so the
 * rename itself survives a crash. On POSIX `rename(2)` replaces atomically;
 * Node maps to `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` on Windows, which is
 * also atomic — though it can fail with `EPERM`/`EBUSY` if another process
 * holds the destination open. That cross-process case is out of scope for the
 * single-flight in-process callers here; such a failure surfaces to the caller
 * with the previous file left intact.
 */
export async function writeFileAtomically(
	dir: string,
	tmpPath: string,
	finalPath: string,
	data: Uint8Array
): Promise<void> {
	await mkdir(dir, { recursive: true, mode: DIR_MODE });
	// 'wx' creates the temp file exclusively; a name collision (astronomically
	// unlikely given the caller's random component) fails here before we own anything.
	const handle = await open(tmpPath, 'wx', FILE_MODE);
	try {
		try {
			await handle.writeFile(data);
			await handle.sync(); // land bytes on disk before the rename exposes them
		} finally {
			await handle.close().catch(() => {});
		}
		await rename(tmpPath, finalPath);
	} catch (error) {
		// Any failure after creation (write, sync, or rename): drop the temp
		// file so a retry leaves no `.tmp` debris. The destination is only ever
		// swapped by the atomic rename, so the previous bytes stay intact.
		await rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
	await syncDirBestEffort(dir);
}

/**
 * The Node {@link DurableSlot}: one JSON file per party under `dir`, at
 * `<dir>/<name>.<encoded partyId>.json` (0600, atomically replaced on every
 * save), so one directory can hold the same node-local record for several
 * parties without cross-party leakage.
 *
 * This is the whole platform-specific part of the file-backed node-local
 * stores; the load policy, envelope and write chain are cross-platform in
 * `node-local-snapshot.ts`.
 */
export class FileDurableSlot implements DurableSlot {
	/** Filename-safe form of the party id, shared by the record and temp paths. */
	private readonly encodedParty: string;

	constructor(
		private readonly dir: string,
		private readonly name: string,
		partyId: string
	) {
		this.encodedParty = encodeFileSafeComponent(partyId);
	}

	/**
	 * The record's bytes as text. An absent file (ENOENT — including an absent
	 * directory) is `undefined`, a cold start. Every other read failure
	 * (EACCES, EISDIR, EIO, …) THROWS, per {@link DurableSlot.load}: the caller
	 * must not mistake an unreadable file for an empty one and snapshot-write
	 * over it.
	 */
	async load(): Promise<string | undefined> {
		try {
			return (await readFile(this.filePath())).toString('utf8');
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw new Error(`FileDurableSlot: ${this.filePath()} is present but unreadable`, { cause: error });
		}
	}

	async save(text: string): Promise<void> {
		await writeFileAtomically(this.dir, this.tempPath(), this.filePath(), new TextEncoder().encode(text));
	}

	private filePath(): string {
		return join(this.dir, `${this.name}.${this.encodedParty}.json`);
	}

	/** Sibling temp path for the atomic replace (random component: collide-free). */
	private tempPath(): string {
		const unique = randomBytes(6).toString('hex');
		return join(this.dir, `${this.name}.${this.encodedParty}.${unique}.tmp`);
	}
}

/**
 * Best-effort fsync of a directory so a fresh file's directory entry is
 * durable across power loss. Opening a directory for fsync is not portable
 * (unsupported on Windows and some filesystems), and rename atomicity does not
 * depend on it — so a failure here is logged and swallowed, never surfaced.
 */
async function syncDirBestEffort(dir: string): Promise<void> {
	let dirHandle: FileHandle | undefined;
	try {
		dirHandle = await open(dir, 'r');
		await dirHandle.sync();
	} catch (error) {
		log('directory fsync skipped for %s: %o', dir, error);
	} finally {
		await dirHandle?.close().catch(() => {});
	}
}
