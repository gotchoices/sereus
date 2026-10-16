import debug from 'debug';
import { CadreNode, type CadreNodeConfig, type StorageConfig } from '@serfab/cadre-core';
import { nodeDefaultTransports } from '@serfab/cadre-core/node-default-transports';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { resolveConfig, type ResolvedConfig } from '../config/index.js';
import { partyOnRecord } from './claim-record.js';

const log = debug('cadre:cli:node-session');

/** Default wait for `control:connected` before a one-shot command gives up. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * A node's raw storage as the CLI opens it: the cadre-core `StorageConfig` whose provider
 * opens the stores, and the `close` that releases them.
 *
 * cadre-core never closes a store its provider returned (`RawStorageProvider`, types.ts);
 * the embedder that built it does. A `FileRawStorage` left open holds its directory's
 * `store.lock` for as long as this process lives, so another process cannot open that
 * directory, and its writes not yet flushed are lost when the process exits.
 */
export interface NodeStorage {
  /** What `CadreNodeConfig.storage` takes; undefined when the config has no `storage` block. */
  readonly config: StorageConfig | undefined;
  /**
   * Flush and close every store the provider has opened. Call it after the node using them
   * has stopped; a provider called afterwards opens its stores again.
   */
  close(): Promise<void>;
}

/**
 * Convert CLI storage config to cadre-core StorageConfig with provider, and the handle that
 * closes what the provider opens.
 *
 * Shared by every command that constructs a `CadreNode` — the long-running `start` and the
 * one-shot commands alike — so the memory/file provider mapping has exactly one home.
 *
 * The file provider opens one `FileRawStorage` per scope and hands the same one back when
 * cadre-core calls it again for that scope (after a `stopStrand`, or a node restart), so
 * each directory has one store to close.
 *
 * The file provider maps a cadre-core storage scope key straight onto a subdirectory of
 * `storage.path`: the strand id for each strand, `controlStorageScope(partyId)` for the
 * control database. Every key cadre-core mints is within `[a-z0-9._-]`, so it is safe
 * as a path segment as-is — which is also why a party id containing `/` or `..` can no
 * longer escape this directory — and, having no uppercase, two keys never land in one
 * directory on a filesystem that ignores case. Two config files naming two parties over
 * one `storage.path` therefore get two control directories (`control-<hex party id>`)
 * rather than sharing one.
 */
export function openNodeStorage(config: ResolvedConfig['storage']): NodeStorage {
  if (config?.type === 'memory') {
    return {
      config: { provider: () => new MemoryRawStorage(), quotaBytes: config.quotaBytes },
      close: async () => {},
    };
  }

  if (config?.type === 'file') {
    if (!config.path) {
      throw new Error('Storage path is required for file storage type');
    }
    return openFileStorage(config.path, config.quotaBytes);
  }

  return { config: undefined, close: async () => {} };
}

/** {@link openNodeStorage}'s file branch: one `FileRawStorage` per scope under `path`. */
function openFileStorage(path: string, quotaBytes: number | undefined): NodeStorage {
  const stores = new Map<string, FileRawStorage>();
  const provider = (scope: string): FileRawStorage => {
    let store = stores.get(scope);
    if (!store) {
      store = new FileRawStorage(`${path}/${scope}`);
      stores.set(scope, store);
    }
    return store;
  };
  const close = async (): Promise<void> => {
    const open = [...stores.values()];
    stores.clear();
    await Promise.all(open.map((store) => store.close()));
  };
  return { config: { provider, quotaBytes }, close };
}

/**
 * The `CadreNodeConfig` a one-shot command needs: enough to join the control network and
 * read/write control state, and nothing more.
 *
 * Deliberately narrower than `start`'s config — no trusted-owner anchor, bootstrap-peer
 * store, seed-trust policy, or push notifier. Those exist to shape a node's long-running
 * behaviour (which seeds it accepts, whom it wakes); a command that connects, performs one
 * control-database operation and exits never reaches them.
 *
 * `partyId` is the party the node serves, which on a claimed node is the claim record's rather
 * than the config's placeholder (`partyOnRecord`), so it is passed in rather than read off the
 * config.
 */
export function oneShotNodeConfig(config: ResolvedConfig, partyId: string, storage: NodeStorage): CadreNodeConfig {
  return {
    privateKey: config.privateKey,
    controlNetwork: { ...config.controlNetwork, partyId },
    profile: config.profile,
    strandFilter: config.strandFilter,
    storage: storage.config,
    network: { ...config.network, defaultTransports: nodeDefaultTransports },
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
 * stopped, then its storage closed, in a `finally` so a throwing action still tears down.
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
  // A claimed node serves the party on record, not its config's placeholder (`claim-record.ts`).
  const { partyId } = await partyOnRecord(config);
  const storage = openNodeStorage(config.storage);
  const node = new CadreNode(oneShotNodeConfig(config, partyId, storage));

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
    // The owner-signed commands (`strand remove`, `validation-key add|remove`) sign through the
    // node's owner signer, so a node whose identity key is a live owner gets it wired here; any
    // other node is left unwired and its owner writes refuse.
    await node.wireOwnKeyIfOwner();
    await action(node);
  } finally {
    clearTimeout(timer);
    // Never mask the action's error with a teardown failure, but never swallow it silently.
    await node.stop().catch((error: unknown) => {
      log('Error stopping node after command: %o', error);
      console.error('Warning: node did not shut down cleanly:', error instanceof Error ? error.message : error);
    });
    await storage.close().catch((error: unknown) => {
      log('Error closing storage after command: %o', error);
      console.error('Warning: storage did not close cleanly:', error instanceof Error ? error.message : error);
    });
  }
}
