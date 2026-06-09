import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { CadreNode } from '../src/cadre-node.js';
import { StrandWakeService } from '../src/strand-wake-protocol.js';
import { signSchema } from '../src/schema-verification.js';
import type { CadreNodeConfig, StrandRow, StrandConfig, SAppConfig, StrandInstance, CadreNodeEvents } from '../src/types.js';
import { duplexPair } from './wake-stream-helpers.js';

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
        storage: { provider: () => new MemoryRawStorage() },
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

    it('emits strand:discovered when a watched strand has no registered config', () => {
      // The discovery seam: a control-network strand with no local sAppConfig
      // must surface as strand:discovered (carrying the full row) instead of
      // being silently dropped, so the hosting app can decide whether to join.
      const node = new CadreNode(createConfig());

      const discovered: Array<CadreNodeEvents['strand:discovered']> = [];
      node.on('strand:discovered', (d) => discovered.push(d));

      const strand = createStrandRow('discovered-strand');
      const callHandle = (node as unknown as {
        handleStrandAdded: (s: StrandRow) => Promise<void>;
      }).handleStrandAdded.bind(node);

      // No node start / control DB needed: the no-config branch only reads the
      // (empty) sAppConfigs map and emits.
      void callHandle(strand);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.strandId).toBe('discovered-strand');
      expect(discovered[0]!.strand).toEqual(strand);
    });

    it('does not emit strand:discovered for a strand that has a registered config (auto-start path)', async () => {
      // A self-configured strand (config already present from addStrand) must keep
      // taking the auto-start path, NOT the discovery path. Stub launchStrand so
      // we can assert the branch without booting a real strand instance.
      const node = new CadreNode(createConfig());

      const launched: string[] = [];
      (node as unknown as {
        launchStrand: (s: StrandRow, c: SAppConfig) => Promise<void>;
      }).launchStrand = async (s) => { launched.push(s.Id); };

      (node as unknown as { sAppConfigs: Map<string, SAppConfig> })
        .sAppConfigs.set('configured-strand', createSAppConfig());

      const discovered: string[] = [];
      node.on('strand:discovered', (d) => discovered.push(d.strandId));

      const callHandle = (node as unknown as {
        handleStrandAdded: (s: StrandRow) => Promise<void>;
      }).handleStrandAdded.bind(node);

      await callHandle(createStrandRow('configured-strand'));

      expect(discovered).toHaveLength(0);
      expect(launched).toEqual(['configured-strand']);
    });
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
      (node as unknown as { holdWakeWindow: (i: StrandInstance, ms: number) => Promise<void> }).holdWakeWindow =
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

  describe('mobile background lifecycle primitives', () => {
    // A live (post-launch) strand instance with both runtime handles attached.
    function liveInstance(strandId: string, latencyHint: StrandInstance['latencyHint'] = 'interactive'): StrandInstance {
      return {
        strandId,
        status: 'active',
        sAppInfo: { id: 'app', version: '1.0.0', schema: '' },
        connectedPeers: 2,
        lastActivity: new Date(0),
        latencyHint,
        libp2pNode: {} as never,
        database: {} as never
      };
    }

    // A fake StrandInstanceManager backed by a strandId→instance map whose
    // quiesce/resume mutate the instances the way the real manager does.
    function fakeManager(instances: Map<string, StrandInstance>, calls: { quiesce: string[]; resume: Array<{ id: string; overrides: unknown }> }) {
      return {
        getInstance: (id: string) => instances.get(id),
        getInstances: () => new Map(instances),
        quiesceStrand: async (id: string) => {
          calls.quiesce.push(id);
          const i = instances.get(id);
          if (i) { i.libp2pNode = undefined; i.database = undefined; i.connectedPeers = 0; }
        },
        resumeStrand: async (id: string, overrides: unknown) => {
          calls.resume.push({ id, overrides });
          const i = instances.get(id)!;
          i.libp2pNode = {} as never;
          i.database = {} as never;
          i.status = 'active';
          i.lastActivity = new Date();
          return i;
        }
      };
    }

    function injectControl(node: CadreNode, peers: Array<{ peerId: string; multiaddr: string | null }> = []): void {
      (node as unknown as { _running: boolean })._running = true;
      (node as unknown as { controlNode: unknown }).controlNode = { peerId: { toString: () => 'self-peer' } };
      (node as unknown as { controlDatabase: unknown }).controlDatabase = {
        queryCadrePeers: async () => peers
      };
    }

    it('hibernateStrand quiesces an active interactive strand and emits strand:hibernating', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance = liveInstance('h1', 'interactive');
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['h1', instance]]), calls);

      const hibernating: string[] = [];
      node.on('strand:hibernating', (d) => hibernating.push(d.strandId));

      await node.hibernateStrand('h1');

      expect(instance.status).toBe('hibernating');
      expect(calls.quiesce).toEqual(['h1']);
      expect(instance.libp2pNode).toBeUndefined();
      expect(instance.database).toBeUndefined();
      expect(hibernating).toEqual(['h1']);
    });

    it('hibernateStrand on a realtime strand is a no-op (no status change, no event, no quiesce)', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance = liveInstance('rt', 'realtime');
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['rt', instance]]), calls);

      const hibernating: string[] = [];
      node.on('strand:hibernating', (d) => hibernating.push(d.strandId));

      await node.hibernateStrand('rt');

      expect(instance.status).toBe('active');
      expect(calls.quiesce).toEqual([]);
      expect(hibernating).toEqual([]);
    });

    it('hibernateStrand on an already-hibernating strand is a no-op', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance: StrandInstance = {
        strandId: 'hib', status: 'hibernating', connectedPeers: 0,
        lastActivity: new Date(0), latencyHint: 'interactive'
      };
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['hib', instance]]), calls);

      const hibernating: string[] = [];
      node.on('strand:hibernating', (d) => hibernating.push(d.strandId));

      await node.hibernateStrand('hib');

      expect(calls.quiesce).toEqual([]);
      expect(hibernating).toEqual([]);
    });

    it('hibernateStrand on an unknown strand is a no-op', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map(), calls);

      await expect(node.hibernateStrand('ghost')).resolves.toBeUndefined();
      expect(calls.quiesce).toEqual([]);
    });

    it('hibernateAll hibernates only the non-realtime strands and leaves realtime active', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const rt = liveInstance('rt', 'realtime');
      const ix = liveInstance('ix', 'interactive');
      const bg = liveInstance('bg', 'background');
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['rt', rt], ['ix', ix], ['bg', bg]]), calls);

      const hibernated = await node.hibernateAll();

      expect(hibernated.sort()).toEqual(['bg', 'ix']);
      expect(calls.quiesce.sort()).toEqual(['bg', 'ix']);
      expect(rt.status).toBe('active');
      expect(ix.status).toBe('hibernating');
      expect(bg.status).toBe('hibernating');
    });

    it('hibernateAll tolerates a single strand failing to quiesce and still hibernates the rest', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const ix = liveInstance('ix', 'interactive');
      const bg = liveInstance('bg', 'background');
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      const manager = fakeManager(new Map([['ix', ix], ['bg', bg]]), calls);
      // 'ix' quiesce throws; 'bg' must still hibernate.
      const baseQuiesce = manager.quiesceStrand;
      manager.quiesceStrand = async (id: string) => {
        if (id === 'ix') throw new Error('quiesce boom');
        return baseQuiesce(id);
      };
      (node as unknown as { strandManager: unknown }).strandManager = manager;

      const hibernated = await node.hibernateAll();

      expect(hibernated).toEqual(['bg']);
      expect(bg.status).toBe('hibernating');
      // 'ix' threw inside handleStrandHibernate, so its status never advanced.
      expect(ix.status).toBe('active');
    });

    it('serviceWake on a hibernating strand with no activity resumes, then re-hibernates', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance: StrandInstance = {
        strandId: 'sw-idle', status: 'hibernating', connectedPeers: 0,
        lastActivity: new Date(1000), latencyHint: 'interactive'
      };
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['sw-idle', instance]]), calls);
      injectControl(node, [{ peerId: 'self-peer', multiaddr: null }]);

      const result = await node.serviceWake('sw-idle', { windowMs: 0 });

      expect(result).toEqual({ strandId: 'sw-idle', serviced: true, hadActivity: false });
      expect(calls.resume).toHaveLength(1);
      expect(calls.quiesce).toEqual(['sw-idle']);
      expect(instance.status).toBe('hibernating');
      expect(instance.libp2pNode).toBeUndefined();
    });

    it('serviceWake leaves the strand active when activity arrives during the window', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance: StrandInstance = {
        strandId: 'sw-active', status: 'hibernating', connectedPeers: 0,
        lastActivity: new Date(1000), latencyHint: 'interactive'
      };
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['sw-active', instance]]), calls);
      injectControl(node, []);

      // App records activity during the window: a fresh Date differs from the
      // post-resume marker, so the strand stays active.
      (node as unknown as { holdWakeWindow: (i: StrandInstance, ms: number) => Promise<void> }).holdWakeWindow =
        async () => { instance.lastActivity = new Date(9999); };

      const result = await node.serviceWake('sw-active');

      expect(result.serviced).toBe(true);
      expect(result.hadActivity).toBe(true);
      expect(instance.status).toBe('active');
      expect(calls.quiesce).toEqual([]);
    });

    it('serviceWake on an already-live strand is a no-op success without a second runtime build', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance = liveInstance('sw-live', 'interactive');
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['sw-live', instance]]), calls);
      injectControl(node, []);

      const result = await node.serviceWake('sw-live');

      expect(result).toEqual({ strandId: 'sw-live', serviced: true, hadActivity: true });
      expect(calls.resume).toEqual([]);
      expect(calls.quiesce).toEqual([]);
      expect(instance.status).toBe('active');
    });

    it('serviceWake returns serviced:false (no throw) when the node is not running', async () => {
      const node = new CadreNode(createConfig());
      const result = await node.serviceWake('whatever');
      expect(result).toEqual({ strandId: 'whatever', serviced: false, hadActivity: false });
    });

    it('serviceWake returns serviced:false for a strand unknown to this node', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager = fakeManager(new Map(), calls);
      injectControl(node, []);

      const result = await node.serviceWake('absent');
      expect(result).toEqual({ strandId: 'absent', serviced: false, hadActivity: false });
      expect(calls.resume).toEqual([]);
    });

    it('serviceWake re-hibernates and reports no activity when the resume throws', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance: StrandInstance = {
        strandId: 'sw-fail', status: 'hibernating', connectedPeers: 0,
        lastActivity: new Date(1000), latencyHint: 'interactive'
      };
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      const manager = fakeManager(new Map([['sw-fail', instance]]), calls);
      manager.resumeStrand = async () => {
        // Mirror the real resumeStrand failure: status 'error', rethrow.
        instance.status = 'error';
        throw new Error('resume boom (flaky network)');
      };
      (node as unknown as { strandManager: unknown }).strandManager = manager;
      injectControl(node, []);

      const result = await node.serviceWake('sw-fail', { windowMs: 0 });

      expect(result).toEqual({ strandId: 'sw-fail', serviced: true, hadActivity: false });
      expect(instance.status).toBe('hibernating');
      expect(calls.quiesce).toEqual(['sw-fail']);
    });

    it('coalesces concurrent serviceWake calls for the same strand into one runtime build', async () => {
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance: StrandInstance = {
        strandId: 'sw-coalesce', status: 'hibernating', connectedPeers: 0,
        lastActivity: new Date(1000), latencyHint: 'interactive'
      };
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['sw-coalesce', instance]]), calls);
      injectControl(node, []);

      const [r1, r2] = await Promise.all([
        node.serviceWake('sw-coalesce', { windowMs: 0 }),
        node.serviceWake('sw-coalesce', { windowMs: 0 })
      ]);

      // One coalesced operation: a single resume, and both callers get the very
      // same result object.
      expect(calls.resume).toHaveLength(1);
      expect(r1).toBe(r2);
    });

    it('teardown clears an in-flight wake window so the awaiting serviceWake unblocks (no stale timer)', async () => {
      // Exercises the windowWaiters/clearWindowWaiters machinery cleanup() relies
      // on: a stop() during a live window must neither hang the awaiting wake nor
      // leave a timer to fire after teardown.
      const node = new CadreNode(createConfig({ hibernation: { enabled: true } }));
      const instance: StrandInstance = {
        strandId: 'sw-teardown', status: 'hibernating', connectedPeers: 0,
        lastActivity: new Date(1000), latencyHint: 'interactive'
      };
      const calls = { quiesce: [] as string[], resume: [] as Array<{ id: string; overrides: unknown }> };
      (node as unknown as { strandManager: unknown }).strandManager =
        fakeManager(new Map([['sw-teardown', instance]]), calls);
      injectControl(node, []);

      // A long window the test will never wait out — only the teardown can resolve it.
      const pending = node.serviceWake('sw-teardown', { windowMs: 60_000 });

      // Let the wake reach the live window (the waiter is registered there).
      const waiters = () => (node as unknown as { windowWaiters: Set<unknown> }).windowWaiters;
      for (let i = 0; i < 1000 && waiters().size === 0; i++) {
        await new Promise<void>((r) => { setTimeout(r, 0); });
      }
      expect(waiters().size).toBe(1);

      // What cleanup() invokes on stop(): cancel the timer and resolve the waiter.
      (node as unknown as { clearWindowWaiters: () => void }).clearWindowWaiters();
      expect(waiters().size).toBe(0);

      // The awaiting serviceWake completes promptly — no activity landed, so the
      // strand re-hibernates rather than hanging past teardown.
      const result = await pending;
      expect(result).toEqual({ strandId: 'sw-teardown', serviced: true, hadActivity: false });
      expect(instance.status).toBe('hibernating');
      expect(calls.quiesce).toEqual(['sw-teardown']);
    });

    it('running and controlConnected reflect lifecycle synchronously', async () => {
      const node = new CadreNode(createConfig());

      expect(node.running).toBe(false);
      expect(node.controlConnected).toBe(false);

      await node.start();
      expect(node.running).toBe(true);
      expect(node.controlConnected).toBe(true);

      await node.stop();
      expect(node.running).toBe(false);
      expect(node.controlConnected).toBe(false);
    }, 30000);
  });

  describe('push-wake (control-network WAKE_PROTOCOL)', () => {
    it('pushWake dials the target and a hibernating receiver transitions to active', async () => {
      // Receiver: a hibernating strand whose wake() flips it to active (standing
      // in for wakeStrand → resumeStrand).
      const receiverInstance: StrandInstance = {
        strandId: 'push-strand',
        status: 'hibernating',
        connectedPeers: 0,
        lastActivity: new Date(0),
        latencyHint: 'interactive'
      };
      const wakeCalls: string[] = [];
      const receiver = new StrandWakeService({
        isMember: async () => true,
        getStrand: (id) => (id === 'push-strand' ? receiverInstance : undefined),
        wake: async (id) => {
          wakeCalls.push(id);
          receiverInstance.status = 'active';
          receiverInstance.lastActivity = new Date();
        }
      });

      // Sender: stub the signed-record address resolution and loop the control
      // node's dialProtocol straight into the receiver service (no real libp2p).
      const sender = new CadreNode(createConfig());
      (sender as unknown as { resolvePeerAddrs: () => Promise<unknown[]> }).resolvePeerAddrs =
        async () => [multiaddr('/ip4/1.2.3.4/tcp/4001')];
      (sender as unknown as { controlNode: unknown }).controlNode = {
        dialProtocol: async () => {
          const { clientStream, serverStream } = duplexPair();
          void (receiver as unknown as { handleStream(s: unknown, p: string): Promise<void> })
            .handleStream(serverStream, 'sender-peer');
          return clientStream;
        }
      };

      const ack = await sender.pushWake('target-peer', 'push-strand', 'activity');

      expect(ack.accepted).toBe(true);
      expect(ack.status).toBe('active');
      expect(wakeCalls).toEqual(['push-strand']);
      expect(receiverInstance.status).toBe('active');
    });

    it('pushWake throws when the target has no resolvable control-network address', async () => {
      const sender = new CadreNode(createConfig());
      (sender as unknown as { resolvePeerAddrs: () => Promise<unknown[]> }).resolvePeerAddrs = async () => [];
      (sender as unknown as { controlNode: unknown }).controlNode = {
        dialProtocol: async () => { throw new Error('should not dial'); }
      };

      await expect(sender.pushWake('target-peer', 'push-strand')).rejects.toThrow(/no dialable/i);
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

