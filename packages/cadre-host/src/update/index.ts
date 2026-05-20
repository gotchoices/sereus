/**
 * UpdateService — the composition root for the cadre-host update flow.
 *
 * Background check cadence: once at construction time (`check()` called
 * explicitly by `cadre-host start` after the management API binds) and a
 * 24-hour interval timer thereafter. Failures are silent — UI consumers see
 * `lastChecked` only when a fetch succeeds.
 *
 * Apply flow: re-fetch + re-verify the manifest (never trust the cached
 * `available`), record `applyInProgress`, run `npm install -g`, restart the
 * service via the optional `ServiceRestarter`, and roll back on failure.
 */

import debug from 'debug';

import {
  applyUpdate,
  defaultNpmExecutor,
  type NpmExecutor,
  type ServiceRestarter,
} from './apply.js';
import {
  DEFAULT_MANIFEST_URL,
  fetchManifest,
} from './manifest.js';
import { UpdateStateStore } from './store.js';
import {
  UpdateErrorException,
  type UpdateApplyResult,
  type UpdateManifest,
  type UpdateSettings,
  type UpdateState,
} from './types.js';
import { compareVersions } from './version.js';

const log = debug('cadre:host:update-service');

const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NPM_TIMEOUT_MS = 5 * 60 * 1000;

export interface UpdateServiceOptions {
  /** cadre-host data directory; UpdateState file lives here. */
  dataDir: string;
  /** Currently-running package version (from package.json). */
  currentVersion: string;
  /** Manifest URL. Defaults: env CADRE_HOST_UPDATE_MANIFEST_URL → DEFAULT_MANIFEST_URL. */
  manifestUrl?: string;
  /** Fetcher (test injection). */
  fetcher?: typeof fetch;
  /** npm runner (test injection). */
  npmExecutor?: NpmExecutor;
  /** Service-host restart hook (test injection / wiring from cadre-host start). */
  restart?: ServiceRestarter;
  /** Initial settings (autoApply etc) — typically sourced from host.config.json. */
  settings?: UpdateSettings;
  /** Periodic-check interval; defaults to 24h. */
  checkIntervalMs?: number;
  /** npm install timeout; defaults to 5m. */
  npmTimeoutMs?: number;
}

/** Handlers for the management-API listener. */
export interface UpdateHandlers {
  getState(): Promise<UpdateState>;
  postApply(): Promise<UpdateApplyResult>;
  getSettings(): Promise<UpdateSettings>;
  putSettings(body: { autoApply?: boolean; manifestUrl?: string }): Promise<UpdateSettings>;
}

export class UpdateService {
  private readonly store: UpdateStateStore;
  private readonly currentVersion: string;
  private readonly fetcher: typeof fetch;
  private readonly npmExecutor: NpmExecutor;
  private readonly restart: ServiceRestarter | undefined;
  private readonly checkIntervalMs: number;
  private readonly npmTimeoutMs: number;

  private manifestUrl: string;
  private settings: UpdateSettings;
  private timer: ReturnType<typeof setInterval> | null = null;
  private applying = false;

  /** Persisted settings changes are bubbled out via this callback (wired in cadre-host start). */
  private onSettingsChange?: (next: UpdateSettings) => void | Promise<void>;

  constructor(opts: UpdateServiceOptions) {
    this.store = new UpdateStateStore(opts.dataDir);
    this.currentVersion = opts.currentVersion;
    this.fetcher = opts.fetcher ?? fetch;
    this.npmTimeoutMs = opts.npmTimeoutMs ?? DEFAULT_NPM_TIMEOUT_MS;
    this.npmExecutor = opts.npmExecutor ?? defaultNpmExecutor(this.npmTimeoutMs);
    this.restart = opts.restart;
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.settings = opts.settings ?? { autoApply: false };
    this.manifestUrl = resolveManifestUrl(opts.manifestUrl, this.settings.manifestUrl);
  }

  /** Read the persisted state for UI consumption. */
  async getState(): Promise<UpdateState> {
    return this.store.load();
  }

  /** Current settings (in-memory). */
  getSettings(): UpdateSettings {
    return { ...this.settings };
  }

  /**
   * Update settings (autoApply / manifestUrl). The optional `onSettingsChange`
   * hook is invoked so the caller can persist to host.config.json.
   */
  async putSettings(patch: { autoApply?: boolean; manifestUrl?: string }): Promise<UpdateSettings> {
    if (patch.autoApply !== undefined) this.settings.autoApply = patch.autoApply;
    if (patch.manifestUrl !== undefined) this.settings.manifestUrl = patch.manifestUrl;
    this.manifestUrl = resolveManifestUrl(undefined, this.settings.manifestUrl);
    if (this.onSettingsChange) await this.onSettingsChange({ ...this.settings });
    return { ...this.settings };
  }

  /** Register the persistence hook called after every settings mutation. */
  onSettingsChanged(handler: (next: UpdateSettings) => void | Promise<void>): void {
    this.onSettingsChange = handler;
  }

  /**
   * Background manifest check. Never throws — fetch/parse failures log at
   * debug; signature failures are recorded as `lastError` so the UI can warn.
   */
  async check(): Promise<void> {
    let manifest: UpdateManifest;
    try {
      manifest = await fetchManifest({
        url: this.manifestUrl,
        fetcher: this.fetcher,
      });
    } catch (err) {
      if (err instanceof UpdateErrorException && err.code === 'signature_invalid') {
        log('manifest signature invalid: %s', err.message);
        this.store.update({
          lastError: { code: err.code, message: err.message, at: new Date().toISOString() },
        });
        return;
      }
      // Network / parse / endpoint-down: silent.
      log('manifest fetch failed: %s', (err as Error).message);
      return;
    }

    const now = new Date().toISOString();
    const compared = compareVersions(this.currentVersion, manifest.version);
    if (compared >= 0) {
      // Already up-to-date — clear any stale `available` record.
      this.store.update({
        lastChecked: now,
        available: undefined,
        lastError: undefined,
      });
      log('check ok: current %s ≥ %s', this.currentVersion, manifest.version);
      return;
    }

    this.store.update({
      lastChecked: now,
      available: {
        version: manifest.version,
        publishedAt: manifest.publishedAt,
        ...(manifest.releaseNotesUrl ? { releaseNotesUrl: manifest.releaseNotesUrl } : {}),
      },
      lastError: undefined,
    });
    log('update available: %s → %s', this.currentVersion, manifest.version);

    if (this.settings.autoApply) {
      try {
        await this.apply();
      } catch (err) {
        // apply() already recorded the error; we just don't want to crash the timer.
        log('auto-apply failed: %s', (err as Error).message);
      }
    }
  }

  /**
   * Trigger an apply. Re-verifies the manifest, runs npm install -g, attempts
   * a service restart, and rolls back on failure. Throws UpdateErrorException
   * on any hard failure; success returns the new state.
   */
  async apply(): Promise<UpdateApplyResult> {
    if (this.applying) {
      throw new UpdateErrorException('apply_in_progress', 'another apply is already running');
    }
    const state = this.store.load();
    if (state.applyInProgress) {
      throw new UpdateErrorException('apply_in_progress', 'state already records an in-flight apply');
    }
    this.applying = true;
    try {
      const manifest = await fetchManifest({
        url: this.manifestUrl,
        fetcher: this.fetcher,
      });
      if (compareVersions(this.currentVersion, manifest.version) >= 0) {
        throw new UpdateErrorException(
          'no_update_available',
          `current ${this.currentVersion} is already ≥ latest ${manifest.version}`,
        );
      }
      if (manifest.minPreviousVersion && compareVersions(this.currentVersion, manifest.minPreviousVersion) < 0) {
        throw new UpdateErrorException(
          'min_previous_version',
          `current ${this.currentVersion} is below minPreviousVersion ${manifest.minPreviousVersion}; install an intermediate release first`,
        );
      }

      const startedAt = new Date().toISOString();
      this.store.update({
        applyInProgress: {
          fromVersion: this.currentVersion,
          toVersion: manifest.version,
          startedAt,
        },
      });

      try {
        const result = await applyUpdate({
          npmPackage: manifest.channels.npm.package,
          fromVersion: this.currentVersion,
          toVersion: manifest.version,
          npmExecutor: this.npmExecutor,
          ...(this.restart ? { restart: this.restart } : {}),
          timeoutMs: this.npmTimeoutMs,
        });
        // Success: clear progress + any prior error.
        this.store.update({
          applyInProgress: undefined,
          lastError: undefined,
        });
        return result;
      } catch (err) {
        const code = err instanceof UpdateErrorException ? err.code : 'apply_failed';
        const message = (err as Error).message;
        this.store.update({
          applyInProgress: undefined,
          lastError: { code, message, at: new Date().toISOString() },
        });
        throw err instanceof UpdateErrorException ? err : new UpdateErrorException('apply_failed', message);
      }
    } finally {
      this.applying = false;
    }
  }

  /** Start the daily-check timer. `start()` ensures we don't double-arm. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.check().catch((err) => log('scheduled check threw (should not happen): %s', (err as Error).message));
    }, this.checkIntervalMs);
    // Don't keep the event loop alive just for this timer.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Stop the daily-check timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Typed handler facade — mirrors `createTrustCircleHandlers` /
 * `createNatHandlers`. The local-UI ticket consumes these.
 */
export function createUpdateHandlers(service: UpdateService): UpdateHandlers {
  return {
    async getState() { return service.getState(); },
    async postApply() { return await service.apply(); },
    async getSettings() { return service.getSettings(); },
    async putSettings(body) { return await service.putSettings(body); },
  };
}

function resolveManifestUrl(explicit: string | undefined, fromSettings: string | undefined): string {
  // Env var wins — operators routinely point this at staging endpoints, and
  // both the README and host.ts documentation promise that behavior.
  // Then explicit constructor arg → persisted settings → compiled default.
  const envUrl = process.env.CADRE_HOST_UPDATE_MANIFEST_URL?.trim();
  if (envUrl) return envUrl;
  return explicit ?? fromSettings ?? DEFAULT_MANIFEST_URL;
}

export type { UpdateState, UpdateApplyResult, UpdateSettings, UpdateManifest, SignedManifest } from './types.js';
export { UpdateErrorException, type UpdateErrorCode } from './types.js';
export { compareVersions, parseVersion } from './version.js';
export { fetchManifest, verifyManifest, canonicalJson, signManifestForTesting } from './manifest.js';
export { UpdateStateStore } from './store.js';
export { applyUpdate, defaultNpmExecutor, type NpmExecutor, type ServiceRestarter } from './apply.js';
export { getReleasePublicKey, getReleasePublicKeyBase64, ed25519FromRaw } from './release-key.js';
