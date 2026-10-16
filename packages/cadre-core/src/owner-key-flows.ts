/**
 * The owner-key actions an app's owner-key screen offers, built from the owner-key slot
 * (`owner-key-store.ts`), the export text (`owner-key-export.ts`) and `CadreNode.addOwner`: make a
 * backup key and hand it out once, export the device's own key, and import an exported key into
 * the device's owner slot (`docs/architecture.md` → Owner Keys → Exporting and importing an owner
 * key). One copy for the phone kit and the web app.
 *
 * Over `CadreNode`'s public surface only; pure-JS crypto, so it loads on React Native and in the
 * browser.
 */
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { CadreNode } from './cadre-node.js';
import { ed25519KeyPairFromLibp2p, ed25519PublicKeyFromPrivate } from './ed25519-key.js';
import type { KeyStore } from './key-store.js';
import {
	decodeOwnerKeyExport,
	encodeOwnerKeyExport,
	OwnerKeyExportError,
	unlockOwnerKeyExport,
	type OwnerKeyExportContents,
} from './owner-key-export.js';
import { importOwnerKey, readOwnerPrivateKey } from './owner-key-store.js';
import type { OwnerSigner } from './owner-signer.js';

/** How an owner key is exported. */
export interface OwnerKeyExportOptions {
	/** The user's name for the key, carried in the export (and, for a backup key, on its `OwnerKey` row). Trimmed, at most 64 characters, blank meaning none. */
	label?: string;
	/** Locks the export; must not be empty. Absent: a plain export. */
	passphrase?: string;
}

/** An owner key's export and the key it holds: {@link addBackupOwnerKey}'s and {@link exportOwnerKey}'s answer. */
export interface ExportedOwnerKey {
	/** The exported key (base64url); for a backup key, a live `OwnerKey` row now. */
	publicKey: string;
	/** The private key as export text; for a backup key, its only copy, which the app shows or saves once. */
	exportText: string;
}

/** {@link importOwnerKeyInto}'s answer. */
export interface ImportedOwnerKey {
	/** The imported key (base64url), now in the owner slot. */
	publicKey: string;
	/** The node now signs with it: the key is a live owner of the node's party. */
	wired: boolean;
}

/**
 * Make a backup owner key: generate one in memory, seat it as an owner under `label`, signed by
 * this node's owner key (`CadreNode.addOwner`), and return its export. Nothing is kept: whoever
 * holds `exportText` holds the key.
 *
 * @throws {OwnerKeyExportError} `malformed` for an over-long label or an empty passphrase, before
 *   any write.
 * @throws `CadreNode.addOwner`'s errors: `OwnerKeyAddRefusedError` `alone`, or no owner signer wired.
 */
export async function addBackupOwnerKey(node: CadreNode, options: OwnerKeyExportOptions = {}): Promise<ExportedOwnerKey> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(await generateKeyPair('Ed25519'));
	// Encoded before the add, so an export the encoder refuses never seats a key nobody holds.
	const exportText = await encodeOwnerKeyExport({ privateKeyB64, ...exportFields(options) });
	await node.addOwner(publicKeyB64, options.label === undefined ? {} : { label: options.label });
	return { publicKey: publicKeyB64, exportText };
}

/**
 * Export the key in `keyStore`'s owner slot, the device's own owner key. The answer names the key,
 * since it can differ from the one the node signs with: a node signing with the identity key an
 * owner-granting invitation seated keeps signing with it whatever the slot holds (typically the key
 * the device founded its own cadre with, or one imported since).
 *
 * @throws when the slot is empty: a device signing with no key of its own (a member, or one an
 *   owner-granting invitation made an owner through its identity key) has none to export.
 * @throws {OwnerKeyExportError} `malformed` for an over-long label or an empty passphrase.
 */
export async function exportOwnerKey(keyStore: KeyStore, options: OwnerKeyExportOptions = {}): Promise<ExportedOwnerKey> {
	const privateKeyB64 = await readOwnerPrivateKey(keyStore);
	if (privateKeyB64 === undefined) {
		throw new Error('This device holds no owner key of its own to export');
	}
	const exportText = await encodeOwnerKeyExport({ privateKeyB64, ...exportFields(options) });
	return { publicKey: ed25519PublicKeyFromPrivate(privateKeyB64), exportText };
}

/**
 * Import owner-key text into `keyStore`'s owner slot and, given a running node, wire the key when
 * it is a live owner of that node's party. Importing the key the slot already holds changes
 * nothing; a different one is refused.
 *
 * A node that already signs with another key (the identity key an owner-granting invitation
 * seated) keeps it, since a node takes one owner signer; the imported key is stored, `wired` is
 * false, and the next start wires it (the joined-party rule tries the slot's key first).
 *
 * @throws {OwnerKeyExportError} `passphrase-required` for locked text with no passphrase,
 *   `wrong-passphrase`, or the decoder's refusals (`not-an-owner-key` names an invitation, join
 *   request or join code).
 * @throws {OwnerKeySlotOccupiedError} when the slot holds a different key.
 */
export async function importOwnerKeyInto(
	keyStore: KeyStore,
	node: CadreNode | null,
	text: string,
	passphrase?: string,
): Promise<ImportedOwnerKey> {
	const contents = await readOwnerKeyExport(text, passphrase);
	const signer = await importOwnerKey(keyStore, contents.privateKeyB64);
	return { publicKey: signer.publicKey, wired: node !== null && (await wireIfOwner(node, signer)) };
}

async function readOwnerKeyExport(text: string, passphrase: string | undefined): Promise<OwnerKeyExportContents> {
	const decoded = decodeOwnerKeyExport(text);
	if (!decoded.locked) return decoded;
	if (passphrase === undefined) {
		throw new OwnerKeyExportError('passphrase-required', 'This owner key is locked with a passphrase; enter it to import the key');
	}
	return await unlockOwnerKeyExport(text, passphrase);
}

/** `CadreNode.wireOwnKeyIfOwner(signer)`, unless the node already signs with another key, which it keeps. */
async function wireIfOwner(node: CadreNode, signer: OwnerSigner): Promise<boolean> {
	const wired = node.getOwnerSigner();
	if (wired !== null && wired.publicKey !== signer.publicKey) return false;
	return await node.wireOwnKeyIfOwner(signer);
}

function exportFields(options: OwnerKeyExportOptions): { label?: string; passphrase?: string } {
	return {
		...(options.label !== undefined && { label: options.label }),
		...(options.passphrase !== undefined && { passphrase: options.passphrase }),
	};
}
