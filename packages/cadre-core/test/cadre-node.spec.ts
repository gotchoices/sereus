import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode } from '../src/cadre-node.js';
import { signSchema } from '../src/schema-verification.js';
import type { CadreNodeConfig, StrandRow, StrandConfig, SAppConfig } from '../src/types.js';

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

