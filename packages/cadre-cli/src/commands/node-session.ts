import debug from 'debug';
import { CadreNode, type CadreNodeConfig, type StorageConfig } from '@serfab/cadre-core';
import { memoryNodeStorage, type NodeStorage, type OpenNodeStorage } from '@optimystic/db-p2p';
import { fileNodeStorage } from '@optimystic/db-p2p-storage-fs';
import { resolveConfig, type ResolvedConfig } from '../config/index.js';
import { resolveNodeNetwork } from './node-network.js';
import { partyOnRecord } from './claim-record.js';
import { loadOwnerKeyFile } from './owner-key-file.js';

const log = debug('cadre:cli:node-session');

/** Default wait for `control:connected` before a one-shot command gives up. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * A node's storage as the CLI opens it: the cadre-core `StorageConfig` whose `open` opens one
 * scope's stores, and the `close` that releases them all.
 *
 * Named for the handle, not for what it holds: `NodeStorage` is Optimystic's type for one scope's
 * three stores (`StorageConfig.open`'s return), and two meanings of one name in one file is how a
 * later reader comes to pass the wrong thing.
 *
 * cadre-core never closes storage its `open` returned (`StorageConfig.open`, types.ts); the
 * embedder that opened it does. A file store left open holds its directory's `store.lock` for as
 * long as this process lives, so another process cannot open that directory, and its writes not
 * yet flushed are lost when the process exits.
 */
export interface NodeStorageHandle {
  /** What `CadreNodeConfig.storage` takes; undefined when the config has no `storage` block. */
  readonly config: StorageConfig | undefined;
  /**
   * Flush and close every scope's stores. Call it after the node using them has stopped; an
   * `open` called afterwards opens that scope's stores again.
   */
  close(): Promise<void>;
}

/**
 * Convert CLI storage config to cadre-core's `StorageConfig`, and the handle that closes what its
 * `open` opened.
 *
 * Shared by every command that constructs a `CadreNode` — the long-running `start` and the
 * one-shot commands alike — so the memory/file mapping has exactly one home.
 *
 * The file branch maps a cadre-core storage scope key straight onto a subdirectory of
 * `storage.path`: the strand id for each strand, `controlStorageScope(partyId)` for the
 * control database. Every key cadre-core mints is within `[a-z0-9._-]`, so it is safe
 * as a path segment as-is — which is also why a party id containing `/` or `..` can no
 * longer escape this directory — and, having no uppercase, two keys never land in one
 * directory on a filesystem that ignores case. Two config files naming two parties over
 * one `storage.path` therefore get two control directories (`control-<hex party id>`)
 * rather than sharing one.
 *
 * The memory branch calls `memoryNodeStorage()`, which is how a host says it meant memory:
 * Optimystic warns on an ABSENT storage option, not on stores that happen to be in memory. It
 * declares no allotment — nothing measures a memory store's free space, so a memory node measures
 * nothing, which is what a throwaway node should do.
 */
export function openNodeStorage(config: ResolvedConfig['storage']): NodeStorageHandle {
  if (config?.type === 'memory') {
    return storagePerScope(() => memoryNodeStorage(), undefined);
  }

  if (config?.type === 'file') {
    if (!config.path) {
      throw new Error('Storage path is required for file storage type');
    }
    const basePath = config.path;
    return storagePerScope((scope) => fileNodeStorage(`${basePath}/${scope}`), config.allotmentBytes);
  }

  return { config: undefined, close: async () => {} };
}

/**
 * {@link openNodeStorage}'s shape either way: one `OpenNodeStorage` per scope, opened on first ask
 * and closed by {@link NodeStorageHandle.close}.
 *
 * The memo is no longer the only thing keeping two sets of stores off one location — `fileNodeStorage`
 * hands back one set per directory per process, counted by holder, and `memoryNodeStorage` has no
 * location to share. It stays because it is what `close` iterates, and because a memoized memory
 * scope is what lets a node stopped and started in one process read back what it wrote.
 *
 * `openScope` is synchronous, as every storage-package factory is, so two concurrent first asks for
 * one scope cannot both open it.
 */
function storagePerScope(
  openScope: (scope: string) => OpenNodeStorage,
  allotmentBytes: number | undefined,
): NodeStorageHandle {
  const opened = new Map<string, OpenNodeStorage>();
  // NOTE: an entry is kept after a `stopStrand`, because cadre-core may ask for that scope again
  // and `close` must still reach it. On a file store the holder is the point — the process owns
  // the directory and its lock. On a memory store it means a process that launches and stops many
  // strands keeps every one's blocks until exit; harmless while memory storage is for tests and
  // throwaway nodes, so if a long-lived memory node ever churns strands, drop an entry whose scope
  // cadre-core has stopped.
  const open = async (scope: string): Promise<NodeStorage> => {
    let storage = opened.get(scope);
    if (!storage) {
      storage = openScope(scope);
      opened.set(scope, storage);
    }
    return storage;
  };
  const close = async (): Promise<void> => {
    const held = [...opened.values()];
    opened.clear();
    await Promise.all(held.map((storage) => storage.close()));
  };
  return {
    config: { open, ...(allotmentBytes !== undefined && { allotmentBytes }) },
    close,
  };
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
 *
 * The `network` block is resolved exactly as `cadre start` resolves it (`node-network.ts`), so a
 * one-shot command dials the same way the long-running node does — which is also what makes a
 * misconfigured `network.webrtc` fail the first command an operator runs rather than only the
 * start. Async for that resolution alone.
 */
export async function oneShotNodeConfig(
  config: ResolvedConfig,
  partyId: string,
  storage: NodeStorageHandle,
): Promise<CadreNodeConfig> {
  return {
    privateKey: config.privateKey,
    controlNetwork: { ...config.controlNetwork, partyId },
    nodeClass: config.nodeClass,
    roles: config.roles,
    strandFilter: config.strandFilter,
    storage: storage.config,
    network: await resolveNodeNetwork(config.network),
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
  // Read before the node starts, so an owner key file that cannot be read fails the command first.
  const ownerSigner = await loadOwnerKeyFile(config.ownerKeyFile);
  const storage = openNodeStorage(config.storage);
  const node = new CadreNode(await oneShotNodeConfig(config, partyId, storage));

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
    // node's owner signer: the owner key file's key, wired when the party lists it. Without the
    // file, or when its key is not an owner here, the node is left unwired and its owner writes
    // refuse. Never the identity key (`wireOwnKeyIfOwner`'s default without a signer).
    if (ownerSigner) await node.wireOwnKeyIfOwner(ownerSigner);
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
