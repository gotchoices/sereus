import type { NodePorts } from './types.js';

/**
 * Range-based port tracker. Allocations are in-memory; on orchestrator
 * restart the caller rehydrates the used-set from persisted state via
 * `markUsed(port)` before serving new allocations.
 */
export class PortAllocator {
  private readonly usedPorts = new Set<number>();

  constructor(
    private readonly start: number,
    private readonly end: number,
  ) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
      throw new Error(`Invalid port range: ${start}..${end}`);
    }
  }

  allocate(): number {
    for (let port = this.start; port <= this.end; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    throw new Error(`No available ports in range ${this.start}..${this.end}`);
  }

  release(port: number): void {
    this.usedPorts.delete(port);
  }

  /**
   * Used during restart rehydration to reserve ports already in use. A no-op for a
   * port outside the range, and for a non-integer: a handle persisted by an older
   * build lacks the ports added since, and `undefined` must not enter the used-set.
   */
  markUsed(port: number): void {
    if (!Number.isInteger(port) || port < this.start || port > this.end) {
      return;
    }
    this.usedPorts.add(port);
  }

  has(port: number): boolean {
    return this.usedPorts.has(port);
  }
}

/**
 * Allocation order for a node's port set. Fixed so that swapping a caller onto
 * {@link allocateNodePorts} does not shift the ports an existing deployment
 * already handed out — which is also why a key added later goes on the end
 * (`ws` came after the first four).
 */
const NODE_PORT_KEYS = ['health', 'metrics', 'p2p', 'admin', 'ws'] as const;

/**
 * Allocate a full NodePorts set atomically — a mid-way failure (an exhausted
 * range) releases everything already taken rather than stranding the ports it
 * got before the throw. `overrides` supply a port instead of allocating one
 * (the owner node's p2p port, which is fixed by NAT config; a re-spawn's
 * previous ports, see {@link reusedNodePorts}).
 *
 * Overrides are reserved FIRST, before any allocation, so an override that
 * happens to sit inside the managed range cannot also be handed out to another
 * key. Reserving is `markUsed`, a documented no-op outside the range — which is
 * the production case for the owner node's libp2p port, and why reserving first
 * leaves every real port assignment unchanged.
 *
 * NOTE: an override is trusted, not checked — `markUsed` does not refuse a port
 * another handle already holds, nor two keys naming the same port. Safe for
 * today's callers: a re-spawn's overrides were released by its own handle drop
 * with no `await` in between, and the owner's `libp2pPort` can only collide if an
 * operator configures it inside the range onto a port a node already holds. If a
 * caller ever passes ports it did not just release, refuse an override that
 * `allocator.has()` or that repeats another key's port.
 */
export function allocateNodePorts(
  allocator: PortAllocator,
  overrides?: Partial<NodePorts>,
): NodePorts {
  const reserved: number[] = [];
  const ports: Partial<NodePorts> = {};
  try {
    for (const key of NODE_PORT_KEYS) {
      const override = overrides?.[key];
      if (override === undefined) continue;
      allocator.markUsed(override);
      reserved.push(override);
      ports[key] = override;
    }
    for (const key of NODE_PORT_KEYS) {
      if (ports[key] !== undefined) continue;
      const port = allocator.allocate();
      reserved.push(port);
      ports[key] = port;
    }
  } catch (err) {
    for (const port of reserved) allocator.release(port);
    throw err;
  }
  return ports as NodePorts;
}

/**
 * Hold a node's whole port set against `allocator` — the inverse of
 * {@link releaseNodePorts}. A key the set lacks is skipped (see `markUsed`).
 */
export function reserveNodePorts(allocator: PortAllocator, ports: NodePorts): void {
  for (const key of NODE_PORT_KEYS) allocator.markUsed(ports[key]);
}

/**
 * Give a node's whole port set back to `allocator`. A key the set lacks releases
 * nothing: deleting a value the used-set never held is a no-op.
 */
export function releaseNodePorts(allocator: PortAllocator, ports: NodePorts): void {
  for (const key of NODE_PORT_KEYS) allocator.release(ports[key]);
}

/**
 * The ports a re-spawn comes back on: the set the dropped handle held, as
 * {@link allocateNodePorts} overrides. `{}` when nothing was dropped (a first
 * spawn, or a handle lost along with `state.json`), so every port is allocated
 * fresh.
 *
 * Why a re-spawn must not simply take the lowest free ports: a requester with no
 * address of its own (a phone) reaches a lent node only by dialing the address it
 * was given, so a node that comes back on a different port is one that requester
 * can no longer find.
 *
 * A key the dropped handle lacks — `ws` on a handle persisted by an older build —
 * is left out, and so allocated fresh. When more than one handle was dropped (only
 * possible from a `state.json` that already held duplicates), the last one stored
 * wins and the others' ports stay released.
 */
export function reusedNodePorts(dropped: readonly { ports: NodePorts }[]): Partial<NodePorts> {
  const reused: Partial<NodePorts> = {};
  const previous = dropped[dropped.length - 1]?.ports;
  if (!previous) return reused;
  for (const key of NODE_PORT_KEYS) {
    const port = previous[key];
    if (Number.isInteger(port)) reused[key] = port;
  }
  return reused;
}
