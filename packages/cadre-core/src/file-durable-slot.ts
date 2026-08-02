/**
 * Node-only {@link DurableSlot} backend: one JSON file per party under `dir`,
 * at `<dir>/<name>.<encoded partyId>.json` (0600, atomically replaced on every
 * save), so one directory can hold the same node-local record for several
 * parties without cross-party leakage.
 *
 * This is the whole platform-specific part of the file-backed node-local
 * stores (`trusted-owner-store-file.ts`, `bootstrap-peer-store-file.ts`); the
 * load policy, envelope and write chain are cross-platform in
 * `node-local-snapshot.ts`. Like its two importers, this module imports
 * `node:fs/promises`, so it is kept OUT of the package's cross-platform
 * default entry and is not itself an exported subpath.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encodeFileSafeComponent, isNotFound, writeFileAtomically } from './fs-atomic.js';
import type { DurableSlot } from './node-local-snapshot.js';

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
