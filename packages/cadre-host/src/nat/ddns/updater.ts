import debug from 'debug';

import type { SecretsStore } from '../secrets/index.js';
import { ddnsAccount } from '../secrets/index.js';
import { NatError, type NatDdnsStatus, type NatDdnsSettings } from '../types.js';
import type { DdnsProvider } from './index.js';
import { getProvider } from './index.js';

const log = debug('cadre:host:nat-ddns:updater');

/** Outcome of a single DDNS update attempt. */
export interface DdnsUpdateOutcome {
  attempted: boolean;
  ok: boolean;
  ip: string | null;
  error: string | null;
  at: Date;
}

export interface DdnsUpdaterOptions {
  /** Current DDNS settings (provider, hostname, externally-managed flag). */
  settings: NatDdnsSettings;
  /** Backing credential store. */
  secrets: SecretsStore;
  /** Returns the most recently observed external IP (null when unknown). */
  getExternalIp: () => string | null;
  /** Fetch override for tests. */
  fetch?: typeof fetch;
  /** Provider resolver override (tests can inject fakes). */
  resolveProvider?: (providerId: string) => DdnsProvider;
  /** Clock override for tests. */
  now?: () => Date;
  /** Timer overrides for tests. */
  setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (h: NodeJS.Timeout) => void;
}

/**
 * DDNS update loop.
 *
 * Lifecycle:
 *   - `start()`: if a provider is configured AND not externally managed, runs
 *     an immediate update, then schedules `setInterval(intervalMs)`.
 *   - On each tick: re-evaluates the IP. If unchanged from the last successful
 *     update, no provider call. If changed, calls `provider.update`. Errors
 *     are recorded but the timer keeps ticking.
 *   - `stop()`: clears the timer. Idempotent.
 *   - `updateSettings(...)`: swap in new settings, re-starting if needed.
 *   - `forceUpdate()`: bypass the unchanged-IP check (used by `testReachability`).
 */
export class DdnsUpdater {
  private settings: NatDdnsSettings;
  private readonly secrets: SecretsStore;
  private readonly getExternalIp: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveProvider: (providerId: string) => DdnsProvider;
  private readonly nowFn: () => Date;
  private readonly setIntervalFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (h: NodeJS.Timeout) => void;

  private timer: NodeJS.Timeout | null = null;
  private lastPushedIp: string | null = null;
  private lastOutcome: DdnsUpdateOutcome | null = null;
  private started = false;

  constructor(opts: DdnsUpdaterOptions) {
    this.settings = opts.settings;
    this.secrets = opts.secrets;
    this.getExternalIp = opts.getExternalIp;
    this.fetchImpl = opts.fetch ?? fetch;
    this.resolveProvider = opts.resolveProvider ?? getProvider;
    this.nowFn = opts.now ?? (() => new Date());
    this.setIntervalFn = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h));
  }

  /** Current status (for the NatService snapshot). */
  getStatus(): NatDdnsStatus {
    return {
      providerId: this.settings.providerId,
      hostname: this.settings.hostname,
      externallyManaged: this.settings.externallyManaged,
      lastUpdateAt: this.lastOutcome?.at.toISOString() ?? null,
      lastUpdateOk: this.lastOutcome?.ok ?? null,
      lastError: this.lastOutcome?.error ?? null,
    };
  }

  async start(): Promise<DdnsUpdateOutcome> {
    if (this.started) {
      return this.lastOutcome ?? notAttempted(this.nowFn());
    }
    this.started = true;

    if (!this.shouldUpdate()) {
      const outcome = notAttempted(this.nowFn());
      // For an externally-managed entry we still report state, but never push.
      return outcome;
    }

    const outcome = await this.runOnce();
    this.scheduleNext();
    return outcome;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  /** Replace settings; restart the loop with the new configuration. */
  async updateSettings(next: NatDdnsSettings): Promise<DdnsUpdateOutcome> {
    const wasRunning = this.started;
    this.stop();
    this.settings = next;
    this.lastPushedIp = null;
    if (!wasRunning) return this.lastOutcome ?? notAttempted(this.nowFn());
    return await this.start();
  }

  /** Force an immediate update, bypassing the unchanged-IP skip. */
  async forceUpdate(): Promise<DdnsUpdateOutcome> {
    if (!this.shouldUpdate()) return notAttempted(this.nowFn());
    this.lastPushedIp = null;
    return await this.runOnce();
  }

  private shouldUpdate(): boolean {
    if (!this.settings.providerId) return false;
    if (!this.settings.hostname) return false;
    if (this.settings.externallyManaged) return false;
    return true;
  }

  private scheduleNext(): void {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = this.setIntervalFn(() => {
      void this.runOnce().catch((err) => log('updater tick error: %s', (err as Error).message));
    }, this.settings.intervalMs);
  }

  private async runOnce(): Promise<DdnsUpdateOutcome> {
    const ip = this.getExternalIp();
    if (!ip) {
      const outcome: DdnsUpdateOutcome = {
        attempted: false,
        ok: false,
        ip: null,
        error: 'external IP unknown',
        at: this.nowFn(),
      };
      this.lastOutcome = outcome;
      return outcome;
    }

    if (ip === this.lastPushedIp) {
      // Unchanged: no provider call (per DuckDNS guidance: don't re-push).
      log('DDNS skip: IP unchanged (%s)', ip);
      return this.lastOutcome ?? notAttempted(this.nowFn());
    }

    let provider: DdnsProvider;
    try {
      provider = this.resolveProvider(this.settings.providerId!);
    } catch (err) {
      const outcome: DdnsUpdateOutcome = {
        attempted: true,
        ok: false,
        ip,
        error: (err as Error).message,
        at: this.nowFn(),
      };
      this.lastOutcome = outcome;
      return outcome;
    }

    let config: Record<string, string>;
    try {
      config = await this.loadConfig(provider);
    } catch (err) {
      const outcome: DdnsUpdateOutcome = {
        attempted: true,
        ok: false,
        ip,
        error: (err as Error).message,
        at: this.nowFn(),
      };
      this.lastOutcome = outcome;
      return outcome;
    }

    try {
      await provider.update(config, this.settings.hostname!, ip, { fetch: this.fetchImpl });
      this.lastPushedIp = ip;
      const outcome: DdnsUpdateOutcome = {
        attempted: true,
        ok: true,
        ip,
        error: null,
        at: this.nowFn(),
      };
      this.lastOutcome = outcome;
      log('DDNS update OK: %s → %s', this.settings.hostname, ip);
      return outcome;
    } catch (err) {
      const outcome: DdnsUpdateOutcome = {
        attempted: true,
        ok: false,
        ip,
        error: (err as Error).message,
        at: this.nowFn(),
      };
      this.lastOutcome = outcome;
      log('DDNS update FAIL: %s', outcome.error);
      return outcome;
    }
  }

  private async loadConfig(provider: DdnsProvider): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const field of provider.configFields) {
      if (!field.secret) continue;
      const value = await this.secrets.get(ddnsAccount(provider.id, field.key));
      if (value === null) {
        throw new NatError(
          'ddns_credentials_missing',
          `Missing DDNS credential for provider "${provider.id}", field "${field.key}". ` +
          `Configure with \`cadre-host nat ddns set ${provider.id}\`.`,
        );
      }
      result[field.key] = value;
    }
    return result;
  }
}

function notAttempted(at: Date): DdnsUpdateOutcome {
  return { attempted: false, ok: false, ip: null, error: null, at };
}
