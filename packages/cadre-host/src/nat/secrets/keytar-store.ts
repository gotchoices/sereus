import debug from 'debug';

import { NatError } from '../types.js';
import type { KeytarLike, SecretsStore } from './index.js';

const log = debug('cadre:host:nat-secrets:keytar');

/**
 * SecretsStore backed by the OS keychain via the `keytar` npm package.
 *
 * The keytar module is injected (rather than imported here) so:
 *   - The native dependency is loaded lazily by `createSecretsStore` and
 *     unavailable platforms fall through cleanly to the file store.
 *   - Unit tests can stub the entire keytar surface.
 */
export class KeytarSecretsStore implements SecretsStore {
  constructor(
    private readonly service: string,
    private readonly keytar: KeytarLike,
  ) {}

  async set(account: string, value: string): Promise<void> {
    try {
      await this.keytar.setPassword(this.service, account, value);
    } catch (err) {
      throw new NatError(
        'secrets_unavailable',
        `keytar setPassword failed: ${(err as Error).message}`,
      );
    }
  }

  async get(account: string): Promise<string | null> {
    try {
      return await this.keytar.getPassword(this.service, account);
    } catch (err) {
      throw new NatError(
        'secrets_unavailable',
        `keytar getPassword failed: ${(err as Error).message}`,
      );
    }
  }

  async delete(account: string): Promise<boolean> {
    try {
      return await this.keytar.deletePassword(this.service, account);
    } catch (err) {
      throw new NatError(
        'secrets_unavailable',
        `keytar deletePassword failed: ${(err as Error).message}`,
      );
    }
  }

  async list(): Promise<string[]> {
    try {
      const creds = await this.keytar.findCredentials(this.service);
      log('keytar findCredentials returned %d entries', creds.length);
      return creds.map((c) => c.account);
    } catch (err) {
      throw new NatError(
        'secrets_unavailable',
        `keytar findCredentials failed: ${(err as Error).message}`,
      );
    }
  }
}
