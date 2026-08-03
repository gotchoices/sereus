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

  /** Used during restart rehydration to reserve ports already in use. */
  markUsed(port: number): void {
    if (port < this.start || port > this.end) {
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
 * already handed out.
 */
const NODE_PORT_KEYS = ['health', 'metrics', 'p2p', 'admin'] as const;

/**
 * Allocate a full NodePorts set atomically — a mid-way failure (an exhausted
 * range) releases everything already taken rather than stranding the ports it
 * got before the throw. `overrides` supply a port instead of allocating one
 * (the owner node's p2p port, which is fixed by NAT config).
 *
 * Overrides are reserved FIRST, before any allocation, so an override that
 * happens to sit inside the managed range cannot also be handed out to another
 * key. Reserving is `markUsed`, a documented no-op outside the range — which is
 * the production case for the owner node's libp2p port, and why reserving first
 * leaves every real port assignment unchanged.
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
