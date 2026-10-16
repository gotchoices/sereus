/**
 * The owner key file (`owner.keyFile`, default `<nodeStateDir>/owner.key`): the owner key a server
 * holds when the user deliberately made it an owner, kept apart from the node identity
 * (`docs/architecture.md` → Owner Keys). `cadre start --owner` and the one-shot commands sign their
 * owner writes with it; `cadre owner-key` shows, exports and imports it.
 *
 * The file is one owner-key slot of cadre-core's (`owner-key-store.ts`), so the slot's rules hold
 * here unchanged: an absent file is never filled on read, nothing is created over a file that
 * holds anything, and a different key is never imported over it. Its bytes are the identity
 * file's format: a libp2p protobuf-encoded Ed25519 private key.
 */
import { readFile, rm } from 'node:fs/promises';
import {
  DEFAULT_OWNER_KEY_ID,
  KeyStoreAccessError,
  createOwnerKey,
  importOwnerKey,
  loadOwnerSigner,
  readOwnerPrivateKey,
  softwareOwnerSigner,
  type KeyId,
  type KeyStore,
  type OwnerSigner,
} from '@serfab/cadre-core';
import { writePrivateFileAtomically } from './private-file.js';

/** The 8 characters of an owner key the apps show for it. */
export function ownerKeyFingerprint(publicKey: string): string {
  return publicKey.slice(0, 8);
}

/** The owner key file as a {@link KeyStore} of one slot, {@link DEFAULT_OWNER_KEY_ID}. */
class OwnerKeyFileStore implements KeyStore {
  constructor(private readonly file: string) {}

  async get(keyId: KeyId): Promise<Uint8Array | undefined> {
    this.requireSlot(keyId);
    try {
      return new Uint8Array(await readFile(this.file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      // Never "absent": a key that cannot be read must not be created over.
      throw new KeyStoreAccessError(keyId, `Cannot read the owner key file ${this.file}: ${errorMessage(err)}`, { cause: err });
    }
  }

  async set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void> {
    this.requireSlot(keyId);
    await writePrivateFileAtomically(this.file, keyMaterial);
  }

  async delete(keyId: KeyId): Promise<void> {
    this.requireSlot(keyId);
    await rm(this.file, { force: true });
  }

  async list(): Promise<KeyId[]> {
    return (await this.get(DEFAULT_OWNER_KEY_ID)) === undefined ? [] : [DEFAULT_OWNER_KEY_ID];
  }

  private requireSlot(keyId: KeyId): void {
    if (keyId !== DEFAULT_OWNER_KEY_ID) {
      throw new Error(`The owner key file ${this.file} holds the one slot ${DEFAULT_OWNER_KEY_ID}, not ${keyId}`);
    }
  }
}

/**
 * Run `read` over the file's slot, naming the file when its bytes are not an Ed25519 private key.
 * Such a file is never a reason to make a new key: it may be the only copy of one.
 */
async function readSlot<T>(file: string, read: (store: KeyStore) => Promise<T>): Promise<T> {
  try {
    return await read(new OwnerKeyFileStore(file));
  } catch (err) {
    if (err instanceof KeyStoreAccessError) throw err;
    throw new Error(
      `Invalid owner key file ${file}: not a libp2p protobuf-encoded Ed25519 private key. It is never replaced automatically: `
      + 'move it away and restore the key from an export (`cadre owner-key import`), or point owner.keyFile at the right file.',
      { cause: err },
    );
  }
}

/** A signer over the key in `file`, or `undefined` when there is no file. */
export async function loadOwnerKeyFile(file: string): Promise<OwnerSigner | undefined> {
  return await readSlot(file, (store) => loadOwnerSigner(store));
}

/** The private key in `file` as a base64url Ed25519 seed (what an export carries), or `undefined` when there is no file. */
export async function readOwnerKeyFilePrivateKey(file: string): Promise<string | undefined> {
  return await readSlot(file, (store) => readOwnerPrivateKey(store));
}

/** The key in `file`, or a fresh one written there when there is no file; `created` says which. */
export async function loadOrCreateOwnerKeyFile(file: string): Promise<{ signer: OwnerSigner; created: boolean }> {
  const existing = await loadOwnerKeyFile(file);
  if (existing) return { signer: existing, created: false };
  return { signer: await createOwnerKey(new OwnerKeyFileStore(file)), created: true };
}

/**
 * Keep an imported key (its base64url Ed25519 seed) in `file`. Importing the key the file already
 * holds writes nothing (`changed: false`); a file holding another key is refused, naming both.
 */
export async function importOwnerKeyFile(file: string, privateKeyB64: string): Promise<{ signer: OwnerSigner; changed: boolean }> {
  const existing = await loadOwnerKeyFile(file);
  const importedKey = softwareOwnerSigner(privateKeyB64).publicKey;
  if (existing && existing.publicKey !== importedKey) {
    throw new Error(
      `The owner key file ${file} already holds a different owner key (${ownerKeyFingerprint(existing.publicKey)}); importing `
      + `${ownerKeyFingerprint(importedKey)} would replace it, and the key it holds would be gone from this machine. `
      + 'Export it first (`cadre owner-key export`) if it is not backed up, then move the file away.',
    );
  }
  const signer = await importOwnerKey(new OwnerKeyFileStore(file), privateKeyB64);
  return { signer, changed: existing === undefined };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
