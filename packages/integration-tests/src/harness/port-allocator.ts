/**
 * Port allocator for integration tests.
 * 
 * Ensures each test gets unique ports to avoid conflicts,
 * even when tests run in sequence or parallel.
 */

// IMPORTANT:
// These integration tests are typically executed by Vitest using multiple workers.
// A per-process in-memory allocator cannot prevent cross-process port collisions.
//
// The most reliable approach is to request an ephemeral port from the OS by
// listening on port 0. Libp2p will bind an available port and report the actual
// listen multiaddrs after start.
const EPHEMERAL_PORT = 0;

// NOTE: `HostProcessOrchestrator` cannot use port 0 — it hands its children
// concrete health/metrics ports — so the child-process scenarios each hard-code
// a disjoint band by convention, and nothing enforces the split:
//   19600-19899  cadre-host-owner-node
//   19900-20039  cadre-host-node-donation (requester)
//   20040-20199  cadre-host-node-donation (donor)
//   20200-20339  provider-seed-accepted
// Disjoint today. If a new child-process scenario lands, or two of these ever
// run in the same worker window on overlapping ranges, move the claim into a
// single exported table here so the bands are allocated rather than remembered.

/**
 * Allocate a single available port
 */
export async function allocatePort(): Promise<number> {
  return EPHEMERAL_PORT;
}

/**
 * Allocate multiple contiguous-ish ports
 */
export async function allocatePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  
  for (let i = 0; i < count; i++) {
    ports.push(await allocatePort());
  }
  
  return ports;
}

/**
 * Release ports back to the pool
 */
export function releasePorts(ports: number[]): void {
  // noop - ports are ephemeral and managed by the OS
  void ports;
}

/**
 * Release all allocated ports (for cleanup)
 */
export function releaseAllPorts(): void {
  // noop - ports are ephemeral and managed by the OS
}

/**
 * Get count of currently allocated ports
 */
export function getAllocatedCount(): number {
  return 0;
}

