import type { DirectReachability, PortForwardMode } from './types.js';

export interface ReachabilityInput {
  portMode: PortForwardMode;
  cgnatDetected: boolean;
}

/**
 * v1 reachability heuristic.
 *
 * Returns:
 *   - 'cgnat' when CGNAT was detected (highest signal — UPnP succeeded but our
 *     external IP isn't actually reachable from the open internet).
 *   - 'unreachable' when port mapping failed.
 *   - 'reachable' when an auto mapping succeeded.
 *   - 'unknown' otherwise (manual config, disabled UPnP, etc).
 *
 * A future ticket will replace this with libp2p AutoNAT or a sereus-owned
 * dial-back probe (see the follow-up section of `6.3-cadre-host-nat`).
 */
export function evaluateReachability(input: ReachabilityInput): DirectReachability {
  if (input.cgnatDetected) return 'cgnat';
  switch (input.portMode) {
    case 'auto-upnp':
    case 'auto-natpmp':
      return 'reachable';
    case 'failed':
      return 'unreachable';
    case 'manual':
    case 'disabled':
    default:
      return 'unknown';
  }
}
