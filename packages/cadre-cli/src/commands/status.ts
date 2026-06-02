import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfigFile } from '../config/loader.js';
import {
  queryRuntime,
  buildStatusReport,
  formatStatusReport,
  type ConfigSummary,
} from './status-query.js';

/** Exit code emitted when no running node could be reached. */
const EXIT_UNREACHABLE = 3;

export const statusCommand = new Command('status')
  .description('Show cadre node configuration and live runtime status (reads the health /status endpoint)')
  .option('-c, --config <path>', 'Path to config file (YAML or JSON)', 'cadre.yaml')
  .option('--health-host <host>', 'Host of the running node\'s health server', 'localhost')
  .option('--health-port <port>', 'Port of the running node\'s health server (env: CADRE_HEALTH_PORT)', '8080')
  .option('--timeout <ms>', 'Live-query timeout in milliseconds', '2000')
  .option('--json', 'Output in JSON format ({ config, runtime: { reachable, ... } })')
  .action(async (options) => {
    // Static config summary is best-effort: a missing/unreadable config is
    // non-fatal (warn on stderr, skip the section) so an operator can still
    // query a node whose config file isn't on this machine.
    const configSummary = await loadConfigSummary(options.config, Boolean(options.json));

    // Resolve the health endpoint (mirrors start.ts's CADRE_HEALTH_PORT env).
    const healthPort = parseInt(process.env.CADRE_HEALTH_PORT ?? options.healthPort, 10);
    const url = `http://${options.healthHost}:${healthPort}/status`;
    const timeoutMs = parseInt(options.timeout, 10);

    const runtime = await queryRuntime(fetch, url, Number.isFinite(timeoutMs) ? timeoutMs : 2000);
    const report = buildStatusReport(configSummary, runtime);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatStatusReport(report));
    }

    // Non-zero exit when no node was reachable so scripts / container
    // healthchecks can branch on it; 0 when a live node answered.
    if (!runtime.reachable) {
      process.exit(EXIT_UNREACHABLE);
    }
  });

/**
 * Load the static config summary, tolerating a missing or unreadable file.
 * Returns null (and warns on stderr, unless `json`) rather than exiting, so the
 * live query always runs.
 */
async function loadConfigSummary(configPath: string, json: boolean): Promise<ConfigSummary | null> {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    if (!json) {
      console.warn(`Warning: config file not found at ${resolved} — skipping configuration summary.`);
    }
    return null;
  }

  try {
    const config = await loadConfigFile(configPath);
    return {
      config: configPath,
      partyId: config.controlNetwork.partyId,
      profile: config.profile,
      bootstrapNodes: config.controlNetwork.bootstrapNodes.length,
      strandFilter: config.strandFilter ?? 'all',
      hibernation: config.hibernation?.enabled ?? false,
    };
  } catch (err) {
    if (!json) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: failed to read config ${configPath}: ${message} — skipping configuration summary.`);
    }
    return null;
  }
}
