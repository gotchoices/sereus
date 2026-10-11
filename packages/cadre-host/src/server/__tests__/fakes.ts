/**
 * Shared fakes for the local-UI server tests. Holds no tests of its own.
 */

import type { NatService, NatChangeListener } from '../../nat/index.js';
import type { NatStatusSnapshot } from '../../nat/types.js';

export const SAMPLE_CONNECTIVITY: NatStatusSnapshot = {
  network: { setting: 'auto', mode: 'lan', publicInterfaceIp: null },
  upnpEnabled: true,
  gateway: { found: true, lanAddress: '192.168.1.20', routerExternalIp: '203.0.113.5', lastError: null },
  externalIp: '203.0.113.5',
  externalIpDetectedAt: null,
  cgnatDetected: false,
  directReachability: 'reachable',
  lastTestedAt: null,
  ddns: {
    providerId: null,
    hostname: null,
    externallyManaged: false,
    lastUpdateAt: null,
    lastUpdateOk: null,
    lastError: null,
  },
  nodes: [],
};

/**
 * A NAT service that answers only the reads the server makes on its own
 * (status, boot publish) and the writes the settings route forwards. `emit`
 * fires the change listeners the server registered, for tests of that wiring.
 */
export function fakeNat(snapshot: NatStatusSnapshot = SAMPLE_CONNECTIVITY): NatService & { emit(snap: NatStatusSnapshot): void } {
  const listeners = new Set<NatChangeListener>();
  return {
    getStatus: () => snapshot,
    onChange: (listener: NatChangeListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    putSettings: async () => snapshot,
    emit: (snap: NatStatusSnapshot) => { for (const l of listeners) l(snap); },
  } as unknown as NatService & { emit(snap: NatStatusSnapshot): void };
}
