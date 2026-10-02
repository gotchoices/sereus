/**
 * identity-key — the load-or-create rule for a {@link KeyStore}-backed node
 * identity.
 *
 * Exported beyond `CadreNode` because an embedding app may need its identity key
 * before the node is constructed. Keeping one copy of the rule is load-bearing — a
 * second copy that drifted could generate a fresh key and orphan the real identity.
 *
 * Dependency-free beyond `@libp2p/crypto` (already a core dependency), so this
 * module is safe in every (RN / browser / Node) entry graph.
 */
import debug from 'debug';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { DEFAULT_IDENTITY_KEY_ID, type KeyId, type KeyStore } from './key-store.js';

const log = debug('sereus:cadre:identity-key');

/**
 * Load the node identity key from `keyStore`, generating and persisting a fresh
 * Ed25519 key when the slot is empty.
 *
 * A rejected `get` (e.g. {@link KeyStoreAccessError} from a cancelled biometric
 * prompt) **propagates** — we never fall through to generation on a read error,
 * because that would silently orphan an existing but momentarily unreadable
 * identity. Corrupt bytes in the slot likewise throw rather than regenerate.
 *
 * Idempotent in effect: a second call on a populated store loads the stored key
 * and writes nothing.
 *
 * @param keyStore - Backend the identity is read from / persisted to.
 * @param keyId - Slot id; defaults to {@link DEFAULT_IDENTITY_KEY_ID}.
 * @returns The resolved libp2p private key.
 */
export async function loadOrCreateIdentityKey(
  keyStore: KeyStore,
  keyId: KeyId = DEFAULT_IDENTITY_KEY_ID
): Promise<PrivateKey> {
  // A rejection here (e.g. KeyStoreAccessError) must propagate — do NOT fall
  // through to generation, which would orphan an existing but unreadable key.
  const bytes = await keyStore.get(keyId);
  if (bytes) {
    // Corrupt/garbage bytes throw here; surface loudly rather than
    // regenerating (which would orphan the real identity).
    const loaded = privateKeyFromProtobuf(bytes);
    log('Identity key loaded from key store (slot present)');
    return loaded;
  }

  const generated = await generateKeyPair('Ed25519');
  await keyStore.set(keyId, privateKeyToProtobuf(generated));
  log('Identity key generated and persisted to key store (first run)');
  return generated;
}
