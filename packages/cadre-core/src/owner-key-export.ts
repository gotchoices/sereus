/**
 * Owner-key export and import: the text (or QR code) a user keeps as a backup of an owner key or
 * carries to another device (`docs/architecture.md` → Owner Keys → Exporting and importing an
 * owner key). Whoever holds a plain export is an owner.
 *
 * - Plain: {@link OWNER_KEY_EXPORT_PREFIX}, then base64url of the canonical JSON
 *   `{ key, label?, v: 1 }`, `key` being the 32-byte Ed25519 seed in base64url.
 * - Locked: {@link LOCKED_OWNER_KEY_EXPORT_PREFIX}, then base64url of the canonical JSON
 *   `{ kdf: { N, name: 'scrypt', p, r, salt }, nonce, sealed, v: 1 }`, `sealed` being the plain
 *   JSON under XChaCha20-Poly1305 with the 32-byte key scrypt derives from the passphrase. The
 *   scrypt parameters ride in the text, so a later default still reads an old export.
 *
 * No error carries key material. `@noble/hashes` and `@noble/ciphers` are pure JS and random
 * bytes come from `crypto.getRandomValues`, so this loads on React Native and in the browser.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { canonicalJson } from './canonical-json.js';
import { CADRE_INVITATION_PREFIX, CADRE_JOIN_REQUEST_PREFIX, OWNER_KEY_EXPORT_STEM } from './cadre-join-request.js';
import { NODE_CLAIM_PAYLOAD_PREFIX } from './node-claim-payload.js';
import { ed25519PublicKeyFromPrivate, requireEd25519PrivateKeyB64 } from './ed25519-key.js';

/** Version 1 of the plain export. */
export const OWNER_KEY_EXPORT_PREFIX = `${OWNER_KEY_EXPORT_STEM}:1.`;

/** Version 1 of the passphrase-locked export. */
export const LOCKED_OWNER_KEY_EXPORT_PREFIX = `${OWNER_KEY_EXPORT_STEM}-locked:1.`;

/** Longest label an owner key carries, the user's name for it ("phone", "paper backup"): in an export and on its `OwnerKey` row (the control schema's `LabelLength` check). */
export const OWNER_KEY_MAX_LABEL = 64;

/**
 * The encoder's scrypt cost: about 140 ms and 64 MiB on Node 24 (x64, measured with
 * `scryptAsync`).
 * NOTE: unmeasured on Hermes; if a device run shows locking or unlocking is slow, lower N for the
 * locked form or move the KDF to native.
 */
const DEFAULT_SCRYPT_COST: ScryptCost = { N: 2 ** 16, r: 8, p: 1 };

/**
 * The most scrypt work the decoder runs, checked before deriving so a hostile file cannot keep a
 * device busy for minutes: N at most 2^20 and r·p at most 8, sixteen times the default's work.
 * At the cap scrypt takes about 2.5 s and 1 GiB on Node 24.
 * NOTE: unmeasured on Hermes; if a device run shows the cap runs for minutes or exhausts memory,
 * lower these two.
 */
const MAX_SCRYPT_N = 2 ** 20;
const MAX_SCRYPT_R_TIMES_P = 8;

/** noble's `maxmem` for {@link MAX_SCRYPT_N}: its default (1 GiB + 1 KiB) is below what the cap itself needs, `128·r·(N + p + 1)` bytes. */
const SCRYPT_MAXMEM = 128 * MAX_SCRYPT_R_TIMES_P * (MAX_SCRYPT_N + MAX_SCRYPT_R_TIMES_P + 1);

const SCRYPT_SALT_BYTES = 16;
const MAX_SCRYPT_SALT_BYTES = 64;
const XCHACHA_NONCE_BYTES = 24;
const POLY1305_TAG_BYTES = 16;
/** A sealed plain export is under 200 bytes; this bounds what a hostile file makes the decoder decrypt. */
const MAX_SEALED_BYTES = 1024;

interface ScryptCost {
	N: number;
	r: number;
	p: number;
}

interface LockedEnvelope extends ScryptCost {
	salt: Uint8Array;
	nonce: Uint8Array;
	sealed: Uint8Array;
}

export type OwnerKeyExportErrorCode =
	/** Owner-key text whose body does not decode, or a version this build does not read. */
	| 'malformed'
	/** The passphrase does not open a locked export, or the locked text was altered. */
	| 'wrong-passphrase'
	/** Not owner-key text; the message names an invitation, join request or join code. */
	| 'not-an-owner-key'
	/** A locked export asks for more scrypt work than {@link MAX_SCRYPT_N} and {@link MAX_SCRYPT_R_TIMES_P} allow. */
	| 'cost-too-high';

/** Every refusal from this module. The message is for the user and never includes key material. */
export class OwnerKeyExportError extends Error {
	readonly code: OwnerKeyExportErrorCode;

	constructor(code: OwnerKeyExportErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'OwnerKeyExportError';
		this.code = code;
	}
}

/** What an export holds once read. */
export interface OwnerKeyExportContents {
	/** The 32-byte Ed25519 seed, base64url: the input to `importOwnerKey`. */
	privateKeyB64: string;
	/** The matching public key, base64url: the `OwnerKey.Key` it signs for. */
	publicKey: string;
	label?: string;
}

/** {@link decodeOwnerKeyExport}'s answer: the key, or word that a passphrase is needed ({@link unlockOwnerKeyExport}). */
export type DecodedOwnerKeyExport = ({ locked: false } & OwnerKeyExportContents) | { locked: true };

export interface OwnerKeyExportInput {
	/** The 32-byte Ed25519 seed, base64url (`readOwnerPrivateKey`). */
	privateKeyB64: string;
	/** Trimmed; at most {@link OWNER_KEY_MAX_LABEL} characters; a blank one is left out. */
	label?: string;
	/** Locks the export when present; must not be empty. */
	passphrase?: string;
}

/**
 * Encode an owner key as text, locked under `passphrase` when one is given.
 *
 * @throws {OwnerKeyExportError} `malformed` for a key that is not a 32-byte seed, an over-long
 *   label or an empty passphrase.
 */
export async function encodeOwnerKeyExport(input: OwnerKeyExportInput): Promise<string> {
	const plainJson = plainExportJson(input.privateKeyB64, input.label);
	if (input.passphrase === undefined) {
		return withPrefix(OWNER_KEY_EXPORT_PREFIX, plainJson);
	}
	return withPrefix(LOCKED_OWNER_KEY_EXPORT_PREFIX, await lockedExportJson(plainJson, input.passphrase));
}

/**
 * Read owner-key text without a passphrase: a plain export's key, or `{ locked: true }` for a
 * locked one whose envelope is well formed and whose scrypt cost is within the cap, so an app
 * refuses a hostile file before asking for the passphrase.
 *
 * @throws {OwnerKeyExportError} `not-an-owner-key` (naming an invitation, join request or join
 *   code), `malformed` or `cost-too-high`.
 */
export function decodeOwnerKeyExport(text: string): DecodedOwnerKeyExport {
	const trimmed = text.trim();
	if (exportPrefix(trimmed) === LOCKED_OWNER_KEY_EXPORT_PREFIX) {
		lockedEnvelope(decodeBody(trimmed, LOCKED_OWNER_KEY_EXPORT_PREFIX));
		return { locked: true };
	}
	return { locked: false, ...exportContents(decodeBody(trimmed, OWNER_KEY_EXPORT_PREFIX)) };
}

/**
 * Read owner-key text with its passphrase. A plain export is read as {@link decodeOwnerKeyExport}
 * reads it, the passphrase unused.
 *
 * @throws {OwnerKeyExportError} as {@link decodeOwnerKeyExport}, and `wrong-passphrase` when the
 *   passphrase does not open it or the sealed part, nonce or scrypt parameters were altered.
 */
export async function unlockOwnerKeyExport(text: string, passphrase: string): Promise<OwnerKeyExportContents> {
	const trimmed = text.trim();
	const prefix = exportPrefix(trimmed);
	if (prefix === OWNER_KEY_EXPORT_PREFIX) {
		return exportContents(decodeBody(trimmed, prefix));
	}
	const envelope = lockedEnvelope(decodeBody(trimmed, prefix));
	const key = await deriveKey(passphrase, envelope, envelope.salt);
	let plain: Uint8Array;
	try {
		plain = xchacha20poly1305(key, envelope.nonce).decrypt(envelope.sealed);
	} catch (error) {
		throw new OwnerKeyExportError('wrong-passphrase', 'The passphrase does not unlock this owner key, or the text was altered', { cause: error });
	}
	return exportContents(parseJsonObject(new TextDecoder().decode(plain)));
}

// ── Encoding ─────────────────────────────────────────────────────────────────

function plainExportJson(privateKeyB64: string, label: string | undefined): string {
	const key = requireKey(privateKeyB64);
	const trimmedLabel = label?.trim();
	return canonicalJson({ key, label: trimmedLabel ? requireLabel(trimmedLabel) : undefined, v: 1 });
}

async function lockedExportJson(plainJson: string, passphrase: string): Promise<string> {
	if (passphrase.length === 0) {
		throw new OwnerKeyExportError('malformed', 'A passphrase must not be empty; leave it out for an unlocked export');
	}
	const salt = randomBytes(SCRYPT_SALT_BYTES);
	const nonce = randomBytes(XCHACHA_NONCE_BYTES);
	const key = await deriveKey(passphrase, DEFAULT_SCRYPT_COST, salt);
	const sealed = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(plainJson));
	return canonicalJson({
		kdf: { ...DEFAULT_SCRYPT_COST, name: 'scrypt', salt: toBase64url(salt) },
		nonce: toBase64url(nonce),
		sealed: toBase64url(sealed),
		v: 1,
	});
}

function withPrefix(prefix: string, json: string): string {
	return `${prefix}${toBase64url(new TextEncoder().encode(json))}`;
}

/** scrypt's async form yields to the event loop every few milliseconds, so a phone's UI keeps drawing while it runs. */
function deriveKey(passphrase: string, cost: ScryptCost, salt: Uint8Array): Promise<Uint8Array> {
	// NFKC, so one passphrase typed on keyboards that compose its characters differently derives one key.
	const password = new TextEncoder().encode(passphrase.normalize('NFKC'));
	return scryptAsync(password, salt, { N: cost.N, r: cost.r, p: cost.p, dkLen: 32, maxmem: SCRYPT_MAXMEM });
}

// ── Decoding ─────────────────────────────────────────────────────────────────

/** Which of the two prefixes `text` starts with; refuses, by name where it can, anything else. */
function exportPrefix(text: string): string {
	if (text.startsWith(LOCKED_OWNER_KEY_EXPORT_PREFIX)) return LOCKED_OWNER_KEY_EXPORT_PREFIX;
	if (text.startsWith(OWNER_KEY_EXPORT_PREFIX)) return OWNER_KEY_EXPORT_PREFIX;
	if (text.startsWith(OWNER_KEY_EXPORT_STEM)) {
		throw new OwnerKeyExportError('malformed', 'This owner key was exported by a newer version of the app; update this app to import it');
	}
	throw new OwnerKeyExportError('not-an-owner-key', notAnOwnerKeyMessage(text));
}

/** No prefix of the text is echoed: whatever was pasted may be a key in some other form. */
function notAnOwnerKeyMessage(text: string): string {
	if (text.startsWith(CADRE_INVITATION_PREFIX)) {
		return 'This is a cadre invitation, not an owner key; paste it where the app asks for an invitation';
	}
	if (text.startsWith(CADRE_JOIN_REQUEST_PREFIX)) {
		return 'This is a join request, not an owner key; paste it into the app that manages your cadre';
	}
	if (text.startsWith(NODE_CLAIM_PAYLOAD_PREFIX)) {
		return 'This is a machine\'s join code, not an owner key; scan it where the app adds a machine';
	}
	return `An owner key must start with "${OWNER_KEY_EXPORT_PREFIX}" or "${LOCKED_OWNER_KEY_EXPORT_PREFIX}"`;
}

function decodeBody(text: string, prefix: string): Record<string, unknown> {
	let json: string;
	try {
		json = new TextDecoder().decode(uint8ArrayFromString(text.slice(prefix.length), 'base64url'));
	} catch (error) {
		throw new OwnerKeyExportError('malformed', 'An owner key export must carry base64url after its prefix', { cause: error });
	}
	return parseJsonObject(json);
}

/** A version-1 JSON object, the shape of both the export body and a locked export's sealed plaintext. */
function parseJsonObject(json: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		// No cause: JSON.parse's message can quote the input, which may hold the key.
		throw new OwnerKeyExportError('malformed', 'An owner key export must carry JSON after its prefix');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new OwnerKeyExportError('malformed', 'An owner key export must decode to a JSON object');
	}
	const record = parsed as Record<string, unknown>;
	if (record.v !== 1) {
		throw new OwnerKeyExportError('malformed', `An owner key export must be version 1 (this one says ${JSON.stringify(record.v)})`);
	}
	return record;
}

function exportContents(record: Record<string, unknown>): OwnerKeyExportContents {
	const { key, label } = record;
	if (typeof key !== 'string') {
		throw new OwnerKeyExportError('malformed', 'An owner key export must carry its key');
	}
	if (label !== undefined && (typeof label !== 'string' || label.trim().length === 0)) {
		throw new OwnerKeyExportError('malformed', 'An owner key export\'s label must be non-empty text');
	}
	const privateKeyB64 = requireKey(key);
	return {
		privateKeyB64,
		publicKey: ed25519PublicKeyFromPrivate(privateKeyB64),
		...(label === undefined ? {} : { label: requireLabel(label.trim()) }),
	};
}

function lockedEnvelope(record: Record<string, unknown>): LockedEnvelope {
	const { kdf, nonce, sealed } = record;
	if (typeof kdf !== 'object' || kdf === null || Array.isArray(kdf)) {
		throw new OwnerKeyExportError('malformed', 'A locked owner key must name its key derivation');
	}
	const { name, N, r, p, salt } = kdf as Record<string, unknown>;
	if (name !== 'scrypt') {
		throw new OwnerKeyExportError('malformed', `A locked owner key must use scrypt (this one names ${JSON.stringify(name)})`);
	}
	const cost = requireScryptCost(N, r, p);
	return {
		...cost,
		salt: requireBytes(salt, 'salt', 1, MAX_SCRYPT_SALT_BYTES),
		nonce: requireBytes(nonce, 'nonce', XCHACHA_NONCE_BYTES, XCHACHA_NONCE_BYTES),
		sealed: requireBytes(sealed, 'sealed key', POLY1305_TAG_BYTES, MAX_SEALED_BYTES),
	};
}

function requireScryptCost(N: unknown, r: unknown, p: unknown): ScryptCost {
	if (!isPositiveInteger(N) || N < 2 || (N & (N - 1)) !== 0 || !isPositiveInteger(r) || !isPositiveInteger(p)) {
		throw new OwnerKeyExportError('malformed', 'A locked owner key\'s scrypt parameters must be positive integers, N a power of two');
	}
	if (N > MAX_SCRYPT_N || r * p > MAX_SCRYPT_R_TIMES_P) {
		throw new OwnerKeyExportError('cost-too-high', `This locked owner key asks for more work to unlock than this app allows (scrypt N ${N}, r ${r}, p ${p})`);
	}
	return { N, r, p };
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function requireBytes(value: unknown, field: string, minBytes: number, maxBytes: number): Uint8Array {
	let bytes: Uint8Array | undefined;
	if (typeof value === 'string') {
		try {
			bytes = uint8ArrayFromString(value, 'base64url');
		} catch (error) {
			throw new OwnerKeyExportError('malformed', `A locked owner key's ${field} must be base64url`, { cause: error });
		}
	}
	if (bytes === undefined || bytes.length < minBytes || bytes.length > maxBytes) {
		throw new OwnerKeyExportError('malformed', `A locked owner key's ${field} must be ${minBytes === maxBytes ? minBytes : `${minBytes} to ${maxBytes}`} bytes of base64url`);
	}
	return bytes;
}

// ── Shared field rules ───────────────────────────────────────────────────────

function requireKey(privateKeyB64: string): string {
	try {
		return requireEd25519PrivateKeyB64(privateKeyB64, 'owner key');
	} catch (error) {
		throw new OwnerKeyExportError('malformed', error instanceof Error ? error.message : 'The owner key must be a 32-byte Ed25519 private key', { cause: error });
	}
}

function requireLabel(label: string): string {
	if (label.length > OWNER_KEY_MAX_LABEL) {
		throw new OwnerKeyExportError('malformed', `An owner key's label must be at most ${OWNER_KEY_MAX_LABEL} characters (this one has ${label.length})`);
	}
	return label;
}

function toBase64url(bytes: Uint8Array): string {
	return uint8ArrayToString(bytes, 'base64url');
}
