import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey, digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  SeedBootstrapService,
  SEED_PROTOCOL,
  canonicalSeedPayload,
  decodeLengthPrefixedFrame,
  ed25519PublicKeyB64FromPeerId
} from '../src/seed-bootstrap.js';
import {
  dbAnchoredTrustPolicy,
  pinnedKeyTrustPolicy,
  tofuTrustPolicy
} from '../src/seed-trust-policy.js';
import { CadreNode } from '../src/cadre-node.js';
import { authorityKeyFromLibp2p } from '../src/authority-key.js';
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

      // Sign the seed over the canonical payload (key-order independent)
      const seedJson = canonicalSeedPayload(seedData);
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
      const seedJson = canonicalSeedPayload(originalData);
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

  describe('canonical seed signing', () => {
    function signSeed(privateKey: string, publicKey: string, seedData: {
      partyId: string;
      peers: SeedPeer[];
    }): ControlNetworkSeed {
      const seedDigest = digest(canonicalSeedPayload(seedData), 'sha256', 'utf8', 'base64url') as string;
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

    it('is independent of peer key insertion order', () => {
      const service = new SeedBootstrapService({ partyId });

      // Same peer, fields inserted in different orders — canonical form sorts
      // keys, so both must validate against one signature.
      const peerA: SeedPeer = {
        peerId: '12D3KooWTestPeer1',
        multiaddrs: ['/ip4/127.0.0.1/tcp/4001'],
        isAuthority: true,
        publicKey: authorityPublicKey,
      };
      const seed = signSeed(authorityPrivateKey, authorityPublicKey, { partyId, peers: [peerA] });

      // Rebuild the peer with keys in a different insertion order.
      const reordered: ControlNetworkSeed = {
        ...seed,
        peers: [{
          publicKey: authorityPublicKey,
          isAuthority: true,
          multiaddrs: ['/ip4/127.0.0.1/tcp/4001'],
          peerId: '12D3KooWTestPeer1',
        }],
      };

      expect(service.validateSeedSignature(seed)).toBe(true);
      expect(service.validateSeedSignature(reordered)).toBe(true);
    });
  });

  describe('decodeLengthPrefixedFrame', () => {
    function frame(body: Uint8Array, declaredLength = body.length): Uint8Array {
      const out = new Uint8Array(4 + body.length);
      new DataView(out.buffer).setUint32(0, declaredLength, false);
      out.set(body, 4);
      return out;
    }

    it('decodes a valid frame', () => {
      const body = new TextEncoder().encode('{"accepted":true}');
      const decoded = decodeLengthPrefixedFrame(frame(body));
      expect(new TextDecoder().decode(decoded)).toBe('{"accepted":true}');
    });

    it('rejects a buffer too short for the length prefix', () => {
      expect(() => decodeLengthPrefixedFrame(new Uint8Array([0, 0, 0])))
        .toThrow(/too short/);
    });

    it('rejects a declared length exceeding the bytes present', () => {
      // 6-byte buffer (2 body bytes) declaring length 200.
      const buf = new Uint8Array(6);
      new DataView(buf.buffer).setUint32(0, 200, false);
      expect(() => decodeLengthPrefixedFrame(buf))
        .toThrow(/only 2 body bytes present/);
    });

    it('rejects a declared length exceeding maxLength', () => {
      const body = new Uint8Array(8);
      expect(() => decodeLengthPrefixedFrame(frame(body, 8), 4))
        .toThrow(/exceeding max 4/);
    });

    it('honours a non-zero byteOffset view', () => {
      const body = new TextEncoder().encode('hi');
      const f = frame(body);
      // Embed the frame inside a larger buffer at a non-zero offset.
      const backing = new Uint8Array(f.length + 3);
      backing.set(f, 3);
      const view = backing.subarray(3);
      expect(new TextDecoder().decode(decodeLengthPrefixedFrame(view))).toBe('hi');
    });

    it('decodes a zero-length body as an empty view', () => {
      // A bare prefix declaring length 0 is the boundary case: available === 0,
      // length === 0, so it neither under- nor over-runs.
      const decoded = decodeLengthPrefixedFrame(new Uint8Array([0, 0, 0, 0]));
      expect(decoded.length).toBe(0);
    });

    it('returns only the declared body, ignoring trailing bytes', () => {
      // declared length < available: the parser uses exactly the declared slice
      // and never reads past it, so trailing wire garbage cannot leak into the
      // decoded body.
      const body = new TextEncoder().encode('hi');
      const f = frame(body); // declares length 2
      const withTrailer = new Uint8Array(f.length + 3);
      withTrailer.set(f, 0);
      withTrailer.set(new TextEncoder().encode('XYZ'), f.length);
      expect(new TextDecoder().decode(decodeLengthPrefixedFrame(withTrailer))).toBe('hi');
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

describe('Seed trust policy', () => {
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
		const seedJson = canonicalSeedPayload(seedData);
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

	/** Inject a fake control DB exposing only the authority-key set used by applySeed. */
	function withKnownAuthorityKeys(service: SeedBootstrapService, keys: string[]) {
		(service as any).controlDatabase = {
			getAuthorityKeys: async () => new Set(keys),
		};
	}

	it('rejects a forged self-asserting seed against an empty AuthorityKey table (default policy)', async () => {
		// The regression: attacker signs a seed that names its own key as an
		// authority peer. Signature is valid, but the receiver has no anchor.
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();
		// No control DB → empty known-authority set, default dbAnchoredTrustPolicy.

		const peers: SeedPeer[] = [
			{
				peerId: '12D3KooWAttacker',
				multiaddrs: ['/ip4/1.2.3.4/tcp/4001'],
				isAuthority: true,
				publicKey: attackerPublicKey,
			},
		];

		const forged = createSignedSeed(attackerPrivateKey, attackerPublicKey, peers);
		const result = await service.applySeed(forged);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/trust policy/i);
	});

	it('DB-anchored accept: signer key present in the AuthorityKey table is trusted', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();
		withKnownAuthorityKeys(service, [authorityPublicKey]);

		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, []);
		const result = await service.applySeed(seed);

		expect(result.success).toBe(true);
	});

	it('pinned-key accept: signer supplied via pinnedKeyTrustPolicy is trusted with an empty DB', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();
		// Empty DB; pin the authority key as if carried by a CadreInvite.

		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, []);
		const result = await service.applySeed(seed, {
			trustPolicy: pinnedKeyTrustPolicy([authorityPublicKey]),
		});

		expect(result.success).toBe(true);
	});

	it('pinned-key reject: a signer not in the pinned set is rejected', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();

		const seed = createSignedSeed(attackerPrivateKey, attackerPublicKey, []);
		const result = await service.applySeed(seed, {
			trustPolicy: pinnedKeyTrustPolicy([authorityPublicKey]),
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/trust policy/i);
	});

	it('TOFU: confirm=false rejects, confirm=true accepts, and confirm is called once with the unknown key', async () => {
		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, []);

		// confirm returns false → rejected
		const declineCalls: string[] = [];
		const declineService = new SeedBootstrapService({ partyId });
		(declineService as any).libp2pNode = createMockLibp2p();
		const declined = await declineService.applySeed(seed, {
			trustPolicy: tofuTrustPolicy(async (ctx) => {
				declineCalls.push(ctx.signerKey);
				return false;
			}),
		});
		expect(declined.success).toBe(false);
		expect(declineCalls).toEqual([authorityPublicKey]);

		// confirm returns true → accepted, invoked exactly once
		const acceptCalls: string[] = [];
		const acceptService = new SeedBootstrapService({ partyId });
		(acceptService as any).libp2pNode = createMockLibp2p();
		const accepted = await acceptService.applySeed(seed, {
			trustPolicy: tofuTrustPolicy(async (ctx) => {
				acceptCalls.push(ctx.signerKey);
				return true;
			}),
		});
		expect(accepted.success).toBe(true);
		expect(acceptCalls).toEqual([authorityPublicKey]);
	});

	it('TOFU does not consult confirm when the key is already DB-anchored', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();
		withKnownAuthorityKeys(service, [authorityPublicKey]);

		let confirmCalls = 0;
		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, []);
		const result = await service.applySeed(seed, {
			trustPolicy: tofuTrustPolicy(async () => {
				confirmCalls++;
				return false;
			}),
		});

		expect(result.success).toBe(true);
		expect(confirmCalls).toBe(0);
	});

	it('signature is still required even with a valid trust anchor', async () => {
		const service = new SeedBootstrapService({ partyId });
		(service as any).libp2pNode = createMockLibp2p();
		withKnownAuthorityKeys(service, [authorityPublicKey]);

		// Valid signer key, but a corrupted signature.
		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, []);
		const tampered: ControlNetworkSeed = { ...seed, signature: 'not-a-valid-signature' };
		const result = await service.applySeed(tampered);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Invalid seed signature');
	});

	it('the configured default policy is used when no per-call override is given', async () => {
		// dbAnchoredTrustPolicy is the documented default; assert behaviourally
		// by configuring an explicit pinned default and omitting the override.
		const service = new SeedBootstrapService({
			partyId,
			trustPolicy: pinnedKeyTrustPolicy([authorityPublicKey]),
		});
		(service as any).libp2pNode = createMockLibp2p();

		const seed = createSignedSeed(authorityPrivateKey, authorityPublicKey, []);
		const result = await service.applySeed(seed);

		expect(result.success).toBe(true);
		// Sanity: the same default rejects a different signer.
		expect(dbAnchoredTrustPolicy().evaluate({
			partyId,
			signerKey: attackerPublicKey,
			knownAuthorityKeys: new Set(),
		})).toMatchObject({ trusted: false });
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

describe('queryPeers — authority identity from the AuthorityKey table', () => {
	/** Build a fake control DB exposing the two surfaces queryPeers consumes. */
	function makeMockControlDb(
		authorityKeys: string[],
		cadrePeers: Array<{ PeerId: string; Multiaddr: string | null }>
	) {
		return {
			getAuthorityKeys: async () => new Set(authorityKeys),
			getDatabase: () => ({
				eval: async function* (sql: string) {
					if (sql.includes('CadrePeer')) {
						for (const p of cadrePeers) yield p;
					}
				},
			}),
		};
	}

	async function peerIdFor(): Promise<{ id: string; keyB64: string }> {
		const key = await generateKeyPair('Ed25519');
		const id = peerIdFromPrivateKey(key).toString();
		const keyB64 = ed25519PublicKeyB64FromPeerId(id);
		expect(keyB64).not.toBeNull();
		return { id, keyB64: keyB64 as string };
	}

	it('derives the same ed25519 key from a PeerId as the libp2p public key bytes', async () => {
		const { id, keyB64 } = await peerIdFor();
		// Round-trip stability: parsing the string twice yields the same key.
		expect(ed25519PublicKeyB64FromPeerId(id)).toBe(keyB64);
	});

	it('marks two distinct authority peers, even though only one could match a local peerId', async () => {
		const a = await peerIdFor();
		const b = await peerIdFor();
		const service = new SeedBootstrapService({ partyId: 'p' });
		(service as any).libp2pNode = { peerId: { toString: () => a.id } };
		(service as any).controlDatabase = makeMockControlDb(
			[a.keyB64, b.keyB64],
			[
				{ PeerId: a.id, Multiaddr: '/ip4/1.1.1.1/tcp/4001' },
				{ PeerId: b.id, Multiaddr: '/ip4/2.2.2.2/tcp/4001' },
			]
		);

		const peers: SeedPeer[] = await (service as any).queryPeers();
		expect(peers).toHaveLength(2);
		const byId = new Map(peers.map((p) => [p.peerId, p]));
		expect(byId.get(a.id)).toMatchObject({ isAuthority: true, publicKey: a.keyB64 });
		expect(byId.get(b.id)).toMatchObject({ isAuthority: true, publicKey: b.keyB64 });
	});

	it('marks a peer whose key is absent from AuthorityKey as non-authority with no publicKey', async () => {
		const authority = await peerIdFor();
		const plain = await peerIdFor();
		const service = new SeedBootstrapService({ partyId: 'p' });
		(service as any).libp2pNode = { peerId: { toString: () => authority.id } };
		(service as any).controlDatabase = makeMockControlDb(
			[authority.keyB64], // plain's key is NOT present
			[{ PeerId: plain.id, Multiaddr: '/ip4/3.3.3.3/tcp/4001' }]
		);

		const peers: SeedPeer[] = await (service as any).queryPeers();
		expect(peers).toHaveLength(1);
		expect(peers[0].isAuthority).toBe(false);
		expect(peers[0].publicKey).toBeUndefined();
	});

	it('treats a non-Ed25519 / unparsable peerId as non-authority without throwing', async () => {
		const service = new SeedBootstrapService({ partyId: 'p' });
		(service as any).libp2pNode = { peerId: { toString: () => 'self' } };
		(service as any).controlDatabase = makeMockControlDb(
			['some-authority-key'],
			[{ PeerId: 'not-a-valid-peer-id', Multiaddr: null }]
		);

		const peers: SeedPeer[] = await (service as any).queryPeers();
		expect(peers).toHaveLength(1);
		expect(peers[0].isAuthority).toBe(false);
		expect(peers[0].publicKey).toBeUndefined();
		expect(peers[0].multiaddrs).toEqual([]);
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

  async function readCadrePeer(
    node: CadreNode,
    peerId: string
  ): Promise<{ PeerId: string; Multiaddr: string | null } | undefined> {
    const db = node.getControlDatabase();
    if (!db) return undefined;
    const inner = db.getDatabase();
    for await (const row of inner.eval(
      'select PeerId, Multiaddr from CadreControl.CadrePeer where PeerId = ?',
      [peerId]
    )) {
      if (row.PeerId === peerId) {
        return {
          PeerId: row.PeerId as string,
          Multiaddr: (row.Multiaddr as string | null) ?? null
        };
      }
    }
    return undefined;
  }

  describe('authorizePeer / removePeer — round-trip against a real control DB', () => {
    /**
     * Boot a real CadreNode + ControlDatabase, insert the authority key,
     * initialize seed bootstrap, then exercise authorizePeer + removePeer
     * end-to-end and read CadrePeer back to confirm the row is gone.
     *
     * This is the integration coverage that the unit tests above can't
     * provide: it validates Quereus' DELETE-with-context syntax against
     * the `AuthorizedInsert` constraint (which signs over `coalesce(new,
     * old).PeerId`).
     */
    it('inserts then deletes a CadrePeer row via authority signature', async () => {
      const node = new CadreNode({
        controlNetwork: {
          partyId: 'test-party-' + Math.random().toString(36).slice(2),
          bootstrapNodes: []
        },
        profile: 'transaction'
      });

      try {
        await node.start();

        const db = node.getControlDatabase();
        expect(db).not.toBeNull();
        await db!.insertAuthorityKey(authorityPublicKey);

        node.initializeSeedBootstrap(authorityPrivateKey);

        // Use a real Ed25519-derived peerId so the value is shape-valid,
        // though the constraint actually only cares about the signature
        // over digest(PeerId, 'sha256', 'utf8').
        const droneKey = await generateKeyPair('Ed25519');
        const dronePeerId = peerIdFromPrivateKey(droneKey).toString();
        const multiaddrs = ['/ip4/192.168.1.100/tcp/4001'];

        await node.authorizePeer(dronePeerId, multiaddrs);

        const after = await readCadrePeer(node, dronePeerId);
        expect(after).toBeDefined();
        expect(after!.Multiaddr).toBe(multiaddrs.join(','));

        await node.removePeer(dronePeerId);

        const removed = await readCadrePeer(node, dronePeerId);
        expect(removed).toBeUndefined();

        // Re-authorize the same peer to exercise the insert→delete→insert
        // cycle through the flat OLD/NEW row layout that deferred constraints
        // walk (the bug this regression test guards against was a NEW.PeerId
        // resolution failure inside the DELETE path's deferred check).
        await node.authorizePeer(dronePeerId, multiaddrs);
        const reAuthorized = await readCadrePeer(node, dronePeerId);
        expect(reAuthorized).toBeDefined();
        expect(reAuthorized!.Multiaddr).toBe(multiaddrs.join(','));
      } finally {
        await node.stop();
      }
    }, 60_000);
  });

  describe('applySeed — DB-anchored trust against a real control DB', () => {
    /**
     * End-to-end coverage the mocked unit tests can't give: a live Quereus
     * control DB feeds `getAuthorityKeys()`, which the default
     * `dbAnchoredTrustPolicy` consults. Proves the real `select Key from
     * AuthorityKey` round-trips into the security gate — an anchored signer is
     * accepted and an unanchored one rejected — with no per-call override.
     */
    function signSeed(privateKey: string, publicKey: string): ControlNetworkSeed {
      const seedData = { partyId, peers: [] as SeedPeer[] };
      const seedJson = canonicalSeedPayload(seedData);
      const seedDigest = digest(seedJson, 'sha256', 'utf8', 'base64url') as string;
      const signature = sign(
        seedDigest, privateKey, 'ed25519', 'base64url', 'base64url', 'base64url'
      ) as string;
      return { ...seedData, signature, signerKey: publicKey };
    }

    it('accepts an anchored signer and rejects an unanchored one via the live AuthorityKey table', async () => {
      const node = new CadreNode({
        controlNetwork: {
          partyId: 'test-party-' + Math.random().toString(36).slice(2),
          bootstrapNodes: []
        },
        profile: 'transaction'
      });

      try {
        await node.start();

        const db = node.getControlDatabase();
        expect(db).not.toBeNull();
        await db!.insertAuthorityKey(authorityPublicKey);

        node.initializeSeedBootstrap(authorityPrivateKey);

        // The live table returns exactly the inserted key.
        expect(await db!.getAuthorityKeys()).toEqual(new Set([authorityPublicKey]));

        // Anchored signer → accepted by the default DB-anchored policy, no override.
        const accepted = await node.applySeed(signSeed(authorityPrivateKey, authorityPublicKey));
        expect(accepted.success).toBe(true);

        // Unanchored signer → rejected by the same default against the live table.
        const attackerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
        const attackerPublicKey = getPublicKey(attackerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
        const rejected = await node.applySeed(signSeed(attackerPrivateKey, attackerPublicKey));
        expect(rejected.success).toBe(false);
        expect(rejected.error).toMatch(/trust policy/i);
      } finally {
        await node.stop();
      }
    }, 60_000);
  });

  describe('createInvite — inviteAddressResolver hook', () => {
    function makeMockLibp2p(rawAddrs: string[]) {
      return {
        getMultiaddrs: () => rawAddrs.map((a) => ({ toString: () => a })),
      };
    }

    it('uses libp2pNode.getMultiaddrs() when no resolver is configured', async () => {
      const service = new SeedBootstrapService({ partyId });
      (service as any).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);

      const { invite } = await service.createInvite();
      expect(invite.authorityAddrs).toEqual(['/ip4/192.168.1.10/tcp/4001']);
    });

    it('uses the resolver when configured (NAT host substitutes DDNS hostname)', async () => {
      const resolver = async () => ['/dns4/foo.duckdns.org/tcp/4001/p2p/12D3KooWHost'];
      const service = new SeedBootstrapService({ partyId, inviteAddressResolver: resolver });
      (service as any).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);

      const { invite } = await service.createInvite();
      expect(invite.authorityAddrs).toEqual(['/dns4/foo.duckdns.org/tcp/4001/p2p/12D3KooWHost']);
    });

    it('falls back to libp2pNode.getMultiaddrs() when the resolver throws', async () => {
      const resolver = async () => { throw new Error('boom'); };
      const service = new SeedBootstrapService({ partyId, inviteAddressResolver: resolver });
      (service as any).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);

      const { invite } = await service.createInvite();
      expect(invite.authorityAddrs).toEqual(['/ip4/192.168.1.10/tcp/4001']);
    });

    it('carries the AuthorityKey table as invite.authorityKeys', async () => {
      const service = new SeedBootstrapService({ partyId });
      (service as any).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);
      (service as any).controlDatabase = {
        getAuthorityKeys: async () => new Set([authorityPublicKey, 'second-authority-key']),
      };

      const { invite } = await service.createInvite();
      expect(invite.authorityKeys).toBeDefined();
      expect(new Set(invite.authorityKeys)).toEqual(
        new Set([authorityPublicKey, 'second-authority-key'])
      );
    });

    it('omits authorityKeys when the AuthorityKey table is empty', async () => {
      const service = new SeedBootstrapService({ partyId });
      (service as any).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);
      (service as any).controlDatabase = {
        getAuthorityKeys: async () => new Set<string>(),
      };

      const { invite } = await service.createInvite();
      expect(invite.authorityKeys).toBeUndefined();
    });
  });
});

describe('registerSelf — authority self-registration into CadrePeer', () => {
  /** Minimal libp2p surface the receiver's applySeed consumes (merge + dial). */
  function makeReceiverLibp2p() {
    return {
      peerStore: { merge: async () => {} },
      dial: async () => {},
    };
  }

  /**
   * The CLI `--authority` shape: the node's libp2p identity key IS its authority
   * key (authorityKeyFromLibp2p), so it can authority-sign the INSERT of its OWN
   * self-signed address record. This is the gap the implement ticket closes —
   * before registerSelf the authority is absent from the seed it mints; after,
   * the seed carries it as an authority peer, and a receiver that trusts the
   * signer accepts it.
   *
   * NOTE: the ticket described the receiver check as a literal
   * `seed.peers.some(p => p.isAuthority && p.publicKey === seed.signerKey)` gate.
   * That inline gate was superseded by the pluggable trust-policy design (see
   * `applySeed`); this test asserts the still-true contract — the authority is
   * present in the seed AND a signer-trusting receiver applies it successfully.
   */
  it('inserts the authority into CadrePeer so seeds include it, and a receiver accepts the seed', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(nodeKey);

    const node = new CadreNode({
      controlNetwork: {
        partyId: 'self-reg-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      privateKey: nodeKey,
      profile: 'transaction',
    });

    try {
      await node.start();
      const selfPeerId = node.peerId!.toString();

      // Neutralize the 1s background self-registration timer so this test's
      // explicit registerSelf() calls are the sole writers — the insert/refresh
      // outcomes are then deterministic (no timer racing an INSERT in). The
      // single-flight guard in registerSelf is what makes that race harmless in
      // production; here we simply remove it for a clean assertion.
      clearTimeout((node as any).selfRegistrationTimer);
      (node as any).selfRegistrationTimer = null;

      node.initializeSeedBootstrap(privateKeyB64);

      // Before self-registration the authority is not a CadrePeer, so the seed
      // it mints omits its own peer.
      const before = await node.createSeed();
      expect(before.peers.some((p) => p.peerId === selfPeerId)).toBe(false);

      // Enable authority-signed inserts, then self-register up-front.
      const db = node.getControlDatabase();
      expect(db).not.toBeNull();
      await db!.insertAuthorityKey(publicKeyB64);

      const outcome = await node.registerSelf();
      expect(outcome).toBe('inserted');

      // The seed now carries the authority as an authority peer whose key is the
      // seed's own signer.
      const after = await node.createSeed();
      const selfPeer = after.peers.find((p) => p.peerId === selfPeerId);
      expect(selfPeer).toBeDefined();
      expect(selfPeer!.isAuthority).toBe(true);
      expect(after.signerKey).toBe(publicKeyB64);
      expect(selfPeer!.publicKey).toBe(after.signerKey);

      // A second node accepts the seed once it trusts the signer (pinned key) —
      // the signer is now backed by an authority peer the seed carries.
      const receiver = new SeedBootstrapService({ partyId: after.partyId });
      (receiver as any).libp2pNode = makeReceiverLibp2p();
      const applied = await receiver.applySeed(after, {
        trustPolicy: pinnedKeyTrustPolicy([after.signerKey]),
      });
      expect(applied.success).toBe(true);

      // registerSelf is idempotent: a second call refreshes the existing row.
      const refreshed = await node.registerSelf();
      expect(refreshed).toBe('refreshed');
    } finally {
      await node.stop();
    }
  }, 60_000);

  /**
   * Regression guard for the single-flight semantics of registerSelf. Two truly
   * concurrent callers (the CLI's explicit `--authority` publish + a background
   * timer is the production shape) must collapse into ONE publish: without the
   * `registerSelfInFlight` guard both would observe "no row yet", both attempt
   * the authority-signed INSERT, and the loser would reject on a CadrePeer PK
   * conflict — which, for the awaited CLI call, exits the authority node.
   */
  it('collapses concurrent registerSelf calls into a single INSERT (no PK-conflict race)', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(nodeKey);

    const node = new CadreNode({
      controlNetwork: {
        partyId: 'self-reg-race-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      privateKey: nodeKey,
      profile: 'transaction',
    });

    try {
      await node.start();
      const selfPeerId = node.peerId!.toString();
      clearTimeout((node as any).selfRegistrationTimer);
      (node as any).selfRegistrationTimer = null;

      node.initializeSeedBootstrap(privateKeyB64);
      const db = node.getControlDatabase();
      await db!.insertAuthorityKey(publicKeyB64);

      // Fire both before either has a chance to settle. The guard makes the
      // second join the first's in-flight publish, so neither hits a conflict
      // and both observe the same 'inserted' outcome.
      const [a, b] = await Promise.all([node.registerSelf(), node.registerSelf()]);
      expect([a, b].sort()).toEqual(['inserted', 'inserted']);

      // Exactly one CadrePeer row for self resulted from the two calls.
      const seed = await node.createSeed();
      expect(seed.peers.filter((p) => p.peerId === selfPeerId)).toHaveLength(1);
    } finally {
      await node.stop();
    }
  }, 60_000);
});

