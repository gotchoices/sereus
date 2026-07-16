import { describe, it, expect, afterEach } from 'vitest';
import createDebug from 'debug';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as u8ToString } from 'uint8arrays';
import type { PrivateKey } from '@libp2p/interface';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { InMemoryKeyStore, KeyStoreAccessError, DEFAULT_IDENTITY_KEY_ID, type KeyStore } from '../src/key-store.js';
import { FileKeyStore } from '../src/key-store-file.js';
import type { CadreNodeConfig } from '../src/types.js';

function makeConfig(overrides?: Partial<CadreNodeConfig>): CadreNodeConfig {
	return {
		controlNetwork: { partyId: 'identity-test-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
		profile: 'transaction',
		...overrides
	};
}

/** Drive the private identity resolution without a full libp2p bring-up. */
function resolve(node: CadreNode): Promise<void> {
	return (node as unknown as { resolveIdentityKey(): Promise<void> }).resolveIdentityKey();
}

/** Peek at the resolved identity (private field) for assertions. */
function identityOf(node: CadreNode): PrivateKey | undefined {
	return (node as unknown as { identityKey: PrivateKey | undefined }).identityKey;
}

describe('CadreNode identity resolution', () => {
	const tmpDirs: string[] = [];
	afterEach(async () => {
		for (const dir of tmpDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function freshDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'cadre-identity-'));
		tmpDirs.push(dir);
		return dir;
	}

	it('generates + persists an Ed25519 identity to the key store on first run', async () => {
		const store = new InMemoryKeyStore();
		const node = new CadreNode(makeConfig({ keyStore: store }));

		await expect(store.list()).resolves.toEqual([]);
		await resolve(node);

		expect(await store.list()).toEqual([DEFAULT_IDENTITY_KEY_ID]);
		const ik = identityOf(node);
		expect(ik).toBeDefined();
		expect(ik!.type).toBe('Ed25519');
	});

	it('honors a custom identityKeyId slot', async () => {
		const store = new InMemoryKeyStore();
		const node = new CadreNode(makeConfig({ keyStore: store, identityKeyId: 'custom/identity-slot' }));

		await resolve(node);
		expect(await store.list()).toEqual(['custom/identity-slot']);
	});

	it('persisted bytes are the protobuf of the resolved key (canonical stored form)', async () => {
		const store = new InMemoryKeyStore();
		const node = new CadreNode(makeConfig({ keyStore: store }));
		await resolve(node);

		const stored = await store.get(DEFAULT_IDENTITY_KEY_ID);
		expect(stored).toBeDefined();
		expect([...stored!]).toEqual([...privateKeyToProtobuf(identityOf(node)!)]);
	});

	it('reload from the same InMemory store yields an identical PeerId', async () => {
		const store = new InMemoryKeyStore();
		const a = new CadreNode(makeConfig({ keyStore: store }));
		await resolve(a);
		const b = new CadreNode(makeConfig({ keyStore: store }));
		await resolve(b);

		expect(peerIdFromPrivateKey(identityOf(a)!).toString())
			.toBe(peerIdFromPrivateKey(identityOf(b)!).toString());
	});

	it('reload from the same FileKeyStore directory yields an identical PeerId', async () => {
		const dir = await freshDir();
		const a = new CadreNode(makeConfig({ keyStore: new FileKeyStore(dir) }));
		await resolve(a);
		const b = new CadreNode(makeConfig({ keyStore: new FileKeyStore(dir) }));
		await resolve(b);

		expect(peerIdFromPrivateKey(identityOf(a)!).toString())
			.toBe(peerIdFromPrivateKey(identityOf(b)!).toString());
	});

	it('a rejecting get() propagates and does NOT regenerate (no silent identity loss)', async () => {
		const setCalls: string[] = [];
		const store: KeyStore = {
			get: async (id) => { throw new KeyStoreAccessError(id, 'access denied (biometric cancelled)'); },
			set: async (id) => { setCalls.push(id); },
			delete: async () => {},
			list: async () => []
		};
		const node = new CadreNode(makeConfig({ keyStore: store }));

		await expect(resolve(node)).rejects.toBeInstanceOf(KeyStoreAccessError);
		// Critically: no fresh key was generated/persisted over the unreadable one.
		expect(setCalls).toEqual([]);
		expect(identityOf(node)).toBeUndefined();
	});

	it('corrupt/garbage bytes in the slot surface an error rather than regenerating', async () => {
		const store = new InMemoryKeyStore();
		await store.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
		const node = new CadreNode(makeConfig({ keyStore: store }));

		await expect(resolve(node)).rejects.toThrow();
		expect(identityOf(node)).toBeUndefined();
	});

	it('rejects keyStore + privateKey as a configuration error before any network bring-up', async () => {
		const key = await generateKeyPair('Ed25519');
		const node = new CadreNode(makeConfig({ keyStore: new InMemoryKeyStore(), privateKey: key }));

		await expect(node.start()).rejects.toThrow(/mutually exclusive/);
		expect(node.isRunning).toBe(false);
		expect(node.peerId).toBeUndefined();
	});

	it('uses config.privateKey verbatim when no keyStore is set (legacy path)', async () => {
		const key = await generateKeyPair('Ed25519');
		const node = new CadreNode(makeConfig({ privateKey: key }));
		await resolve(node);
		expect(identityOf(node)).toBe(key);
	});

	it('leaves the identity undefined on the ephemeral path (no keyStore, no privateKey)', async () => {
		const node = new CadreNode(makeConfig());
		await resolve(node);
		expect(identityOf(node)).toBeUndefined();
	});

	it('a second resolve neither regenerates nor double-persists', async () => {
		const setCalls: string[] = [];
		const inner = new InMemoryKeyStore();
		const store: KeyStore = {
			get: (id) => inner.get(id),
			set: (id, m) => { setCalls.push(id); return inner.set(id, m); },
			delete: (id) => inner.delete(id),
			list: () => inner.list()
		};
		const node = new CadreNode(makeConfig({ keyStore: store }));

		await resolve(node);
		const first = identityOf(node);
		await resolve(node);

		expect(identityOf(node)).toBe(first);
		expect(setCalls).toEqual([DEFAULT_IDENTITY_KEY_ID]); // persisted exactly once
	});
});

describe('CadreNode.getIdentityOwnerKey', () => {
	it('throws before the identity is resolved (not started)', () => {
		const node = new CadreNode(makeConfig({ keyStore: new InMemoryKeyStore() }));
		expect(() => node.getIdentityOwnerKey()).toThrow(/not resolved/i);
	});

	it('throws on the ephemeral path even after resolve (no exposed owner key)', async () => {
		const node = new CadreNode(makeConfig());
		await resolve(node);
		expect(() => node.getIdentityOwnerKey()).toThrow();
	});

	it('returns the same pair as ed25519KeyPairFromLibp2p(identityKey)', async () => {
		const node = new CadreNode(makeConfig({ keyStore: new InMemoryKeyStore() }));
		await resolve(node);
		expect(node.getIdentityOwnerKey()).toEqual(ed25519KeyPairFromLibp2p(identityOf(node)!));
	});
});

describe('CadreNode identity path: no key-material leak in logs', () => {
	it('never logs the stored protobuf bytes or the owner seed across resolve + sign', async () => {
		const store = new InMemoryKeyStore();
		const node = new CadreNode(makeConfig({ keyStore: store }));

		// Force every cadre namespace on and capture the formatted output. The
		// debug output fn is resolved per-call (self.log || createDebug.log), so
		// reassigning createDebug.log captures module-level loggers created at import.
		const prevNamespaces = createDebug.disable();
		createDebug.enable('sereus:cadre:*');
		const captured: string[] = [];
		const origLog = createDebug.log;
		createDebug.log = function (...args: unknown[]): void {
			captured.push(args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' '));
		};

		try {
			await resolve(node); // generates + persists (logs "generated and persisted")
			const ik = identityOf(node)!;
			// Inject a matching control node so getSelfSigningKey succeeds (the other
			// identity-material path) without a real libp2p bring-up.
			(node as unknown as { controlNode: unknown }).controlNode = { peerId: peerIdFromPrivateKey(ik) };
			const signing = (node as unknown as { getSelfSigningKey(): unknown }).getSelfSigningKey();
			expect(signing).not.toBeNull();
			node.getIdentityOwnerKey();
		} finally {
			createDebug.log = origLog;
			createDebug.enable(prevNamespaces);
		}

		// Sanity: we actually captured the resolve log line(s).
		expect(captured.length).toBeGreaterThan(0);

		const bytes = (await store.get(DEFAULT_IDENTITY_KEY_ID))!;
		const owner = node.getIdentityOwnerKey();
		const secrets = [
			u8ToString(bytes, 'base64'),
			u8ToString(bytes, 'base64url'),
			u8ToString(bytes, 'hex'),
			owner.privateKeyB64
		];

		const blob = captured.join('\n');
		for (const secret of secrets) {
			expect(blob).not.toContain(secret);
		}
	});
});

describe('CadreNode identity persistence (full start round-trip)', () => {
	const tmpDirs: string[] = [];
	afterEach(async () => {
		for (const dir of tmpDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('a FileKeyStore-backed node has a stable PeerId across two full start lifecycles', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cadre-identity-start-'));
		tmpDirs.push(dir);

		const n1 = new CadreNode(makeConfig({ keyStore: new FileKeyStore(dir) }));
		await n1.start();
		const p1 = n1.peerId!.toString();
		await n1.stop();

		const n2 = new CadreNode(makeConfig({ keyStore: new FileKeyStore(dir) }));
		await n2.start();
		const p2 = n2.peerId!.toString();
		await n2.stop();

		expect(p1).toBe(p2);
	}, 60_000);
});

/** Stringify a non-string log arg defensively (covers %o/%O object args). */
function safeString(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
