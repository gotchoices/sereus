import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey, digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import {
  SeedBootstrapService,
  SEED_PROTOCOL
} from '../src/seed-bootstrap.js';
import type {
  ControlNetworkSeed,
  SeedPeer,
  SeedMessage,
  SeedAckMessage,
  CadreInvite,
  AddDroneOptions,
  AddPhoneOptions,
  DroneInitResult,
  InviteResult
} from '../src/types.js';

describe('SeedBootstrapService', () => {
  let authorityPrivateKey: string;
  let authorityPublicKey: string;
  const partyId = 'test-party-123';

  beforeEach(() => {
    // Generate a fresh authority key pair for each test
    authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorityPublicKey = getPublicKey(authorityPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  describe('constructor', () => {
    it('should create service with party ID', () => {
      const service = new SeedBootstrapService({ partyId });
      expect(service).toBeDefined();
    });

    it('should derive public key from private key', () => {
      const service = new SeedBootstrapService({
        partyId,
        authorityPrivateKey
      });
      expect(service).toBeDefined();
    });

    it('should accept explicit public key', () => {
      const service = new SeedBootstrapService({
        partyId,
        authorityPrivateKey,
        authorityPublicKey
      });
      expect(service).toBeDefined();
    });
  });

  describe('encodeSeed / decodeSeed', () => {
    it('should encode and decode a seed', () => {
      const service = new SeedBootstrapService({ partyId });

      const seed: ControlNetworkSeed = {
        partyId,
        peers: [
          {
            peerId: '12D3KooWTestPeer1',
            multiaddrs: ['/ip4/127.0.0.1/tcp/4001'],
            isAuthority: true
          }
        ],
        signature: 'test-signature',
        signerKey: authorityPublicKey
      };

      const encoded = service.encodeSeed(seed);
      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);

      const decoded = service.decodeSeed(encoded);
      expect(decoded).toEqual(seed);
    });

    it('should handle seeds with transactions', () => {
      const service = new SeedBootstrapService({ partyId });

      const seed: ControlNetworkSeed = {
        partyId,
        peers: [],
        transactions: [
          { id: 'tx-1', data: 'data-1', signature: 'sig-1' }
        ],
        signature: 'test-signature',
        signerKey: authorityPublicKey
      };

      const encoded = service.encodeSeed(seed);
      const decoded = service.decodeSeed(encoded);
      expect(decoded.transactions).toEqual(seed.transactions);
    });
  });

  describe('validateSeedSignature', () => {
    it('should validate a correctly signed seed', () => {
      const service = new SeedBootstrapService({ partyId });

      // Create seed data
      const seedData = {
        partyId,
        peers: [
          {
            peerId: '12D3KooWTestPeer1',
            multiaddrs: ['/ip4/127.0.0.1/tcp/4001'],
            isAuthority: true
          }
        ]
      };

      // Sign the seed
      const seedJson = JSON.stringify(seedData);
      const seedDigest = digest(seedJson, 'sha256', 'utf8', 'base64url') as string;
      const signature = sign(
        seedDigest,
        authorityPrivateKey,
        'ed25519',
        'base64url',
        'base64url',
        'base64url'
      ) as string;

      const seed: ControlNetworkSeed = {
        ...seedData,
        signature,
        signerKey: authorityPublicKey
      };

      expect(service.validateSeedSignature(seed)).toBe(true);
    });

    it('should reject an incorrectly signed seed', () => {
      const service = new SeedBootstrapService({ partyId });

      const seed: ControlNetworkSeed = {
        partyId,
        peers: [],
        signature: 'invalid-signature',
        signerKey: authorityPublicKey
      };

      expect(service.validateSeedSignature(seed)).toBe(false);
    });

    it('should reject a seed with tampered data', () => {
      const service = new SeedBootstrapService({ partyId });

      // Create and sign original seed
      const originalData = { partyId, peers: [] };
      const seedJson = JSON.stringify(originalData);
      const seedDigest = digest(seedJson, 'sha256', 'utf8', 'base64url') as string;
      const signature = sign(
        seedDigest,
        authorityPrivateKey,
        'ed25519',
        'base64url',
        'base64url',
        'base64url'
      ) as string;

      // Tamper with the data
      const tamperedSeed: ControlNetworkSeed = {
        partyId: 'different-party',  // Changed!
        peers: [],
        signature,
        signerKey: authorityPublicKey
      };

      expect(service.validateSeedSignature(tamperedSeed)).toBe(false);
    });
  });

  describe('SEED_PROTOCOL', () => {
    it('should export the correct protocol ID', () => {
      expect(SEED_PROTOCOL).toBe('/sereus/seed/1.0.0');
    });
  });
});

describe('Seed Types', () => {
  describe('SeedPeer', () => {
    it('should have required fields', () => {
      const peer: SeedPeer = {
        peerId: '12D3KooWTestPeer',
        multiaddrs: ['/ip4/127.0.0.1/tcp/4001'],
        isAuthority: true
      };

      expect(peer.peerId).toBe('12D3KooWTestPeer');
      expect(peer.multiaddrs).toHaveLength(1);
      expect(peer.isAuthority).toBe(true);
    });

    it('should allow empty multiaddrs', () => {
      const peer: SeedPeer = {
        peerId: '12D3KooWTestPeer',
        multiaddrs: [],
        isAuthority: false
      };

      expect(peer.multiaddrs).toHaveLength(0);
    });
  });

  describe('ControlNetworkSeed', () => {
    it('should have required fields', () => {
      const seed: ControlNetworkSeed = {
        partyId: 'test-party',
        peers: [],
        signature: 'sig',
        signerKey: 'key'
      };

      expect(seed.partyId).toBe('test-party');
      expect(seed.peers).toEqual([]);
      expect(seed.signature).toBe('sig');
      expect(seed.signerKey).toBe('key');
    });

    it('should allow optional transactions', () => {
      const seed: ControlNetworkSeed = {
        partyId: 'test-party',
        peers: [],
        transactions: [
          { id: 'tx-1', data: 'data', signature: 'sig' }
        ],
        signature: 'sig',
        signerKey: 'key'
      };

      expect(seed.transactions).toHaveLength(1);
    });
  });

  describe('SeedMessage', () => {
    it('should match ControlNetworkSeed structure', () => {
      const message: SeedMessage = {
        partyId: 'test-party',
        peers: [
          { peerId: 'peer1', multiaddrs: [], isAuthority: true }
        ],
        signature: 'sig',
        signerKey: 'key'
      };

      expect(message.partyId).toBe('test-party');
      expect(message.peers).toHaveLength(1);
    });
  });

  describe('SeedAckMessage', () => {
    it('should indicate acceptance', () => {
      const ack: SeedAckMessage = {
        accepted: true
      };

      expect(ack.accepted).toBe(true);
      expect(ack.reason).toBeUndefined();
    });

    it('should include reason for rejection', () => {
      const ack: SeedAckMessage = {
        accepted: false,
        reason: 'Invalid signature'
      };

      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('Invalid signature');
    });
  });

  describe('CadreInvite', () => {
    it('should have required fields', () => {
      const invite: CadreInvite = {
        partyId: 'test-party',
        authorityAddrs: ['/ip4/1.2.3.4/tcp/4001'],
        createdAt: Date.now()
      };

      expect(invite.partyId).toBe('test-party');
      expect(invite.authorityAddrs).toHaveLength(1);
      expect(invite.createdAt).toBeGreaterThan(0);
    });

    it('should allow optional token and expiration', () => {
      const now = Date.now();
      const invite: CadreInvite = {
        partyId: 'test-party',
        authorityAddrs: [],
        token: 'secret-token',
        createdAt: now,
        expiresAt: now + 3600000
      };

      expect(invite.token).toBe('secret-token');
      expect(invite.expiresAt).toBe(now + 3600000);
    });
  });

  describe('DroneInitResult', () => {
    it('should contain seed and encoded seed', () => {
      const result: DroneInitResult = {
        seed: {
          partyId: 'test-party',
          peers: [],
          signature: 'sig',
          signerKey: 'key'
        },
        encodedSeed: 'base64url-encoded-seed'
      };

      expect(result.seed.partyId).toBe('test-party');
      expect(result.encodedSeed).toBe('base64url-encoded-seed');
    });
  });

  describe('InviteResult', () => {
    it('should contain invite and encoded invite', () => {
      const result: InviteResult = {
        invite: {
          partyId: 'test-party',
          authorityAddrs: ['/ip4/1.2.3.4/tcp/4001'],
          createdAt: Date.now()
        },
        encodedInvite: 'base64url-encoded-invite'
      };

      expect(result.invite.partyId).toBe('test-party');
      expect(result.encodedInvite).toBe('base64url-encoded-invite');
    });
  });
});

describe('Seed authority validation', () => {
	let authorityPrivateKey: string;
	let authorityPublicKey: string;
	let attackerPrivateKey: string;
	let attackerPublicKey: string;
	const partyId = 'test-party-vuln';

	beforeEach(() => {
		authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		authorityPublicKey = getPublicKey(authorityPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		attackerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		attackerPublicKey = getPublicKey(attackerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
	});

	function createSignedSeed(
		privateKey: string,
		publicKey: string,
		peers: SeedPeer[]
	): ControlNetworkSeed {
		const seedData = { partyId, peers };
		const seedJson = JSON.stringify(seedData);
		const seedDigest = digest(seedJson, 'sha256', 'utf8', 'base64url') as string;
		const signature = sign(
			seedDigest,
			privateKey,
			'ed25519',
			'base64url',
			'base64url',
			'base64url'
		) as string;
		return { ...seedData, signature, signerKey: publicKey };
	}

	function createMockLibp2p() {
		return {
			peerStore: {
				merge: async () => {},
			},
			dial: async () => {},
		};
	}

	it('should accept seed signed by authority key with matching publicKey', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();

		const peers: SeedPeer[] = [
			{
				peerId: '12D3KooWAuthority',
				multiaddrs: ['/ip4/1.2.3.4/tcp/4001'],
				isAuthority: true,
				publicKey: authorityPublicKey,
			},
		];

		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, peers);
		const result = await service.applySeed(seed);

		expect(result.success).toBe(true);
	});

	it('should reject seed signed by non-authority key', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();

		const peers: SeedPeer[] = [
			{
				peerId: '12D3KooWAuthority',
				multiaddrs: ['/ip4/1.2.3.4/tcp/4001'],
				isAuthority: true,
				publicKey: authorityPublicKey,  // Real authority's key
			},
		];

		// Attacker signs with their own key — signerKey won't match authority publicKey
		const forgedSeed = createSignedSeed(attackerPrivateKey, attackerPublicKey, peers);
		const result = await service.applySeed(forgedSeed);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Signer key does not match any authority peer');
	});

	it('should reject seed when authority peer has no publicKey', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();

		const peers: SeedPeer[] = [
			{
				peerId: '12D3KooWAuthority',
				multiaddrs: ['/ip4/1.2.3.4/tcp/4001'],
				isAuthority: true,
				// No publicKey — can't verify signerKey
			},
		];

		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, peers);
		const result = await service.applySeed(seed);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Signer key does not match any authority peer');
	});

	it('should reject seed with no authority peers', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();

		const peers: SeedPeer[] = [
			{
				peerId: '12D3KooWRegularPeer',
				multiaddrs: ['/ip4/1.2.3.4/tcp/4001'],
				isAuthority: false,
			},
		];

		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, peers);
		const result = await service.applySeed(seed);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Signer key does not match any authority peer');
	});

	it('SeedPeer should support publicKey field for authority peers', () => {
		const peer: SeedPeer = {
			peerId: '12D3KooWTestPeer',
			multiaddrs: [],
			isAuthority: true,
			publicKey: authorityPublicKey,
		};

		expect(peer.publicKey).toBe(authorityPublicKey);
	});
});

describe('SeedBootstrapService Helper Methods', () => {
  let authorityPrivateKey: string;
  let authorityPublicKey: string;
  const partyId = 'test-party-456';

  beforeEach(() => {
    authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorityPublicKey = getPublicKey(authorityPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  describe('encodeInvite / decodeInvite', () => {
    it('should encode and decode an invite', () => {
      const service = new SeedBootstrapService({ partyId });

      const invite: CadreInvite = {
        partyId,
        authorityAddrs: ['/ip4/192.168.1.1/tcp/4001', '/ip4/10.0.0.1/tcp/4001'],
        token: 'my-secret-token',
        createdAt: 1700000000000,
        expiresAt: 1700003600000
      };

      const encoded = service.encodeInvite(invite);
      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);

      const decoded = service.decodeInvite(encoded);
      expect(decoded).toEqual(invite);
    });

    it('should handle invites without optional fields', () => {
      const service = new SeedBootstrapService({ partyId });

      const invite: CadreInvite = {
        partyId,
        authorityAddrs: [],
        createdAt: 1700000000000
      };

      const encoded = service.encodeInvite(invite);
      const decoded = service.decodeInvite(encoded);
      expect(decoded).toEqual(invite);
      expect(decoded.token).toBeUndefined();
      expect(decoded.expiresAt).toBeUndefined();
    });
  });

  describe('acceptPhone', () => {
    it('should reject expired invite', async () => {
      const service = new SeedBootstrapService({
        partyId,
        authorityPrivateKey
      });

      const expiredInvite: CadreInvite = {
        partyId,
        authorityAddrs: [],
        createdAt: Date.now() - 7200000,
        expiresAt: Date.now() - 3600000  // Expired 1 hour ago
      };

      await expect(
        service.acceptPhone({ phonePeerId: '12D3KooWTestPhone' }, expiredInvite)
      ).rejects.toThrow('Invite has expired');
    });

    it('should reject invalid token', async () => {
      const service = new SeedBootstrapService({
        partyId,
        authorityPrivateKey
      });

      const invite: CadreInvite = {
        partyId,
        authorityAddrs: [],
        token: 'correct-token',
        createdAt: Date.now()
      };

      await expect(
        service.acceptPhone({ phonePeerId: '12D3KooWTestPhone', token: 'wrong-token' }, invite)
      ).rejects.toThrow('Invalid invite token');
    });
  });

  describe('removePeer', () => {
    it('requires an authority private key', async () => {
      const service = new SeedBootstrapService({ partyId });
      await expect(service.removePeer('12D3KooWTestPeer'))
        .rejects.toThrow('Authority private key required');
    });

    it('requires the control database to be initialized', async () => {
      const service = new SeedBootstrapService({ partyId, authorityPrivateKey });
      await expect(service.removePeer('12D3KooWTestPeer'))
        .rejects.toThrow('Control database not initialized');
    });
  });
});

