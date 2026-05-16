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
