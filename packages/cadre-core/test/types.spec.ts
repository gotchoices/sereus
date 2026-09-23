import { describe, it, expect } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { DEFAULT_CONNECTION_MONITOR } from '../src/types.js';
import type {
  CadreNodeConfig,
  StrandFilter,
  StrandInstance,
  StrandRow,
  NodeProfile,
  LatencyHint
} from '../src/types.js';

describe('Types', () => {
  describe('CadreNodeConfig', () => {
    it('should allow minimal configuration', () => {
      const config: CadreNodeConfig = {
        controlNetwork: {
          partyId: 'test-party-id',
          bootstrapNodes: []
        },
        profile: 'transaction'
      };

      expect(config.controlNetwork.partyId).toBe('test-party-id');
      expect(config.profile).toBe('transaction');
      expect(config.strandFilter).toBeUndefined();
    });

    it('should allow full configuration', async () => {
      const privateKey = await generateKeyPair('Ed25519');
      const config: CadreNodeConfig = {
        privateKey,
        controlNetwork: {
          partyId: 'test-party-id',
          bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/QmTest']
        },
        profile: 'storage',
        strandFilter: { mode: 'all' },
        storage: {
          provider: () => new MemoryRawStorage(),
          quotaBytes: 1024 * 1024 * 1024
        },
        network: {
          listenAddrs: ['/ip4/0.0.0.0/tcp/4001'],
          announceAddrs: ['/ip4/1.2.3.4/tcp/4001'],
          appendAnnounceAddrs: ['/dns4/mynode.example.com/tcp/4001'],
          relayAddrs: []
        },
        hibernation: {
          enabled: true,
          defaultLatencyHint: 'interactive'
        },
        strandWatchInterval: 10000
      };

      expect(config.privateKey).toBe(privateKey);
      expect(config.profile).toBe('storage');
      expect(config.storage?.provider).toBeDefined();
      expect(config.hibernation?.enabled).toBe(true);
    });
  });

  describe('StrandFilter', () => {
    it('should support all filter modes', () => {
      const allFilter: StrandFilter = { mode: 'all' };
      const noneFilter: StrandFilter = { mode: 'none' };
      const sAppIdFilter: StrandFilter = { mode: 'sAppId', sAppId: 'app123' };
      const strandIdFilter: StrandFilter = { mode: 'strandId', strandId: 'strand456' };

      expect(allFilter.mode).toBe('all');
      expect(noneFilter.mode).toBe('none');
      expect(sAppIdFilter.mode).toBe('sAppId');
      expect((sAppIdFilter as { mode: 'sAppId'; sAppId: string }).sAppId).toBe('app123');
      expect(strandIdFilter.mode).toBe('strandId');
    });
  });

  describe('StrandRow', () => {
    it('should represent control network strand data', () => {
      const openStrand: StrandRow = {
        Id: 'strand-123',
        MemberPrivateKey: null,
        Type: 'o',
        FounderOwnerKey: null
      };

      const closedStrand: StrandRow = {
        Id: 'strand-456',
        MemberPrivateKey: 'private-key-data',
        Type: 'c',
        FounderOwnerKey: null
      };

      expect(openStrand.Type).toBe('o');
      expect(openStrand.MemberPrivateKey).toBeNull();
      expect(closedStrand.Type).toBe('c');
      expect(closedStrand.MemberPrivateKey).toBe('private-key-data');
    });
  });

  describe('StrandInstance', () => {
    it('should track strand instance state', () => {
      const instance: StrandInstance = {
        strandId: 'strand-789',
        status: 'active',
        connectedPeers: 5,
        lastActivity: new Date(),
        latencyHint: 'interactive'
      };

      expect(instance.strandId).toBe('strand-789');
      expect(instance.status).toBe('active');
      expect(instance.connectedPeers).toBe(5);
      expect(instance.latencyHint).toBe('interactive');
    });

    it('should support all status values', () => {
      const statuses: StrandInstance['status'][] = [
        'starting', 'active', 'idle', 'hibernating', 'stopping', 'stopped', 'error'
      ];

      for (const status of statuses) {
        const instance: StrandInstance = {
          strandId: 'test',
          status,
          connectedPeers: 0,
          lastActivity: new Date(),
          latencyHint: 'background'
        };
        expect(instance.status).toBe(status);
      }
    });
  });

  describe('NodeProfile', () => {
    it('should support transaction and storage profiles', () => {
      const txProfile: NodeProfile = 'transaction';
      const storageProfile: NodeProfile = 'storage';

      expect(txProfile).toBe('transaction');
      expect(storageProfile).toBe('storage');
    });
  });

  describe('LatencyHint', () => {
    it('should support all latency hint values', () => {
      const hints: LatencyHint[] = ['realtime', 'interactive', 'background', 'archive'];

      for (const hint of hints) {
        expect(['realtime', 'interactive', 'background', 'archive']).toContain(hint);
      }
    });
  });

  /**
   * The one relationship between these two numbers that cannot be read off either of
   * them. libp2p's connection monitor opens a ping stream per connection per
   * `pingInterval` whether or not the previous ping has answered, and `@libp2p/ping`
   * registers `/ipfs/ping/1.0.0` with `maxOutboundStreams: 1` — so a deadline that
   * outlives the interval makes the second ping fail with
   * `TooManyOutboundProtocolStreamsError`, which the monitor treats exactly like a
   * timeout and aborts the healthy connection. Widening the deadline without widening
   * the interval is therefore a fix that does nothing past 10 seconds, which is the bug
   * this default exists to avoid. `maxTimeout` is the bound that matters because libp2p
   * 3.3 lets the deadline climb toward it.
   */
  describe('DEFAULT_CONNECTION_MONITOR', () => {
    it('keeps the ping interval above the longest ping deadline it allows', () => {
      expect(DEFAULT_CONNECTION_MONITOR.pingInterval)
        .toBeGreaterThan(DEFAULT_CONNECTION_MONITOR.pingTimeout.maxTimeout);
      expect(DEFAULT_CONNECTION_MONITOR.pingTimeout.maxTimeout)
        .toBeGreaterThanOrEqual(DEFAULT_CONNECTION_MONITOR.pingTimeout.minTimeout);
    });
  });
});
