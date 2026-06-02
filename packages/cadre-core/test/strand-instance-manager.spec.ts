import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { StrandInstanceManager, getStrandStoragePath } from '../src/strand-instance-manager.js';
import { signSchema, SchemaVerificationError } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

describe('StrandInstanceManager', () => {
  let authorPrivateKey: string;
  let authorPublicKey: string;

  beforeEach(() => {
    authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  const testSchema = 'create table Test (id text primary key);';
  const testVersion = '1.0.0';

  // Helper to create test strand rows
  function createStrandRow(id: string, type: 'o' | 'c' = 'o'): StrandRow {
    return {
      Id: id,
      MemberPrivateKey: type === 'c' ? 'test-key' : null,
      Type: type
    };
  }

  // Helper to create test sApp config with a real signature
  function createSAppConfig(id?: string): SAppConfig {
    const pubKey = id ?? authorPublicKey;
    return {
      id: pubKey,
      version: testVersion,
      schema: testSchema,
      signature: signSchema(testSchema, testVersion, authorPrivateKey)
    };
  }

  // Helper to create start config
  function createStartConfig(strandId: string, overrides?: Partial<StartStrandConfig>): StartStrandConfig {
    return {
      strandRow: createStrandRow(strandId),
      sAppConfig: createSAppConfig(),
      profile: 'transaction',
      defaultLatencyHint: 'interactive',
      ...overrides
    };
  }

  describe('constructor', () => {
    it('should create an empty manager', () => {
      const manager = new StrandInstanceManager();
      expect(manager.getInstances().size).toBe(0);
    });
  });

  describe('hasStrand', () => {
    it('should return false for non-existent strand', () => {
      const manager = new StrandInstanceManager();
      expect(manager.hasStrand('non-existent')).toBe(false);
    });
  });

  describe('getInstance', () => {
    it('should return undefined for non-existent strand', () => {
      const manager = new StrandInstanceManager();
      expect(manager.getInstance('non-existent')).toBeUndefined();
    });
  });

  describe('startStrand', () => {
    it('should start a strand instance with sApp info', async () => {
      const manager = new StrandInstanceManager();

      const instance = await manager.startStrand(createStartConfig('test-strand-1'));

      expect(instance.strandId).toBe('test-strand-1');
      expect(instance.status).toBe('active');
      expect(instance.latencyHint).toBe('interactive');
      expect(instance.sAppInfo).toBeDefined();
      expect(instance.sAppInfo?.id).toBe(authorPublicKey);
      expect(instance.sAppInfo?.version).toBe('1.0.0');
      expect(manager.hasStrand('test-strand-1')).toBe(true);

      // Cleanup
      await manager.stopAll();
    }, 30000);

    it('should accept a cohort-derived bootstrapNodes seed', async () => {
      // Acceptance smoke: a bootstrapNodes seed is forwarded to createLibp2pNode
      // and the strand still reaches active. The value-derivation itself is
      // covered by strand-cohort.spec.ts (asserting the forwarded array would
      // require mocking the @optimystic/db-p2p import — see review handoff).
      const manager = new StrandInstanceManager();
      // A real, parseable peer id — the libp2p bootstrap module validates it.
      const seedPeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
      const config = createStartConfig('seeded-strand', {
        bootstrapNodes: [`/ip4/127.0.0.1/tcp/4001/p2p/${seedPeerId}`]
      });

      const instance = await manager.startStrand(config);

      expect(instance.status).toBe('active');

      await manager.stopAll();
    }, 30000);

    it('should return existing instance if already running', async () => {
      const manager = new StrandInstanceManager();
      const config = createStartConfig('test-strand-2');

      const instance1 = await manager.startStrand(config);
      const instance2 = await manager.startStrand(config);

      expect(instance1).toBe(instance2);
      expect(manager.getInstances().size).toBe(1);

      await manager.stopAll();
    }, 30000);

    it('should track member private key for closed strands', async () => {
      const manager = new StrandInstanceManager();
      const config = createStartConfig('closed-strand', {
        strandRow: createStrandRow('closed-strand', 'c'),
        defaultLatencyHint: 'background'
      });

      const instance = await manager.startStrand(config);

      expect(instance.memberPrivateKey).toBe('test-key');

      await manager.stopAll();
    }, 30000);

    it('should use sApp latency hint if provided', async () => {
      const manager = new StrandInstanceManager();
      const config = createStartConfig('hint-strand', {
        sAppConfig: { ...createSAppConfig(), latencyHint: 'archive' }
      });

      const instance = await manager.startStrand(config);

      expect(instance.latencyHint).toBe('archive');

      await manager.stopAll();
    }, 30000);

    it('should reject config with invalid signature', async () => {
      const manager = new StrandInstanceManager();
      const config = createStartConfig('bad-sig-strand', {
        sAppConfig: {
          id: authorPublicKey,
          version: testVersion,
          schema: testSchema,
          signature: 'invalid-signature'
        }
      });

      await expect(manager.startStrand(config)).rejects.toThrow(SchemaVerificationError);
      // Instance should be cleaned up or in error state
      const instance = manager.getInstance('bad-sig-strand');
      expect(instance).toBeUndefined();
    });

    it('should reject config with tampered schema', async () => {
      const manager = new StrandInstanceManager();
      const goodSig = signSchema(testSchema, testVersion, authorPrivateKey);
      const config = createStartConfig('tampered-strand', {
        sAppConfig: {
          id: authorPublicKey,
          version: testVersion,
          schema: testSchema + ' -- injected',
          signature: goodSig
        }
      });

      await expect(manager.startStrand(config)).rejects.toThrow(SchemaVerificationError);
    });
  });

  describe('stopStrand', () => {
    it('should stop a running strand', async () => {
      const manager = new StrandInstanceManager();

      await manager.startStrand(createStartConfig('strand-to-stop'));

      expect(manager.hasStrand('strand-to-stop')).toBe(true);

      await manager.stopStrand('strand-to-stop');

      expect(manager.hasStrand('strand-to-stop')).toBe(false);
    }, 30000);

    it('should handle stopping non-existent strand gracefully', async () => {
      const manager = new StrandInstanceManager();

      // Should not throw
      await manager.stopStrand('non-existent');
    });
  });

  describe('stopAll', () => {
    it('should stop all running strands', async () => {
      const manager = new StrandInstanceManager();

      await manager.startStrand(createStartConfig('strand-a'));
      await manager.startStrand(createStartConfig('strand-b'));

      expect(manager.getInstances().size).toBe(2);

      await manager.stopAll();

      expect(manager.getInstances().size).toBe(0);
    }, 60000);

    it('should handle empty manager', async () => {
      const manager = new StrandInstanceManager();

      // Should not throw
      await manager.stopAll();

      expect(manager.getInstances().size).toBe(0);
    });
  });

  describe('getStrandStoragePath', () => {
    it('should create isolated storage paths for strands', () => {
      const basePath = '/data/sereus';

      const path1 = getStrandStoragePath(basePath, 'strand-abc-123');
      const path2 = getStrandStoragePath(basePath, 'strand-xyz-456');

      expect(path1).toContain('strands');
      expect(path1).toContain('strand-abc-123');
      expect(path2).toContain('strand-xyz-456');
      expect(path1).not.toBe(path2);
    });

    it('should sanitize unsafe characters in strandId', () => {
      const basePath = '/data/sereus';

      const path = getStrandStoragePath(basePath, 'strand/../unsafe');

      // Should not contain the unsafe path traversal
      expect(path).not.toContain('..');
    });
  });
});
