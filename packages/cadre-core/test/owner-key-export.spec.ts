import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { ed25519KeyPairFromLibp2p, type Ed25519KeyPair } from '../src/ed25519-key.js';
import { CADRE_INVITATION_PREFIX, encodeCadreJoinRequest } from '../src/cadre-join-request.js';
import {
	decodeOwnerKeyExport,
	encodeOwnerKeyExport,
	unlockOwnerKeyExport,
	LOCKED_OWNER_KEY_EXPORT_PREFIX,
	OwnerKeyExportError,
	type OwnerKeyExportErrorCode,
} from '../src/owner-key-export.js';

async function freshKey(): Promise<Ed25519KeyPair> {
	return ed25519KeyPairFromLibp2p(await generateKeyPair('Ed25519'));
}

/** Resolves to the refusal's code, failing the test when `run` does not throw an {@link OwnerKeyExportError}. */
async function refusalCode(run: () => unknown): Promise<OwnerKeyExportErrorCode> {
	try {
		await run();
	} catch (error) {
		if (error instanceof OwnerKeyExportError) return error.code;
		throw error;
	}
	throw new Error('expected an OwnerKeyExportError');
}

/** A locked export with its envelope edited, as an altered or hostile file would arrive. */
function editLocked(text: string, edit: (envelope: { kdf: Record<string, unknown>; nonce: string; sealed: string }) => void): string {
	const envelope = JSON.parse(new TextDecoder().decode(uint8ArrayFromString(text.slice(LOCKED_OWNER_KEY_EXPORT_PREFIX.length), 'base64url')));
	edit(envelope);
	return LOCKED_OWNER_KEY_EXPORT_PREFIX + uint8ArrayToString(new TextEncoder().encode(JSON.stringify(envelope)), 'base64url');
}

/** Flip the low bit of a base64url field's first byte. */
function flipped(b64: string): string {
	const bytes = uint8ArrayFromString(b64, 'base64url');
	bytes[0] ^= 1;
	return uint8ArrayToString(bytes, 'base64url');
}

describe('owner-key export', () => {
	it('round-trips a plain export with its label, and refuses an over-long label', async () => {
		const key = await freshKey();
		const text = await encodeOwnerKeyExport({ privateKeyB64: key.privateKeyB64, label: ' paper backup ' });
		expect(decodeOwnerKeyExport(`\n${text} `)).toEqual({ locked: false, privateKeyB64: key.privateKeyB64, publicKey: key.publicKeyB64, label: 'paper backup' });
		expect(await refusalCode(() => encodeOwnerKeyExport({ privateKeyB64: key.privateKeyB64, label: 'x'.repeat(65) }))).toBe('malformed');
	});

	it('locks under a passphrase, refusing a wrong passphrase, an altered text, and an over-cost one before running scrypt', async () => {
		const key = await freshKey();
		const text = await encodeOwnerKeyExport({ privateKeyB64: key.privateKeyB64, label: 'phone', passphrase: 'correct horse' });
		expect(decodeOwnerKeyExport(text)).toEqual({ locked: true });
		expect(await unlockOwnerKeyExport(text, 'correct horse')).toEqual({ privateKeyB64: key.privateKeyB64, publicKey: key.publicKeyB64, label: 'phone' });

		expect(await refusalCode(() => unlockOwnerKeyExport(text, 'wrong horse'))).toBe('wrong-passphrase');
		expect(await refusalCode(() => unlockOwnerKeyExport(editLocked(text, (e) => { e.sealed = flipped(e.sealed); }), 'correct horse'))).toBe('wrong-passphrase');
		expect(await refusalCode(() => unlockOwnerKeyExport(editLocked(text, (e) => { e.nonce = flipped(e.nonce); }), 'correct horse'))).toBe('wrong-passphrase');

		// Had scrypt run, N = 2^21 would have hit noble's memory limit (a plain Error) and r·p = 16 would have run to a wrong-passphrase.
		const hugeN = editLocked(text, (e) => { e.kdf.N = 2 ** 21; });
		const hugeRp = editLocked(text, (e) => { e.kdf.p = 2; });
		expect(await refusalCode(() => decodeOwnerKeyExport(hugeN))).toBe('cost-too-high');
		expect(await refusalCode(() => unlockOwnerKeyExport(hugeN, 'correct horse'))).toBe('cost-too-high');
		expect(await refusalCode(() => unlockOwnerKeyExport(hugeRp, 'correct horse'))).toBe('cost-too-high');
	});

	it('refuses an invitation or a join request by name', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		expect(() => decodeOwnerKeyExport(`${CADRE_INVITATION_PREFIX}e30`)).toThrow(/cadre invitation, not an owner key/);
		expect(() => decodeOwnerKeyExport(encodeCadreJoinRequest({ v: 1, peerId, appName: 'Chat' }))).toThrow(/join request, not an owner key/);
	});
});
