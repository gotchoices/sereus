/**
 * Host-port tracking shared by the orchestrators that hand out ports from a
 * bounded range (this package's `DockerOrchestrator`, cadre-host's
 * `HostProcessOrchestrator`).
 */

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
 * Allocate one port per key atomically, in `keys` order — a mid-way failure (an
 * exhausted range) releases everything already taken rather than stranding the
 * ports it got before the throw. `overrides` supply a port instead of allocating
 * one (in cadre-host: the owner node's p2p port, fixed by NAT config, and a
 * re-spawn's previous ports).
 *
 * Overrides are reserved FIRST, before any allocation, so an override that
 * happens to sit inside the managed range cannot also be handed out to another
 * key. Reserving is `markUsed`, a documented no-op outside the range — which is
 * the production case for cadre-host's owner `libp2pPort`, and why reserving
 * first leaves every real port assignment unchanged.
 *
 * NOTE: an override is trusted, not checked — `markUsed` does not refuse a port
 * another holder already has, nor two keys naming the same port. Safe for
 * today's callers: a cadre-host re-spawn's overrides were released by its own
 * handle drop with no `await` in between, and the owner's `libp2pPort` can only
 * collide if an operator configures it inside the range onto a port a node
 * already holds. If a caller ever passes ports it did not just release, refuse an
 * override that `allocator.has()` or that repeats another key's port.
 */
export function allocatePortSet<K extends string>(
  allocator: PortAllocator,
  keys: readonly K[],
  overrides?: Partial<Record<K, number>>,
): Record<K, number> {
  const reserved: number[] = [];
  const ports: Partial<Record<K, number>> = {};
  try {
    for (const key of keys) {
      const override = overrides?.[key];
      if (override === undefined) continue;
      allocator.markUsed(override);
      reserved.push(override);
      ports[key] = override;
    }
    for (const key of keys) {
      if (ports[key] !== undefined) continue;
      const port = allocator.allocate();
      reserved.push(port);
      ports[key] = port;
    }
  } catch (err) {
    for (const port of reserved) allocator.release(port);
    throw err;
  }
  return ports as Record<K, number>;
}

/**
 * Hold a whole port set against `allocator` — the inverse of
 * {@link releasePortSet}. A key the set lacks is skipped (see `markUsed`).
 */
export function reservePortSet<K extends string>(
  allocator: PortAllocator,
  keys: readonly K[],
  ports: Record<K, number>,
): void {
  for (const key of keys) allocator.markUsed(ports[key]);
}

/**
 * Give a whole port set back to `allocator`. A key the set lacks releases
 * nothing: deleting a value the used-set never held is a no-op.
 */
export function releasePortSet<K extends string>(
  allocator: PortAllocator,
  keys: readonly K[],
  ports: Record<K, number>,
): void {
  for (const key of keys) allocator.release(ports[key]);
}
