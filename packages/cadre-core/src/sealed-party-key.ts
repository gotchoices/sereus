/**
 * The pending party key, sealed to the machines that remain: how `PendingStrandPartyKey.SealedKey`
 * carries the key a party moves to after a machine removal (`docs/cadre/membership.md` → "Removing a
 * machine"). The row is written in the same control transaction as the removed machine's
 * tombstone, so it reaches that machine; what it carries must open only for the others.
 *
 * One envelope per row, JSON `{ v: 1, eph, to: { <peerId>: { nonce, sealed } } }`:
 *
 * - `eph` is one ephemeral X25519 public key per envelope.
 * - Per recipient, the shared secret is X25519 between the ephemeral key and the recipient's
 *   identity key converted to Montgomery form (`ed25519.utils.toMontgomery`); a recipient opens
 *   with its own seed converted the same way (`toMontgomerySecret`).
 * - The wrapping key is HKDF-SHA256 over that secret, salted with the ephemeral public key and
 *   with the strand id in `info`, so an envelope copied onto another strand's row does not open.
 * - The key is sealed with XChaCha20-Poly1305 under a random nonce.
 *
 * Recipients are keyed by control peer id, and the key sealed to is the one that peer id
 * carries (`ed25519PublicKeyB64FromPeerId`), never a stored column. Pure functions, so a test
 * drives them without a node; `@noble/curves`, `@noble/hashes` and `@noble/ciphers` are pure JS,
 * so this loads on React Native and in the browser. No error carries key material.
 *
 * Cost: one X25519 operation for the ephemeral key plus one per recipient, per strand sealed, and
 * one per strand opened (`packages/cadre-rn/src/native-ed25519.ts` has the device numbers).
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { canonicalJson } from './canonical-json.js';

/** One machine a pending key is sealed to. */
export interface PartyKeyRecipient {
  /** The machine's control peer id: its entry's key in the envelope. */
  peerId: string;
  /** The ed25519 identity key behind that peer id (base64url), as `ed25519PublicKeyB64FromPeerId` derives it. */
  publicKeyB64: string;
}

/** The machine opening an envelope: its control peer id and the 32-byte ed25519 seed behind it (`ed25519KeyPairFromLibp2p`). */
export interface PartyKeyOpener {
  peerId: string;
  privateKeyB64: string;
}

const ENVELOPE_VERSION = 1;
/** Binds the derived key to its use and to one strand; the strand id follows. */
const HKDF_INFO_PREFIX = 'sereus:pending-party-key:v1:';
const KEY_BYTES = 32;
const X25519_PUBLIC_KEY_BYTES = 32;
const ED25519_KEY_BYTES = 32;
const XCHACHA_NONCE_BYTES = 24;
const POLY1305_TAG_BYTES = 16;
/** A sealed `StrandPartyKey.PrivateKey` is under 100 bytes; this bounds what a hostile row makes a reader decrypt. */
const MAX_SEALED_BYTES = 1024;

interface SealedEntry {
  nonce: Uint8Array;
  sealed: Uint8Array;
}

interface Envelope {
  ephemeralPublic: Uint8Array;
  to: Map<string, SealedEntry>;
}

/**
 * Seal `privateKey` (a `StrandPartyKey.PrivateKey`) for `strandId` to every recipient. A
 * recipient named twice gets one entry. With no recipients the envelope opens for nobody.
 *
 * @throws When a recipient's public key is not a 32-byte base64url ed25519 key.
 */
export function sealPartyKey(privateKey: string, strandId: string, recipients: readonly PartyKeyRecipient[]): string {
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const plain = new TextEncoder().encode(privateKey);
  const to: Record<string, { nonce: string; sealed: string }> = {};
  try {
    for (const recipient of recipients) {
      const recipientPublic = ed25519.utils.toMontgomery(requireBytes(recipient.publicKeyB64, 'recipient public key', ED25519_KEY_BYTES, ED25519_KEY_BYTES));
      const nonce = randomBytes(XCHACHA_NONCE_BYTES);
      const sealed = withWrappingKey(x25519.getSharedSecret(ephemeralSecret, recipientPublic), ephemeralPublic, strandId,
        (key) => xchacha20poly1305(key, nonce).encrypt(plain));
      to[recipient.peerId] = { nonce: toBase64url(nonce), sealed: toBase64url(sealed) };
    }
  } finally {
    ephemeralSecret.fill(0);
    plain.fill(0);
  }
  return canonicalJson({ eph: toBase64url(ephemeralPublic), to, v: ENVELOPE_VERSION });
}

/**
 * The plain key, or null when `self` is not a recipient.
 *
 * @throws When the envelope is malformed, or `self`'s entry does not open: the row was altered,
 *   or the envelope was sealed for another strand.
 */
export function openPartyKey(sealed: string, strandId: string, self: PartyKeyOpener): string | null {
  const envelope = parseEnvelope(sealed);
  const entry = envelope.to.get(self.peerId);
  if (entry === undefined) {
    return null;
  }
  const secret = ed25519.utils.toMontgomerySecret(requireBytes(self.privateKeyB64, 'identity key', ED25519_KEY_BYTES, ED25519_KEY_BYTES));
  let plain: Uint8Array;
  try {
    plain = withWrappingKey(x25519.getSharedSecret(secret, envelope.ephemeralPublic), envelope.ephemeralPublic, strandId,
      (key) => xchacha20poly1305(key, entry.nonce).decrypt(entry.sealed));
  } catch (error) {
    throw new Error(`The pending party key of strand ${strandId} does not open for this machine: the row was altered, or it was sealed for another strand`, { cause: error });
  } finally {
    secret.fill(0);
  }
  return new TextDecoder().decode(plain);
}

/**
 * The control peer ids the envelope is sealed to.
 *
 * @throws When the envelope is malformed.
 */
export function partyKeyRecipients(sealed: string): string[] {
  return [...parseEnvelope(sealed).to.keys()];
}

/** Derive the wrapping key for one recipient, run `use` over it, and zero both secrets after. */
function withWrappingKey(sharedSecret: Uint8Array, ephemeralPublic: Uint8Array, strandId: string, use: (key: Uint8Array) => Uint8Array): Uint8Array {
  const key = hkdf(sha256, sharedSecret, ephemeralPublic, new TextEncoder().encode(`${HKDF_INFO_PREFIX}${strandId}`), KEY_BYTES);
  try {
    return use(key);
  } finally {
    sharedSecret.fill(0);
    key.fill(0);
  }
}

function parseEnvelope(sealed: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sealed);
  } catch {
    // No cause: JSON.parse's message can quote the input.
    throw new Error('A sealed party key must be JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('A sealed party key must be a JSON object');
  }
  if (parsed.v !== ENVELOPE_VERSION) {
    throw new Error(`A sealed party key must be version ${ENVELOPE_VERSION} (this one says ${JSON.stringify(parsed.v)})`);
  }
  if (!isRecord(parsed.to)) {
    throw new Error('A sealed party key must name its recipients');
  }
  const to = new Map<string, SealedEntry>();
  for (const [peerId, entry] of Object.entries(parsed.to)) {
    if (!isRecord(entry)) {
      throw new Error('Each recipient entry of a sealed party key must be an object');
    }
    to.set(peerId, {
      nonce: requireBytes(entry.nonce, 'nonce', XCHACHA_NONCE_BYTES, XCHACHA_NONCE_BYTES),
      sealed: requireBytes(entry.sealed, 'sealed key', POLY1305_TAG_BYTES, MAX_SEALED_BYTES),
    });
  }
  return { ephemeralPublic: requireBytes(parsed.eph, 'ephemeral key', X25519_PUBLIC_KEY_BYTES, X25519_PUBLIC_KEY_BYTES), to };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBytes(value: unknown, field: string, minBytes: number, maxBytes: number): Uint8Array {
  let bytes: Uint8Array | undefined;
  if (typeof value === 'string') {
    try {
      bytes = uint8ArrayFromString(value, 'base64url');
    } catch (error) {
      throw new Error(`A sealed party key's ${field} must be base64url`, { cause: error });
    }
  }
  if (bytes === undefined || bytes.length < minBytes || bytes.length > maxBytes) {
    throw new Error(`A sealed party key's ${field} must be ${minBytes === maxBytes ? minBytes : `${minBytes} to ${maxBytes}`} bytes of base64url`);
  }
  return bytes;
}

function toBase64url(bytes: Uint8Array): string {
  return uint8ArrayToString(bytes, 'base64url');
}
