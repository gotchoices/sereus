/**
 * An in-memory, synchronous stand-in for rn-leveldb's native `LevelDB` and
 * `LevelDBWriteBatch`, shaped to the interfaces `@optimystic/db-p2p-storage-rn`'s
 * rn-leveldb adapter consumes (`rn-opener.ts`). A Node test can then run the phone's
 * real storage adapter — its key conversion, range positioning and batch commits —
 * with only the native module replaced.
 *
 * What the adapter relies on, matched here: `getBuf` returns `null` for a missing
 * key; keys order by unsigned byte comparison; an iterator reads the snapshot taken
 * when it was created; `seek` lands on the first key ≥ the target; a batch applies
 * its operations in order when written. Databases are named, like rn-leveldb's
 * files: opening a name again returns the data written under it.
 *
 * Not a `*.spec.ts` file, so the vitest glob never runs it as a suite.
 */

import type {
	RNLevelDBIteratorNative,
	RNLevelDBNative,
	RNLevelDBOpenFn,
	RNLevelDBWriteBatchNative,
} from '@optimystic/db-p2p-storage-rn';

type Entry = readonly [key: Uint8Array, value: Uint8Array];

type BatchOp =
	| { type: 'put'; key: Uint8Array; value: Uint8Array }
	| { type: 'delete'; key: Uint8Array };

/** An owned copy of a native-call argument (rn-leveldb accepts both forms). */
function toBytes(input: ArrayBuffer | string): Uint8Array {
	return typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input.slice(0));
}

/** A fresh buffer, so a caller mutating the result cannot reach stored bytes. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		if (a[i] !== b[i]) return a[i]! - b[i]!;
	}
	return a.length - b.length;
}

/** Index of the first entry whose key is ≥ `key`; `entries.length` when there is none. */
function lowerBound(entries: readonly Entry[], key: Uint8Array): number {
	let lo = 0;
	let hi = entries.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (compareBytes(entries[mid]![0], key) < 0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export class FakeWriteBatch implements RNLevelDBWriteBatchNative {
	readonly ops: BatchOp[] = [];

	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void {
		this.ops.push({ type: 'put', key: toBytes(key), value: toBytes(value) });
	}

	delete(key: ArrayBuffer | string): void {
		this.ops.push({ type: 'delete', key: toBytes(key) });
	}

	close(): void {
		// Nothing to release: the operations are plain heap memory.
	}
}

class FakeIterator implements RNLevelDBIteratorNative {
	private index = -1;

	constructor(private readonly snapshot: readonly Entry[]) {}

	valid(): boolean {
		return this.index >= 0 && this.index < this.snapshot.length;
	}

	seek(target: ArrayBuffer | string): RNLevelDBIteratorNative {
		this.index = lowerBound(this.snapshot, toBytes(target));
		return this;
	}

	seekToFirst(): RNLevelDBIteratorNative {
		this.index = 0;
		return this;
	}

	seekLast(): RNLevelDBIteratorNative {
		this.index = this.snapshot.length - 1;
		return this;
	}

	next(): void {
		this.index++;
	}

	prev(): void {
		this.index--;
	}

	keyBuf(): ArrayBuffer {
		return toArrayBuffer(this.current()[0]);
	}

	valueBuf(): ArrayBuffer {
		return toArrayBuffer(this.current()[1]);
	}

	close(): void {
		// Nothing to release: the snapshot is plain heap memory.
	}

	private current(): Entry {
		const entry = this.snapshot[this.index];
		if (!entry) throw new Error('fake rn-leveldb iterator read while not positioned on an entry');
		return entry;
	}
}

export class FakeRNLevelDB implements RNLevelDBNative {
	/** Sorted by key. Replaced entries are new tuples, so an iterator's snapshot never changes. */
	private readonly entries: Entry[] = [];

	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void {
		this.set(toBytes(key), toBytes(value));
	}

	getBuf(key: ArrayBuffer | string): ArrayBuffer | null {
		const bytes = toBytes(key);
		const entry = this.entries[lowerBound(this.entries, bytes)];
		return entry && compareBytes(entry[0], bytes) === 0 ? toArrayBuffer(entry[1]) : null;
	}

	delete(key: ArrayBuffer | string): void {
		this.remove(toBytes(key));
	}

	close(): void {
		// Nothing to release; the data stays reachable through the opener, like a file.
	}

	newIterator(): RNLevelDBIteratorNative {
		return new FakeIterator(this.entries.slice());
	}

	write(batch: RNLevelDBWriteBatchNative): void {
		if (!(batch instanceof FakeWriteBatch)) {
			throw new Error('fake rn-leveldb can only write a FakeWriteBatch');
		}
		for (const op of batch.ops) {
			if (op.type === 'put') this.set(op.key, op.value);
			else this.remove(op.key);
		}
	}

	private set(key: Uint8Array, value: Uint8Array): void {
		const i = lowerBound(this.entries, key);
		const existing = this.entries[i];
		if (existing && compareBytes(existing[0], key) === 0) {
			this.entries[i] = [key, value];
		} else {
			this.entries.splice(i, 0, [key, value]);
		}
	}

	private remove(key: Uint8Array): void {
		const i = lowerBound(this.entries, key);
		const existing = this.entries[i];
		if (existing && compareBytes(existing[0], key) === 0) {
			this.entries.splice(i, 1);
		}
	}
}

/**
 * An `openFn` for `openOptimysticRNDb`, standing in for
 * `(name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists)`.
 * Each call to this factory is a fresh device: names opened through the returned
 * function share data with each other and with nothing else.
 */
export function fakeRNLevelDBOpener(): RNLevelDBOpenFn {
	const byName = new Map<string, FakeRNLevelDB>();
	return (name) => {
		let db = byName.get(name);
		if (!db) {
			db = new FakeRNLevelDB();
			byName.set(name, db);
		}
		return db;
	};
}
