import debug from 'debug';
import { CadreNode, type CadreNodeConfig, type StorageConfig } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { resolveConfig, type ResolvedConfig } from '../config/index.js';

const log = debug('cadre:cli:node-session');

/** Default wait for `control:connected` before a one-shot command gives up. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Convert CLI storage config to cadre-core StorageConfig with provider.
 *
 * Shared by every command that constructs a `CadreNode` — the long-running `start` and the
 * one-shot commands alike — so the memory/file provider mapping has exactly one home.
 */
export function resolveStorageConfig(config: ResolvedConfig['storage']): StorageConfig | undefined {
  if (!config) return undefined;

  if (config.type === 'memory') {
    return {
      provider: () => new MemoryRawStorage(),
      quotaBytes: config.quotaBytes,
    };
  }

  if (config.type === 'file') {
    if (!config.path) {
      throw new Error('Storage path is required for file storage type');
    }
    return {
      provider: (strandId: string) => new FileRawStorage(`${config.path}/${strandId}`),
      quotaBytes: config.quotaBytes,
    };
  }

  return undefined;
}

/**
 * The `CadreNodeConfig` a one-shot command needs: enough to join the control network and
 * read/write control state, and nothing more.
 *
 * Deliberately narrower than `start`'s config — no trusted-owner anchor, bootstrap-peer
 * store, seed-trust policy, or push notifier. Those exist to shape a node's long-running
 * behaviour (which seeds it accepts, whom it wakes); a command that connects, performs one
 * control-database operation and exits never reaches them.
 */
export function oneShotNodeConfig(config: ResolvedConfig): CadreNodeConfig {
  return {
    privateKey: config.privateKey,
    controlNetwork: config.controlNetwork,
    profile: config.profile,
    strandFilter: config.strandFilter,
    storage: resolveStorageConfig(config.storage),
    network: config.network,
    hibernation: config.hibernation,
    strandWatchInterval: config.strandWatchInterval,
  };
}

/**
 * Run one action against a connected cadre node, then shut down.
 *
 * The shape every one-shot command shares: resolve the config file, construct a
 * `CadreNode`, wait for `control:connected` (bounded), act, stop. The handler is registered
 * BEFORE `start()` so a connection that lands during startup is not missed, and the node is
 * stopped in a `finally` so a throwing action still tears down.
 *
 * Errors propagate to the caller, which is responsible for reporting and the exit code —
 * this helper never calls `process.exit`.
 */
export async function withConnectedNode(
  configPath: string,
  action: (node: CadreNode) => Promise<void>,
  timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS
): Promise<void> {
  const config = await resolveConfig(configPath);
  const node = new CadreNode(oneShotNodeConfig(config));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const connected = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms connecting to the control network`)),
      timeoutMs
    );
    node.on('control:connected', () => {
      log('Connected to control network');
      resolve();
    });
  });

  try {
    // Awaited together, not in sequence: a `start()` that outlives the timer would leave the
    // timeout's rejection with no handler attached, and Node turns an unhandled rejection into
    // a process crash — losing the very message the timeout exists to print.
    await Promise.all([node.start(), connected]);
    await action(node);
  } finally {
    clearTimeout(timer);
    // Never mask the action's error with a teardown failure, but never swallow it silently.
    await node.stop().catch((error: unknown) => {
      log('Error stopping node after command: %o', error);
      console.error('Warning: node did not shut down cleanly:', error instanceof Error ? error.message : error);
    });
  }
}
