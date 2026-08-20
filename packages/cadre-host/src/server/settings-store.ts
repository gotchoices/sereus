/**
 * Settings store — read-write facade around `host.config.json` for the
 * /api/settings route.
 *
 * The installer (`6.4.1`) owns the schema (`HostConfigFile` v2). This module
 * just delegates load/persist to that file's helpers; it exists so route
 * handlers can read/write without each one re-resolving `configPath(dataDir)`.
 *
 * PUT semantics live in routes/settings.ts; this class is purely an I/O
 * boundary so tests can swap it for an in-memory fake.
 */

import { configPath } from '../installer/paths.js';
import { readHostConfig, updateHostConfig, type HostConfigFile } from '../installer/config.js';

export interface HostSettingsStoreOptions {
  /** Resolved cadre-host data dir. */
  dataDir: string;
}

export class HostSettingsStore {
  private readonly configPath: string;

  constructor(opts: HostSettingsStoreOptions) {
    this.configPath = configPath(opts.dataDir);
  }

  // NOTE: a bad config (absent, malformed, wrong version) throws a plain Error, so
  // /api/settings answers 500 code "internal" with the read message passed through.
  // Fine while the UI just surfaces the text; if it ever needs to tell "your config
  // file is unreadable" apart from a genuine server bug, give this a typed error.
  /** Read the current host.config.json. Throws if absent, malformed, or not version 2. */
  read(): HostConfigFile {
    return readHostConfig(this.configPath);
  }

  /** Patch and persist. */
  update(patch: Partial<Omit<HostConfigFile, 'version'>>): HostConfigFile {
    return updateHostConfig(this.configPath, patch);
  }
}
