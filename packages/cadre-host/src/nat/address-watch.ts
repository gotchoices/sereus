import debug from 'debug';

import type { ManagedNodeInfo } from '../orchestrator/types.js';

const log = debug('cadre:host:nat-address-watch');

/**
 * The shortest gap between two address restarts of one node. Bounds a flapping
 * router (a mapping that keeps failing and coming back) to one restart per node
 * per window; a difference found inside the window waits for the first check
 * after it ends.
 */
export const NAT_ADDRESS_RESTART_MIN_INTERVAL_MS = 10 * 60_000;

/** Asked to restart one node so it starts announcing its current public addresses. */
export type NodeAddressesStaleListener = (nodeId: string) => void | Promise<void>;

/**
 * Notices a running node whose announced public addresses differ from the ones
 * it should announce now, and asks its listeners to restart that node. A node
 * learns its public addresses only at start (`CADRE_APPEND_ANNOUNCE_ADDRS`), so
 * a restart is how a changed mapping, forward, DDNS hostname or external IP
 * reaches it.
 */
export class AddressWatch {
  private readonly listeners = new Set<NodeAddressesStaleListener>();
  /** When each node was last asked to restart (ms since epoch). */
  private readonly lastRestartAt = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  /** Register a restart listener. Returns an unsubscribe fn. */
  subscribe(listener: NodeAddressesStaleListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Compare every running node's announced addresses with `expected(node)`, as
   * sets, and ask for a restart of each that differs and was not restarted
   * within {@link NAT_ADDRESS_RESTART_MIN_INTERVAL_MS}.
   */
  check(nodes: ManagedNodeInfo[], expected: (node: ManagedNodeInfo) => string[]): void {
    this.forgetMissing(nodes);
    if (this.listeners.size === 0) return;
    for (const node of nodes) {
      if (node.status !== 'running') continue;
      if (sameAddressSet(node.announcedAddrs, expected(node))) continue;
      if (this.restartedRecently(node.id)) {
        log('node %s announces stale addresses; restart deferred by the rate limit', node.id);
        continue;
      }
      this.lastRestartAt.set(node.id, this.now());
      log('node %s announces stale addresses; asking for a restart', node.id);
      this.notify(node.id);
    }
  }

  /** A terminated node's id may come back as a fresh node, which owes nothing to the old window. */
  private forgetMissing(nodes: ManagedNodeInfo[]): void {
    const listed = new Set(nodes.map((n) => n.id));
    for (const id of this.lastRestartAt.keys()) {
      if (!listed.has(id)) this.lastRestartAt.delete(id);
    }
  }

  private restartedRecently(nodeId: string): boolean {
    const last = this.lastRestartAt.get(nodeId);
    return last !== undefined && this.now() - last < NAT_ADDRESS_RESTART_MIN_INTERVAL_MS;
  }

  /** Fire-and-forget: a restart takes seconds and must not hold up the NAT pass that found it. */
  private notify(nodeId: string): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(nodeId)).catch((err: unknown) => { logRestartFailure(nodeId, err); });
      } catch (err) {
        logRestartFailure(nodeId, err);
      }
    }
  }
}

function sameAddressSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((addr) => right.has(addr));
}

function logRestartFailure(nodeId: string, err: unknown): void {
  log('address restart of node %s failed: %s', nodeId, err instanceof Error ? err.message : String(err));
}
