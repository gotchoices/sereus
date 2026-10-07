/**
 * Shared fakes for the local-UI server tests. Holds no tests of its own.
 */

import type { FounderServices } from '../index.js';
import type { NatService } from '../../nat/index.js';
import type { NatStatusSnapshot } from '../../nat/types.js';
import type { StrandService } from '../../strands/index.js';

export const SAMPLE_CONNECTIVITY: NatStatusSnapshot = {
  portMode: 'auto-upnp',
  externalPort: 4001,
  internalPort: 4001,
  routerExternalIp: '203.0.113.5',
  mappingLeaseExpiresAt: null,
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
};

/**
 * A founder-role service set whose members answer only the reads the server
 * makes on its own (status, boot publish): the sample connectivity, no
 * strands. Pass the service a test exercises as an override.
 */
export function fakeFounder(overrides: Partial<FounderServices> = {}): FounderServices {
  return {
    nat: { getStatus: () => SAMPLE_CONNECTIVITY } as unknown as NatService,
    strands: { list: async () => ({ strands: [], controlConnections: 0 }) } as unknown as StrandService,
    ...overrides,
  };
}
