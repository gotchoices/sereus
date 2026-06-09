/**
 * secure-key-store.ts — a {@link KeyStore} backed by `expo-secure-store`
 * (iOS Keychain / Android Keystore-encrypted SharedPreferences).
 *
 * This is the mobile secure-enclave backend for the cadre-core key-material seam:
 * the phone node's libp2p identity (and the authority key derived from it) lives
 * here instead of plaintext LevelDB. The class is platform-agnostic — it talks to
 * an injected {@link SecureStoreApi} (the three `expo-secure-store` async methods
 * it needs), so the production wiring passes the real module while unit tests pass
 * an in-memory fake. The `expo-secure-store` import is **type-only**, so importing
 * this module never pulls the native module into a Node/test graph.
 *
 * Bridging constraints handled here:
 * - **Bytes ↔ text.** SecureStore stores strings; KeyStore material is bytes.
 *   We base64-encode on `set` and decode on `get` (lossless for protobuf bytes).
 * - **KeyId → SecureStore key.** SecureStore keys may only contain
 *   `[A-Za-z0-9._-]` (no `/`). We base64url-encode the keyId under a stable
 *   prefix, which round-trips deterministically and escapes every disallowed char.
 * - **`list()` via index.** Neither backing enclave can enumerate keys, so we keep
 *   a reserved index entry holding a JSON array of logical keyIds. Material is
 *   written before the index (a crash leaves an orphaned-but-readable slot, never
 *   an index entry pointing at missing material); index mutations are serialized.
 * - **Access vs absence.** A thrown `getItemAsync` (e.g. a cancelled biometric
 *   prompt) becomes {@link KeyStoreAccessError}; a `null` return becomes
 *   `undefined`. cadre-core regenerates only on `undefined`, so this distinction
 *   prevents a transient access failure from orphaning the real identity.
 *
 * Size note: `expo-secure-store` enforces a soft ~2048-byte value limit. An
 * Ed25519 identity protobuf (~68 bytes) is far under it; we never store large
 * material here and do not truncate — an oversized `set` surfaces the native error.
 */

import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import type { KeyId, KeyStore } from '@serfab/cadre-core';
import { KeyStoreAccessError } from '@serfab/cadre-core';
import type { SecureStoreOptions, KeychainAccessibilityConstant } from 'expo-secure-store';

/**
 * The subset of `expo-secure-store` this backend depends on. Injected so tests
 * can supply an in-memory fake and the native module never loads under Node.
 * The real `expo-secure-store` module is structurally assignable to this.
 */
export interface SecureStoreApi {
	getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
	setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void>;
	deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}

/** App-controllable gating/accessibility forwarded to every SecureStore call. */
export interface SecureStoreKeyStoreOptions {
	/**
	 * Require device user-authentication (biometric / passcode) to read the slot.
	 * Default `false`: the identity slot must come up in background/headless
	 * contexts, and a biometric-set change would otherwise invalidate it. Enable
	 * only for slots whose UX can absorb a prompt. Unsupported in Expo Go — guard
	 * at the construction site (see `cadre-phone.ts`).
	 */
	requireAuthentication?: boolean;
	/**
	 * iOS Keychain accessibility class (`kSecAttrAccessible`). Default behavior
	 * (when unset) is SecureStore's `WHEN_UNLOCKED`; pass `AFTER_FIRST_UNLOCK` to
	 * permit reads while the device is locked after first unlock (background node
	 * bring-up). No effect on Android.
	 */
	keychainAccessible?: KeychainAccessibilityConstant;
}

/** Stable prefix for every logical slot, keeping our keys clear of foreign ones. */
const KEY_PREFIX = 'sereus.ks.';

/** Reserved SecureStore key holding the JSON index of logical keyIds. */
const INDEX_KEY = `${KEY_PREFIX}__index`;

/**
 * Map a logical {@link KeyId} to a SecureStore key. SecureStore only permits
 * `[A-Za-z0-9._-]`; base64url emits exactly `[A-Za-z0-9-_]` (no padding), so the
 * encoded keyId is always valid and round-trips deterministically — `'cadre/identity'`
 * included (the `/` is encoded away). The prefix's `.` is also permitted.
 */
function safeKey(keyId: KeyId): string {
	return KEY_PREFIX + uint8ArrayToString(uint8ArrayFromString(keyId, 'utf8'), 'base64url');
}

/** Parse the index JSON into a string[] defensively (a corrupt index reads as empty). */
function parseIndex(raw: string): KeyId[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.warn('[secure-key-store] index JSON parse failed; treating as empty', error);
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((v): v is string => typeof v === 'string');
}

/** Whether two keyId arrays are element-wise identical (skips no-op index writes). */
function sameIds(a: readonly KeyId[], b: readonly KeyId[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * {@link KeyStore} over `expo-secure-store`. Construct with the SecureStore module
 * (or a fake) and optional gating/accessibility. See the module header for the
 * byte/text, keyId-mapping, index, and access-vs-absence contracts.
 */
export class SecureStoreKeyStore implements KeyStore {
	private readonly options: SecureStoreOptions;
	/** Serializes index read-modify-write so concurrent set/delete never lose entries. */
	private indexChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly backend: SecureStoreApi,
		options: SecureStoreKeyStoreOptions = {},
	) {
		// Build the forwarded options object once, omitting unset fields so the
		// native layer sees its own defaults rather than explicit `undefined`.
		const forwarded: SecureStoreOptions = {};
		if (options.requireAuthentication !== undefined) {
			forwarded.requireAuthentication = options.requireAuthentication;
		}
		if (options.keychainAccessible !== undefined) {
			forwarded.keychainAccessible = options.keychainAccessible;
		}
		this.options = forwarded;
	}

	/**
	 * Options for index reads/writes. The index holds only keyIds (never material)
	 * and is touched by `list()`/`set()`/`delete()` on every call, so it must never
	 * require a biometric prompt — keep accessibility (for background reads) but
	 * drop `requireAuthentication`.
	 */
	private indexOptions(): SecureStoreOptions {
		const { keychainAccessible } = this.options;
		return keychainAccessible !== undefined ? { keychainAccessible } : {};
	}

	async get(keyId: KeyId): Promise<Uint8Array | undefined> {
		let stored: string | null;
		try {
			stored = await this.backend.getItemAsync(safeKey(keyId), this.options);
		} catch (error) {
			// A rejection means access was denied (e.g. a cancelled biometric prompt)
			// or the backend failed — NOT an empty slot. Surface as access-denied so
			// the caller does not regenerate over an existing-but-unreadable key.
			throw new KeyStoreAccessError(
				keyId,
				`SecureStoreKeyStore: failed to read key slot ${keyId}`,
				{ cause: error },
			);
		}
		if (stored === null) return undefined; // genuinely empty slot
		try {
			return uint8ArrayFromString(stored, 'base64');
		} catch (error) {
			// Corrupt stored text: surface loudly rather than returning truncated
			// bytes or undefined (which would orphan the real key via regeneration).
			throw new KeyStoreAccessError(
				keyId,
				`SecureStoreKeyStore: stored material for ${keyId} is not valid base64`,
				{ cause: error },
			);
		}
	}

	async set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void> {
		const encoded = uint8ArrayToString(keyMaterial, 'base64');
		// Material first, then index: a crash between the two leaves an
		// orphaned-but-readable slot, never an index entry pointing at nothing.
		await this.backend.setItemAsync(safeKey(keyId), encoded, this.options);
		await this.addToIndex(keyId);
	}

	async delete(keyId: KeyId): Promise<void> {
		// Index first, then material: a crash between the two leaves orphaned
		// material (tolerable — never returned via `list`), preserving the
		// "no index entry without material" invariant `set` also maintains.
		await this.removeFromIndex(keyId);
		// `deleteItemAsync` is a no-op for an absent key, so `delete` is idempotent.
		await this.backend.deleteItemAsync(safeKey(keyId), this.options);
	}

	async list(): Promise<KeyId[]> {
		return this.readIndex();
	}

	// ── Index management ───────────────────────────────────────────────────────

	private async readIndex(): Promise<KeyId[]> {
		let raw: string | null;
		try {
			raw = await this.backend.getItemAsync(INDEX_KEY, this.indexOptions());
		} catch (error) {
			throw new KeyStoreAccessError(INDEX_KEY, 'SecureStoreKeyStore: failed to read key index', { cause: error });
		}
		return raw === null ? [] : parseIndex(raw);
	}

	private addToIndex(keyId: KeyId): Promise<void> {
		return this.mutateIndex((ids) => (ids.includes(keyId) ? ids : [...ids, keyId]));
	}

	private removeFromIndex(keyId: KeyId): Promise<void> {
		return this.mutateIndex((ids) => ids.filter((id) => id !== keyId));
	}

	/**
	 * Serialized read-modify-write of the single index entry. Chaining onto
	 * {@link indexChain} ensures two near-simultaneous writers don't both read the
	 * stale array and clobber each other's change. A failed link is swallowed for
	 * the chain (so it doesn't wedge later writes) but still rejected to the caller.
	 */
	private mutateIndex(mutate: (ids: KeyId[]) => KeyId[]): Promise<void> {
		const next = this.indexChain.then(async () => {
			const current = await this.readIndex();
			const updated = mutate(current);
			if (sameIds(current, updated)) return; // dedup add / absent delete: nothing to write
			await this.backend.setItemAsync(INDEX_KEY, JSON.stringify(updated), this.indexOptions());
		});
		this.indexChain = next.catch(() => {});
		return next;
	}
}

// ── Legacy identity migration ──────────────────────────────────────────────────

/** Outcome of {@link migrateLegacyIdentity}, surfaced for logging/diagnostics. */
export type LegacyIdentityMigrationOutcome =
	| 'already-present' // secure slot already populated — nothing to do
	| 'no-legacy'       // no legacy key found — caller's load path will generate fresh
	| 'legacy-read-failed' // legacy read threw — fall through to fresh generation
	| 'migrated';       // legacy bytes copied into the secure slot

/** Dependencies for the one-time legacy-identity migration (all injectable for tests). */
export interface LegacyIdentityMigrationDeps {
	/** The secure store the identity is migrated INTO. */
	store: KeyStore;
	/** Slot id for the node identity in {@link store}. */
	identityKeyId: KeyId;
	/** Reads the legacy identity protobuf bytes, or `undefined` if none exist. */
	readLegacy: () => Promise<Uint8Array | undefined>;
	/** Optional best-effort removal of the legacy copy after a successful migration. */
	deleteLegacy?: () => Promise<void>;
}

/**
 * One-time migration of a pre-existing plaintext identity into the secure store.
 *
 * Gated on the secure slot being EMPTY: when it already holds a key (a prior
 * migration, or cadre-core's fresh generation) this returns `'already-present'`
 * and never touches the legacy store — so the actual copy + legacy delete happen
 * at most once. Must run BEFORE the node's load-or-create path, otherwise that
 * path would generate a fresh key into the empty slot and the legacy PeerId/
 * authority identity would be lost.
 *
 * Safety: a `store.get` rejection (access denied) PROPAGATES — we never migrate or
 * regenerate over an unreadable slot. A `readLegacy` failure is swallowed to
 * `'legacy-read-failed'` so the caller falls through to fresh generation rather
 * than aborting startup. Never logs key material.
 */
export async function migrateLegacyIdentity(
	deps: LegacyIdentityMigrationDeps,
): Promise<LegacyIdentityMigrationOutcome> {
	const { store, identityKeyId, readLegacy, deleteLegacy } = deps;

	// Propagates a KeyStoreAccessError — do NOT proceed to generate/migrate over an
	// existing-but-unreadable slot.
	const existing = await store.get(identityKeyId);
	if (existing) return 'already-present';

	let legacy: Uint8Array | undefined;
	try {
		legacy = await readLegacy();
	} catch (error) {
		console.warn('[secure-key-store] legacy identity read failed; will generate fresh', error);
		return 'legacy-read-failed';
	}
	if (!legacy || legacy.byteLength === 0) return 'no-legacy';

	await store.set(identityKeyId, legacy);
	if (deleteLegacy) {
		try {
			await deleteLegacy();
		} catch (error) {
			// Non-fatal: the key is already secured; an orphaned legacy copy is
			// tolerable (and will simply never be consulted again).
			console.warn('[secure-key-store] legacy identity delete failed (non-fatal)', error);
		}
	}
	return 'migrated';
}
