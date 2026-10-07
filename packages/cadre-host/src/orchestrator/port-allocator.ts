import {
  allocatePortSet,
  releasePortSet,
  reservePortSet,
  type PortAllocator,
} from '@serfab/cadre-provider';

import type { NodePorts } from './types.js';

/**
 * Allocation order for a node's port set. A node already running keeps its
 * ports whatever this order says ({@link reusedNodePorts}); the order decides
 * only where a fresh allocation lands.
 */
const NODE_PORT_KEYS = ['health', 'metrics', 'p2p', 'ws'] as const satisfies readonly (keyof NodePorts)[];

/**
 * Allocate a full NodePorts set atomically, in {@link NODE_PORT_KEYS} order.
 * `overrides` supply a port instead of allocating one (a re-spawn's previous
 * ports, see {@link reusedNodePorts}). Overrides are reserved before anything is allocated
 * and are trusted, not checked — see `allocatePortSet`.
 */
export function allocateNodePorts(
  allocator: PortAllocator,
  overrides?: Partial<NodePorts>,
): NodePorts {
  return allocatePortSet(allocator, NODE_PORT_KEYS, overrides);
}

/**
 * Hold a node's whole port set against `allocator` — the inverse of
 * {@link releaseNodePorts}. A key the set lacks is skipped (see `markUsed`).
 */
export function reserveNodePorts(allocator: PortAllocator, ports: NodePorts): void {
  reservePortSet(allocator, NODE_PORT_KEYS, ports);
}

/**
 * Give a node's whole port set back to `allocator`. A key the set lacks releases
 * nothing: deleting a value the used-set never held is a no-op.
 */
export function releaseNodePorts(allocator: PortAllocator, ports: NodePorts): void {
  releasePortSet(allocator, NODE_PORT_KEYS, ports);
}

/**
 * The ports a re-spawn comes back on: the set the dropped handle held, as
 * {@link allocateNodePorts} overrides. `{}` when nothing was dropped (a first
 * spawn, or a handle lost along with `state.json`), so every port is allocated
 * fresh.
 *
 * Why a re-spawn must not simply take the lowest free ports: an owner with no
 * address of its own (a phone) reaches a hosted node only by dialing the address
 * it scanned, so a node that comes back on a different port is one that owner
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
