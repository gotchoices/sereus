import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode } from '../src/cadre-node.js';
import { signSchema } from '../src/schema-verification.js';
import type { CadreNodeConfig, StrandRow, StrandConfig, SAppConfig, StrandInstance } from '../src/types.js';

describe('CadreNode', () => {
  let authorPrivateKey: string;
  let authorPublicKey: string;

  const testSchema = 'create table Test (id text primary key);';
  const testVersion = '1.0.0';

  beforeEach(() => {
    authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  // Helper to create test config
  function createConfig(overrides?: Partial<CadreNodeConfig>): CadreNodeConfig {
    return {
      controlNetwork: {
        partyId: 'test-party-' + Math.random().toString(36).slice(2),
        bootstrapNodes: []
      },
      profile: 'transaction',
      ...overrides
    };
  }

  // Helper to create test strand rows
  function createStrandRow(id: string): StrandRow {
    return { Id: id, MemberPrivateKey: null, Type: 'o' };
  }

  // Helper to create test sApp config with real signature
  function createSAppConfig(): SAppConfig {
    return {
      id: authorPublicKey,
      version: testVersion,
      schema: testSchema,
      signature: signSchema(testSchema, testVersion, authorPrivateKey)
    };
  }

  // Helper to create full strand config
  function createStrandConfig(strandId: string): StrandConfig {
    return {
      strandRow: createStrandRow(strandId),
      sAppConfig: createSAppConfig()
    };
  }

  describe('constructor', () => {
    it('should create a node with minimal config', () => {
      const config = createConfig();
      const node = new CadreNode(config);

      expect(node.isRunning).toBe(false);
      expect(node.peerId).toBeUndefined();
    });

    it('should create a node with full config', () => {
      const config = createConfig({
        profile: 'storage',
        strandFilter: { mode: 'all' },
        storage: { type: 'memory' },
        hibernation: { enabled: true, defaultLatencyHint: 'interactive' },
        strandWatchInterval: 10000
      });

      const node = new CadreNode(config);
      expect(node.isRunning).toBe(false);
    });
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop successfully', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      await node.start();

      expect(node.isRunning).toBe(true);
      expect(node.peerId).toBeDefined();
      expect(node.getControlNode()).toBeDefined();

      await node.stop();

      expect(node.isRunning).toBe(false);
    }, 30000);

    it('should handle multiple start calls', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      await node.start();
      await node.start(); // Should not throw

      expect(node.isRunning).toBe(true);

      await node.stop();
    }, 30000);

    it('should handle multiple stop calls', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      await node.start();
      await node.stop();
      await node.stop(); // Should not throw

      expect(node.isRunning).toBe(false);
    }, 30000);
  });

  describe('strand management', () => {
    it('should manually add and remove strands', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      await node.start();

      const strandConfig = createStrandConfig('manual-strand');
      const instance = await node.addStrand(strandConfig);

      expect(instance.strandId).toBe('manual-strand');
      expect(instance.sAppInfo).toBeDefined();
      expect(instance.sAppInfo?.id).toBe(authorPublicKey);
      expect(node.getStrand('manual-strand')).toBeDefined();
      expect(node.getStrands().size).toBe(1);

      // Should be able to get sApp config
      expect(node.getSAppConfig('manual-strand')).toBeDefined();
      expect(node.getSAppId('manual-strand')).toBe(authorPublicKey);

      await node.removeStrand('manual-strand');

      expect(node.getStrand('manual-strand')).toBeUndefined();
      expect(node.getStrands().size).toBe(0);
      expect(node.getSAppConfig('manual-strand')).toBeUndefined();

      await node.stop();
    }, 60000);

    it('should cold-start a strand without an explicit mode (empty cohort → bootstrap)', async () => {
      // Solo cold-start parity: a fresh node has no CadrePeer rows, so addStrand
      // with no `mode` should infer `bootstrap` and still produce a working
      // instance — no explicit mode required for a single-device cadre.
      const config = createConfig();
      const node = new CadreNode(config);

      await node.start();

      const strandConfig = createStrandConfig('cold-start-strand');
      expect(strandConfig.mode).toBeUndefined();

      const instance = await node.addStrand(strandConfig);

      expect(instance.status).toBe('active');
      expect(node.getStrand('cold-start-strand')).toBeDefined();

      await node.stop();
    }, 60000);

    it('should reject strand operations when not running', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      await expect(node.addStrand(createStrandConfig('test'))).rejects.toThrow('not running');
    });
  });

  describe('events', () => {
    it('should emit control:connected on start', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      let connected = false;
      node.on('control:connected', () => { connected = true; });

      await node.start();

      expect(connected).toBe(true);

      await node.stop();
    }, 30000);

    it('should emit control:disconnected on stop', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      let disconnected = false;
      node.on('control:disconnected', () => { disconnected = true; });

      await node.start();
      await node.stop();

      expect(disconnected).toBe(true);
    }, 30000);

    it('should emit strand:started when strand added', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      let startedId: string | null = null;
      node.on('strand:started', (data) => { startedId = data.strandId; });

      await node.start();
      await node.addStrand(createStrandConfig('event-strand'));

      expect(startedId).toBe('event-strand');

      await node.stop();
    }, 60000);

    it('should emit strand:stopped when strand removed', async () => {
      const config = createConfig();
      const node = new CadreNode(config);

      let stoppedId: string | null = null;
      node.on('strand:stopped', (data) => { stoppedId = data.strandId; });

      await node.start();
      await node.addStrand(createStrandConfig('strand-to-stop'));
      await node.removeStrand('strand-to-stop');

      expect(stoppedId).toBe('strand-to-stop');

      await node.stop();
    }, 60000);
  });

  describe('hibernation orchestration', () => {
    it('hibernate quiesces, wake resumes with a freshly re-resolved cohort seed', async () => {
      const node = new CadreNode(createConfig());

      // A live (post-launch) strand instance the fake manager hands back. The
      // fake quiesce/resume mutate it the way the real StrandInstanceManager does.
      const instance: StrandInstance = {
        strandId: 'hib-strand',
        status: 'active',
        sAppInfo: { id: 'app', version: '1.0.0', schema: '' },
        connectedPeers: 3,
        lastActivity: new Date(0),
        latencyHint: 'interactive',
        libp2pNode: {} as never,
        database: {} as never
      };

      const quiesceCalls: string[] = [];
      const resumeCalls: Array<{ id: string; overrides: unknown }> = [];
      const fakeManager = {
        getInstance: (id: string) => (id === 'hib-strand' ? instance : undefined),
        quiesceStrand: async (id: string) => {
          quiesceCalls.push(id);
          instance.libp2pNode = undefined;
          instance.database = undefined;
          instance.connectedPeers = 0;
        },
        resumeStrand: async (id: string, overrides: unknown) => {
          resumeCalls.push({ id, overrides });
          instance.libp2pNode = {} as never;
          instance.database = {} as never;
          instance.status = 'active';
          return instance;
        }
      };

      // Inject the fake strand manager plus a control DB/node so resolveCohortSeed
      // returns a non-trivial, freshly-resolved seed at wake time (self excluded).
      (node as unknown as { strandManager: unknown }).strandManager = fakeManager;
      (node as unknown as { controlNode: unknown }).controlNode = {
        peerId: { toString: () => 'self-peer' }
      };
      (node as unknown as { controlDatabase: unknown }).controlDatabase = {
        queryCadrePeers: async () => [
          { peerId: 'self-peer', multiaddr: '/ip4/1.1.1.1/tcp/4001/p2p/self-peer' },
          { peerId: 'other-peer', multiaddr: '/ip4/9.9.9.9/tcp/4001/p2p/other-peer' }
        ]
      };

      const hibernating: string[] = [];
      const waking: string[] = [];
      node.on('strand:hibernating', (d) => hibernating.push(d.strandId));
      node.on('strand:waking', (d) => waking.push(d.strandId));

      const callHibernate = (node as unknown as {
        handleStrandHibernate: (id: string) => Promise<void>;
      }).handleStrandHibernate.bind(node);
      const callWake = (node as unknown as {
        handleStrandWake: (id: string) => Promise<void>;
      }).handleStrandWake.bind(node);

      // Hibernate: quiesce + mark status + emit.
      await callHibernate('hib-strand');
      expect(quiesceCalls).toEqual(['hib-strand']);
      expect(instance.status).toBe('hibernating');
      expect(instance.libp2pNode).toBeUndefined();
      expect(hibernating).toEqual(['hib-strand']);

      // Wake: cohort now has another peer → networked; resume with that seed.
      await callWake('hib-strand');
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0]!.id).toBe('hib-strand');
      expect(resumeCalls[0]!.overrides).toEqual({
        bootstrapNodes: ['/ip4/9.9.9.9/tcp/4001/p2p/other-peer'],
        mode: 'networked'
      });
      expect(instance.status).toBe('active');
      expect(instance.libp2pNode).toBeDefined();
      expect(waking).toEqual(['hib-strand']);
    });

    it('wake on a still-live (idle) strand flips status without rebuilding', async () => {
      const node = new CadreNode(createConfig());

      const instance: StrandInstance = {
        strandId: 'idle-strand',
        status: 'idle',
        connectedPeers: 1,
        lastActivity: new Date(0),
        latencyHint: 'interactive',
        libp2pNode: {} as never,
        database: {} as never
      };

      const resumeCalls: string[] = [];
      const fakeManager = {
        getInstance: (id: string) => (id === 'idle-strand' ? instance : undefined),
        quiesceStrand: async () => {},
        resumeStrand: async (id: string) => { resumeCalls.push(id); return instance; }
      };
      (node as unknown as { strandManager: unknown }).strandManager = fakeManager;

      const waking: string[] = [];
      node.on('strand:waking', (d) => waking.push(d.strandId));

      const callWake = (node as unknown as {
        handleStrandWake: (id: string) => Promise<void>;
      }).handleStrandWake.bind(node);

      await callWake('idle-strand');

      // Live strand: no resume rebuild, just a status flip + event.
      expect(resumeCalls).toHaveLength(0);
      expect(instance.status).toBe('active');
      expect(waking).toEqual(['idle-strand']);
    });

    it('check-in resumes then re-hibernates when no activity is found', async () => {
      // checkInWindowMs:0 → the resume-and-probe window resolves immediately, so
      // no activity lands and the strand re-hibernates.
      const node = new CadreNode(createConfig({ hibernation: { enabled: true, checkInWindowMs: 0 } }));

      // A quiesced (hibernating) instance: no libp2pNode/database.
      const instance: StrandInstance = {
        strandId: 'checkin-strand',
        status: 'hibernating',
        sAppInfo: { id: 'app', version: '1.0.0', schema: '' },
        connectedPeers: 0,
        lastActivity: new Date(1000),
        latencyHint: 'interactive'
      };

      const resumeCalls: Array<{ id: string; overrides: unknown }> = [];
      const quiesceCalls: string[] = [];
      const fakeManager = {
        getInstance: (id: string) => (id === 'checkin-strand' ? instance : undefined),
        resumeStrand: async (id: string, overrides: unknown) => {
          resumeCalls.push({ id, overrides });
          instance.libp2pNode = {} as never;
          instance.database = {} as never;
          instance.status = 'active';
          return instance;
        },
        quiesceStrand: async (id: string) => {
          quiesceCalls.push(id);
          instance.libp2pNode = undefined;
          instance.database = undefined;
          instance.connectedPeers = 0;
        }
      };
      (node as unknown as { strandManager: unknown }).strandManager = fakeManager;
      (node as unknown as { controlNode: unknown }).controlNode = {
        peerId: { toString: () => 'self-peer' }
      };
      // Solo cohort (only self) → bootstrap mode, empty seed.
      (node as unknown as { controlDatabase: unknown }).controlDatabase = {
        queryCadrePeers: async () => [
          { peerId: 'self-peer', multiaddr: '/ip4/1.1.1.1/tcp/4001/p2p/self-peer' }
        ]
      };

      const callCheckIn = (node as unknown as {
        handleStrandCheckIn: (id: string) => Promise<void>;
      }).handleStrandCheckIn.bind(node);

      await callCheckIn('checkin-strand');

      // Resumed once (with a freshly re-resolved seed), then quiesced again.
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0]!.overrides).toEqual({ bootstrapNodes: [], mode: 'bootstrap' });
      expect(quiesceCalls).toEqual(['checkin-strand']);
      expect(instance.status).toBe('hibernating');
      expect(instance.libp2pNode).toBeUndefined();
    });

    it('check-in keeps the strand active when activity arrives during the window', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));

      const instance: StrandInstance = {
        strandId: 'checkin-active',
        status: 'hibernating',
        connectedPeers: 0,
        lastActivity: new Date(1000),
        latencyHint: 'interactive'
      };

      const quiesceCalls: string[] = [];
      const fakeManager = {
        getInstance: (id: string) => (id === 'checkin-active' ? instance : undefined),
        resumeStrand: async () => {
          instance.libp2pNode = {} as never;
          instance.database = {} as never;
          instance.status = 'active';
          return instance;
        },
        quiesceStrand: async (id: string) => { quiesceCalls.push(id); }
      };
      (node as unknown as { strandManager: unknown }).strandManager = fakeManager;
      (node as unknown as { controlNode: unknown }).controlNode = {
        peerId: { toString: () => 'self-peer' }
      };
      (node as unknown as { controlDatabase: unknown }).controlDatabase = {
        queryCadrePeers: async () => []
      };

      // Simulate the app recording activity during the window: assign a fresh
      // Date so the reference differs from the post-resume activity marker.
      (node as unknown as { runCheckInWindow: (i: StrandInstance) => Promise<void> }).runCheckInWindow =
        async () => { instance.lastActivity = new Date(2000); };

      const waking: string[] = [];
      node.on('strand:waking', (d) => waking.push(d.strandId));

      const callCheckIn = (node as unknown as {
        handleStrandCheckIn: (id: string) => Promise<void>;
      }).handleStrandCheckIn.bind(node);

      await callCheckIn('checkin-active');

      // Activity found → strand stays active, never re-hibernates, emits waking.
      expect(instance.status).toBe('active');
      expect(quiesceCalls).toHaveLength(0);
      expect(waking).toEqual(['checkin-active']);
    });

    it('check-in that fails to resume leaves the strand hibernating so the manager retries on backoff', async () => {
      // A flaky-network resume failure is exactly what hibernation targets. The
      // real StrandInstanceManager.resumeStrand flips status to 'error' and
      // rethrows on failure. handleStrandCheckIn must NOT let that 'error' status
      // escape: HibernationManager reads instance.status after onCheckIn and
      // treats anything non-'hibernating' as "woke", which would stop the
      // check-in chain and strand the strand. It must end 'hibernating'.
      const node = new CadreNode(createConfig({ hibernation: { enabled: true, checkInWindowMs: 0 } }));

      const instance: StrandInstance = {
        strandId: 'checkin-fail',
        status: 'hibernating',
        connectedPeers: 0,
        lastActivity: new Date(1000),
        latencyHint: 'interactive'
      };

      const quiesceCalls: string[] = [];
      const fakeManager = {
        getInstance: (id: string) => (id === 'checkin-fail' ? instance : undefined),
        resumeStrand: async () => {
          // Mirror resumeStrand's failure: runtime rolled back, status 'error', throw.
          instance.libp2pNode = undefined;
          instance.database = undefined;
          instance.status = 'error';
          throw new Error('resume boom (flaky network)');
        },
        quiesceStrand: async (id: string) => { quiesceCalls.push(id); }
      };
      (node as unknown as { strandManager: unknown }).strandManager = fakeManager;
      (node as unknown as { controlNode: unknown }).controlNode = {
        peerId: { toString: () => 'self-peer' }
      };
      (node as unknown as { controlDatabase: unknown }).controlDatabase = {
        queryCadrePeers: async () => []
      };

      const callCheckIn = (node as unknown as {
        handleStrandCheckIn: (id: string) => Promise<void>;
      }).handleStrandCheckIn.bind(node);

      // Must swallow the failure (so the manager's await resolves) and leave the
      // strand hibernating, with a best-effort cleanup quiesce.
      await expect(callCheckIn('checkin-fail')).resolves.toBeUndefined();
      expect(instance.status).toBe('hibernating');
      expect(quiesceCalls).toEqual(['checkin-fail']);
    });
  });

  describe('enrollment service', () => {
    it('should provide access to enrollment service', () => {
      const config = createConfig();
      const node = new CadreNode(config);

      const enrollment = node.getEnrollmentService();
      expect(enrollment).toBeDefined();
    });
  });

  describe('peer identity persistence', () => {
    it('should produce deterministic peerId when privateKey is provided', async () => {
      const key = await generateKeyPair('Ed25519');

      const node1 = new CadreNode(createConfig({ privateKey: key }));
      await node1.start();
      const peerId1 = node1.peerId!.toString();
      await node1.stop();

      const node2 = new CadreNode(createConfig({ privateKey: key }));
      await node2.start();
      const peerId2 = node2.peerId!.toString();
      await node2.stop();

      expect(peerId1).toBe(peerId2);
    }, 60_000);

    it('should produce different peerIds without privateKey', async () => {
      const node1 = new CadreNode(createConfig());
      await node1.start();
      const peerId1 = node1.peerId!.toString();
      await node1.stop();

      const node2 = new CadreNode(createConfig());
      await node2.start();
      const peerId2 = node2.peerId!.toString();
      await node2.stop();

      expect(peerId1).not.toBe(peerId2);
    }, 60_000);
  });
});

