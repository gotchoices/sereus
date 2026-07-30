/**
 * In-memory `expo-secure-store` double, shared by every spec that exercises a
 * SecureStore-backed seam (`secure-key-store.spec.ts`, `node-local-slots.spec.ts`).
 *
 * Stands in for the native `getItemAsync` / `setItemAsync` / `deleteItemAsync`,
 * records the options each call received (so a spec can assert exactly what was
 * forwarded), and can be told to fail either direction — per key
 * ({@link FakeSecureStore.throwOnGet}) or for every call ({@link FakeSecureStore.getError},
 * {@link FakeSecureStore.setError}) — to simulate an access-denied / cancelled
 * biometric prompt or a failed enclave write.
 */
import type { SecureStoreOptions } from 'expo-secure-store';
import type { SecureStoreApi } from '../src/secure-key-store';

/** The reserved index entry `SecureStoreKeyStore` keeps its keyId list under. */
export const INDEX_KEY = 'sereus.ks.__index';

export class FakeSecureStore implements SecureStoreApi {
	readonly map = new Map<string, string>();
	/** Keys whose read fails, as a cancelled biometric prompt would. */
	readonly throwOnGet = new Set<string>();
	/** When set, EVERY read fails with this error. */
	getError: Error | null = null;
	/** When set, EVERY write fails with this error. */
	setError: Error | null = null;
	readonly getOptionsByKey = new Map<string, SecureStoreOptions | undefined>();
	readonly setOptionsByKey = new Map<string, SecureStoreOptions | undefined>();

	async getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null> {
		this.getOptionsByKey.set(key, options);
		if (this.getError) throw this.getError;
		if (this.throwOnGet.has(key)) throw new Error('biometric prompt cancelled');
		return this.map.has(key) ? this.map.get(key)! : null;
	}

	async setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void> {
		this.setOptionsByKey.set(key, options);
		if (this.setError) throw this.setError;
		this.map.set(key, value);
	}

	async deleteItemAsync(key: string): Promise<void> {
		this.map.delete(key);
	}

	/** Material keys this store wrote (excludes the reserved index entry). */
	materialKeys(): string[] {
		return [...this.map.keys()].filter((k) => k !== INDEX_KEY);
	}
}
