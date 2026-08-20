/**
 * secure-key-store.ts — a {@link KeyStore} backed by `expo-secure-store`
 * (iOS Keychain / Android Keystore-encrypted SharedPreferences).
 *
 * This is the mobile secure-enclave backend for the cadre-core key-material seam:
 * the phone node's libp2p identity (and the owner key derived from it) lives
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
 *   prevents a transient access failure from orphaning the real identity. For a
 *   **gated** slot (`requireAuthentication: true`) a `null` read is additionally
 *   ambiguous — Expo resolves a biometric-invalidated entry to `null`, not a
 *   throw — so it is disambiguated via the unauthenticated `__index` marker: the
 *   keyId present in the index ⇒ was-written-but-now-unreadable ⇒
 *   {@link KeyStoreAccessError} (fail-closed, no regeneration); absent ⇒ genuinely
 *   empty / first launch ⇒ `undefined`. See {@link SecureStoreKeyStore.get} for
 *   the documented residual window. For an **ungated** slot (today's default and
 *   every shipped path) `null` always means `undefined`, verbatim as before.
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
	 * at the construction site (see `cadre-phone.ts`). On iOS, enabling this also
	 * requires an `NSFaceIDUsageDescription` string in `app.json`
	 * (`expo.ios.infoPlist`); without it the first Face-ID prompt crashes the app.
	 * When enabled, {@link SecureStoreKeyStore.get} fails closed on a biometric-
	 * invalidated slot (via the `__index` marker) rather than silently regenerating.
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
 * Encode arbitrary text as one SecureStore key SEGMENT. SecureStore only permits
 * `[A-Za-z0-9._-]`; base64url emits exactly `[A-Za-z0-9-_]` (no padding), so any
 * input is always valid and round-trips deterministically — `'cadre/identity'`
 * included (the `/` is encoded away).
 *
 * Exported so every SecureStore slot this app opens escapes identically: the
 * key store's own slots below, and the trusted-owner anchor's party-scoped slot
 * in `node-local-slots.ts`.
 */
export function secureStoreKeySegment(value: string): string {
	return uint8ArrayToString(uint8ArrayFromString(value, 'utf8'), 'base64url');
}

/**
 * Build the {@link SecureStoreOptions} forwarded to every native call, omitting
 * unset fields so the native layer sees its OWN defaults rather than an explicit
 * `undefined` — notably an absent `requireAuthentication`, which means ungated.
 *
 * Exported so a plain `DurableSlot` over SecureStore (`node-local-slots.ts`)
 * forwards exactly what this key store does, rather than re-deriving the rule.
 */
export function forwardedSecureStoreOptions(options: SecureStoreKeyStoreOptions): SecureStoreOptions {
	const forwarded: SecureStoreOptions = {};
	if (options.requireAuthentication !== undefined) {
		forwarded.requireAuthentication = options.requireAuthentication;
	}
	if (options.keychainAccessible !== undefined) {
		forwarded.keychainAccessible = options.keychainAccessible;
	}
	return forwarded;
}

/**
 * Map a logical {@link KeyId} to a SecureStore key under this store's reserved
 * {@link KEY_PREFIX} (whose `.` is also permitted).
 */
function safeKey(keyId: KeyId): string {
	return KEY_PREFIX + secureStoreKeySegment(keyId);
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
		// Built once, omitting unset fields (see forwardedSecureStoreOptions).
		this.options = forwardedSecureStoreOptions(options);
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
		if (stored === null) {
			// material === null. For an UNGATED slot (today's default and every
			// shipped path) this is a genuinely empty slot ⇒ undefined ⇒ the caller
			// may regenerate, exactly as before. For a GATED slot, null is ambiguous
			// (truly empty vs biometric-invalidated, which Expo also reports as null)
			// and is disambiguated via the unauthenticated __index marker.
			if (this.options.requireAuthentication !== true) return undefined;
			return this.gatedNullResult(keyId);
		}
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

	/**
	 * Disambiguate a `null` material read for a GATED slot
	 * (`requireAuthentication === true`); callers MUST NOT invoke this for an
	 * ungated slot, where `null` always means a genuinely empty slot.
	 *
	 * Expo resolves a biometric-INVALIDATED gated entry (one written with
	 * `requireAuthentication: true`, then invalidated by a fingerprint add /
	 * Face-ID re-enroll) to `null` — indistinguishable, at the entry level, from a
	 * truly empty slot. The unauthenticated `__index` marker disambiguates: `set`
	 * records the keyId there (always with `requireAuthentication` dropped via
	 * {@link indexOptions}, so the marker itself can never be biometric-invalidated)
	 * and writes material BEFORE the index. So for a correctly-operating store
	 * `keyId ∈ index` + material `null` can only mean the material was successfully
	 * written in a past session and has since become unreadable
	 * (invalidation/denial) — surfaced as {@link KeyStoreAccessError} (fail-closed)
	 * so the caller never regenerates over the device's real identity.
	 * `keyId ∉ index` ⇒ genuinely empty / true first launch ⇒ `undefined`.
	 *
	 * Why NOT `SecureStore.canUseBiometricAuthentication()`: after a biometric-set
	 * change the device still HAS usable biometrics (the new fingerprint is
	 * enrolled), so that probe returns `true` while this specific entry is
	 * invalidated and reads `null` — it cannot separate invalidation from a truly
	 * empty slot, the exact case we must distinguish. It only helps the unrelated
	 * "no biometrics enrolled at all" case, which is out of scope here.
	 *
	 * Residual window (documented, accepted): a `set` interrupted between its
	 * material and index writes in a PRIOR session, FOLLOWED BY a later
	 * invalidation, leaves material `null` + index absent ⇒ `undefined` ⇒
	 * regeneration. This is strictly no worse than the pre-guard status quo (where
	 * every gated invalidation regenerated) and far rarer; closing it (writing the
	 * marker before the material) would instead permanently wedge a fresh slot
	 * whose `set` crashed before the material write, so we keep material-first.
	 */
	private async gatedNullResult(keyId: KeyId): Promise<undefined> {
		// readIndex() uses indexOptions() (no requireAuthentication), so this probe
		// never triggers a biometric prompt and never reads invalidatable material.
		// A rejection here propagates as KeyStoreAccessError — correct fail-closed
		// behaviour (we do not regenerate when the index state is unknown).
		const index = await this.readIndex();
		if (index.includes(keyId)) {
			throw new KeyStoreAccessError(
				keyId,
				`SecureStoreKeyStore: key slot ${keyId} was present but now reads null ` +
				'(gated slot invalidated/denied) — refusing to report it as empty',
			);
		}
		return undefined;
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
