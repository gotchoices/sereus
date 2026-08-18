import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generatePrivateKey, getPublicKey, digest, sign } from '@optimystic/quereus-plugin-crypto';
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
  anchoredTrustPolicy,
  pinnedKeyTrustPolicy,
  tofuTrustPolicy
} from '../src/seed-trust-policy.js';
import { MemoryTrustedOwnerStore, type TrustSource } from '../src/trusted-owner-store.js';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import type {
  ControlNetworkSeed,
  SeedPeer,
  SeedMessage,
  SeedAckMessage,
  CadreInvite,
  DroneInitResult,
  InviteResult
} from '../src/types.js';
import { CapturingStream, decodeFrames, duplexPair, frameMessage, NeverEndingStream, PausableStream } from './wake-stream-helpers.js';

/**
 * Test-only window into the private SeedBootstrapService surface these specs
 * inject mocks into / invoke. The injected mocks are deliberately partial, so
 * the fields are typed `unknown`; we cast through `unknown` because the real
 * fields are private on the service.
 */
interface SeedServiceTestInternals {
  libp2pNode: unknown;
  controlDatabase: unknown;
  queryPeers(): Promise<SeedPeer[]>;
}

function serviceInternals(service: SeedBootstrapService): SeedServiceTestInternals {
  return service as unknown as SeedServiceTestInternals;
}

/** Invoke the extracted private inbound-seed handler seam directly. */
function runHandleSeedStream(
  service: SeedBootstrapService,
  stream: unknown,
  remotePeerId: string
): Promise<void> {
  return (service as unknown as {
    handleSeedStream(s: unknown, p: string): Promise<void>;
  }).handleSeedStream(stream, remotePeerId);
}

/** Test-only window into the private CadreNode timer these specs neutralize. */
interface CadreNodeTestInternals {
  selfRegistrationTimer: ReturnType<typeof setTimeout> | null;
}

function cadreNodeInternals(node: CadreNode): CadreNodeTestInternals {
  return node as unknown as CadreNodeTestInternals;
}

describe('SeedBootstrapService', () => {
  let ownerPrivateKey: string;
  let ownerPublicKey: string;
  const partyId = 'test-party-123';

  beforeEach(() => {
    // Generate a fresh owner key pair for each test
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  describe('constructor', () => {
    it('should create service with party ID', () => {
      const service = new SeedBootstrapService({ partyId });
      expect(service).toBeDefined();
    });

    it('should derive public key from private key', () => {
      const service = new SeedBootstrapService({
        partyId,
        ownerPrivateKey
      });
      expect(service).toBeDefined();
    });

    it('should accept explicit public key', () => {
      const service = new SeedBootstrapService({
        partyId,
        ownerPrivateKey,
        ownerPublicKey
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
            isOwner: true
          }
        ],
        signature: 'test-signature',
        signerKey: ownerPublicKey
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
            isOwner: true
          }
        ]
      };

      // Sign the seed over the canonical payload (key-order independent)
      const seedJson = canonicalSeedPayload(seedData);
      const seedDigest = digest([seedJson], 'sha256', 'base64url') as string;
      const signature = sign(
        seedDigest,
        ownerPrivateKey,
        'ed25519',
        'base64url',
        'base64url',
        'base64url'
      ) as string;

      const seed: ControlNetworkSeed = {
        ...seedData,
        signature,
        signerKey: ownerPublicKey
      };

      expect(service.validateSeedSignature(seed)).toBe(true);
    });

    it('should reject an incorrectly signed seed', () => {
      const service = new SeedBootstrapService({ partyId });

      const seed: ControlNetworkSeed = {
        partyId,
        peers: [],
        signature: 'invalid-signature',
        signerKey: ownerPublicKey
      };

      expect(service.validateSeedSignature(seed)).toBe(false);
    });

    it('should reject a seed with tampered data', () => {
      const service = new SeedBootstrapService({ partyId });

      // Create and sign original seed
      const originalData = { partyId, peers: [] };
      const seedJson = canonicalSeedPayload(originalData);
      const seedDigest = digest([seedJson], 'sha256', 'base64url') as string;
      const signature = sign(
        seedDigest,
        ownerPrivateKey,
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
        signerKey: ownerPublicKey
      };

      expect(service.validateSeedSignature(tamperedSeed)).toBe(false);
    });
  });

  describe('canonical seed signing', () => {
    function signSeed(privateKey: string, publicKey: string, seedData: {
      partyId: string;
      peers: SeedPeer[];
    }): ControlNetworkSeed {
      const seedDigest = digest([canonicalSeedPayload(seedData)], 'sha256', 'base64url') as string;
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
        isOwner: true,
        publicKey: ownerPublicKey,
      };
      const seed = signSeed(ownerPrivateKey, ownerPublicKey, { partyId, peers: [peerA] });

      // Rebuild the peer with keys in a different insertion order.
      const reordered: ControlNetworkSeed = {
        ...seed,
        peers: [{
          publicKey: ownerPublicKey,
          isOwner: true,
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
        isOwner: true
      };

      expect(peer.peerId).toBe('12D3KooWTestPeer');
      expect(peer.multiaddrs).toHaveLength(1);
      expect(peer.isOwner).toBe(true);
    });

    it('should allow empty multiaddrs', () => {
      const peer: SeedPeer = {
        peerId: '12D3KooWTestPeer',
        multiaddrs: [],
        isOwner: false
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
          { peerId: 'peer1', multiaddrs: [], isOwner: true }
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
        ownerAddrs: ['/ip4/1.2.3.4/tcp/4001'],
        createdAt: Date.now()
      };

      expect(invite.partyId).toBe('test-party');
      expect(invite.ownerAddrs).toHaveLength(1);
      expect(invite.createdAt).toBeGreaterThan(0);
    });

    it('should allow optional token and expiration', () => {
      const now = Date.now();
      const invite: CadreInvite = {
        partyId: 'test-party',
        ownerAddrs: [],
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
          ownerAddrs: ['/ip4/1.2.3.4/tcp/4001'],
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
	let ownerPrivateKey: string;
	let ownerPublicKey: string;
	let attackerPrivateKey: string;
	let attackerPublicKey: string;
	const partyId = 'test-party-vuln';

	beforeEach(() => {
		ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
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
		const seedDigest = digest([seedJson], 'sha256', 'base64url') as string;
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

	/**
	 * A node-local anchor pre-loaded with out-of-band-trusted owner keys — the
	 * ONLY source `applySeed` consults for `knownOwnerKeys`. `trust()` reflects
	 * synchronously (durability is the returned promise), so `void` is correct here.
	 */
	function anchorWith(keys: string[]): MemoryTrustedOwnerStore {
		const store = new MemoryTrustedOwnerStore(partyId);
		for (const key of keys) {
			void store.trust(key, 'operator');
		}
		return store;
	}

	/** Inject a fake control DB exposing only the replicated owner-key set. */
	function withReplicatedOwnerKeys(service: SeedBootstrapService, keys: string[]) {
		serviceInternals(service).controlDatabase = {
			getOwnerKeys: async () => new Set(keys),
		};
	}

	it('rejects a forged self-asserting seed against an empty anchor (default policy)', async () => {
		// The regression: attacker signs a seed that names its own key as an
		// owner peer. Signature is valid, but the receiver has no anchor.
		const service = new SeedBootstrapService({ partyId });
		serviceInternals(service).libp2pNode = createMockLibp2p();
		// No anchor → empty known-owner set, default anchoredTrustPolicy.

		const peers: SeedPeer[] = [
			{
				peerId: '12D3KooWAttacker',
				multiaddrs: ['/ip4/1.2.3.4/tcp/4001'],
				isOwner: true,
				publicKey: attackerPublicKey,
			},
		];

		const forged = createSignedSeed(attackerPrivateKey, attackerPublicKey, peers);
		const result = await service.applySeed(forged);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/trust policy/i);
	});

	it('anchored accept: signer key present in the node-local anchor is trusted', async () => {
		const service = new SeedBootstrapService({
			partyId,
			trustedOwners: anchorWith([ownerPublicKey]),
		});
		serviceInternals(service).libp2pNode = createMockLibp2p();

		const seed = createSignedSeed(ownerPrivateKey, ownerPublicKey, []);
		const result = await service.applySeed(seed);

		expect(result.success).toBe(true);
	});

	it('a key present ONLY via replication does not authorize a seed', async () => {
		// The hole this closes: an attacker that reaches the control network can
		// genesis-insert its own key into the REPLICATED OwnerKey table, which then
		// syncs into every peer's copy. Seed trust must not consult that table — the
		// same self-authority trick that beat the membership predicate.
		const service = new SeedBootstrapService({
			partyId,
			// Anchor holds the real owner; the replicated table also holds the attacker.
			trustedOwners: anchorWith([ownerPublicKey]),
		});
		serviceInternals(service).libp2pNode = createMockLibp2p();
		withReplicatedOwnerKeys(service, [ownerPublicKey, attackerPublicKey]);

		const forged = createSignedSeed(attackerPrivateKey, attackerPublicKey, []);
		const rejected = await service.applySeed(forged);
		expect(rejected.success).toBe(false);
		expect(rejected.error).toMatch(/trust policy/i);

		// Same service, same table: the ANCHORED owner is still accepted, so the
		// rejection above is the anchor at work, not a blanket failure.
		const legit = await service.applySeed(createSignedSeed(ownerPrivateKey, ownerPublicKey, []));
		expect(legit.success).toBe(true);
	});

	it('an anchored key is trusted even when the replicated table is empty', async () => {
		// The converse: replication has not delivered anything (or was wiped), but
		// the out-of-band anchor still authorizes its owner.
		const service = new SeedBootstrapService({
			partyId,
			trustedOwners: anchorWith([ownerPublicKey]),
		});
		serviceInternals(service).libp2pNode = createMockLibp2p();
		withReplicatedOwnerKeys(service, []);

		const result = await service.applySeed(createSignedSeed(ownerPrivateKey, ownerPublicKey, []));
		expect(result.success).toBe(true);
	});

	it('pinned-key accept: signer supplied via pinnedKeyTrustPolicy is trusted with an empty anchor', async () => {
		const service = new SeedBootstrapService({ partyId });
		serviceInternals(service).libp2pNode = createMockLibp2p();
		// Empty DB; pin the owner key as if carried by a CadreInvite.

		const seed = createSignedSeed(ownerPrivateKey, ownerPublicKey, []);
		const result = await service.applySeed(seed, {
			trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey]),
		});

		expect(result.success).toBe(true);
	});

	it('pinned-key reject: a signer not in the pinned set is rejected', async () => {
		const service = new SeedBootstrapService({ partyId });
		serviceInternals(service).libp2pNode = createMockLibp2p();

		const seed = createSignedSeed(attackerPrivateKey, attackerPublicKey, []);
		const result = await service.applySeed(seed, {
			trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey]),
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/trust policy/i);
	});

	it('TOFU: confirm=false rejects, confirm=true accepts, and confirm is called once with the unknown key', async () => {
		const seed = createSignedSeed(ownerPrivateKey, ownerPublicKey, []);

		// confirm returns false → rejected
		const declineCalls: string[] = [];
		const declineService = new SeedBootstrapService({ partyId });
		serviceInternals(declineService).libp2pNode = createMockLibp2p();
		const declined = await declineService.applySeed(seed, {
			trustPolicy: tofuTrustPolicy(async (ctx) => {
				declineCalls.push(ctx.signerKey);
				return false;
			}),
		});
		expect(declined.success).toBe(false);
		expect(declineCalls).toEqual([ownerPublicKey]);

		// confirm returns true → accepted, invoked exactly once
		const acceptCalls: string[] = [];
		const acceptService = new SeedBootstrapService({ partyId });
		serviceInternals(acceptService).libp2pNode = createMockLibp2p();
		const accepted = await acceptService.applySeed(seed, {
			trustPolicy: tofuTrustPolicy(async (ctx) => {
				acceptCalls.push(ctx.signerKey);
				return true;
			}),
		});
		expect(accepted.success).toBe(true);
		expect(acceptCalls).toEqual([ownerPublicKey]);
	});

	it('TOFU does not consult confirm when the key is already anchored', async () => {
		const service = new SeedBootstrapService({
			partyId,
			trustedOwners: anchorWith([ownerPublicKey]),
		});
		serviceInternals(service).libp2pNode = createMockLibp2p();

		let confirmCalls = 0;
		const seed = createSignedSeed(ownerPrivateKey, ownerPublicKey, []);
		const result = await service.applySeed(seed, {
			trustPolicy: tofuTrustPolicy(async () => {
				confirmCalls++;
				return false;
			}),
		});

		expect(result.success).toBe(true);
		expect(confirmCalls).toBe(0);
	});

	it('a pin-accepted signer is persisted into the anchor, so the next seed needs no pin', async () => {
		// Enrollment supplies the pin once (CadreInvite.ownerKeys) and the key
		// sticks in the node-local anchor, rather than being re-supplied per seed.
		const anchor = anchorWith([]);
		const service = new SeedBootstrapService({ partyId, trustedOwners: anchor });
		serviceInternals(service).libp2pNode = createMockLibp2p();
		const seed = createSignedSeed(ownerPrivateKey, ownerPublicKey, []);

		expect(anchor.has(ownerPublicKey)).toBe(false);
		const first = await service.applySeed(seed, {
			trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey]),
		});
		expect(first.success).toBe(true);
		expect(anchor.has(ownerPublicKey)).toBe(true);

		// Same seed, no pin: the default anchored policy now accepts it.
		const second = await service.applySeed(seed);
		expect(second.success).toBe(true);
	});

	it('an operator-sourced pin is persisted under operator provenance, not invite', async () => {
		// `pinnedKeyTrustPolicy`'s second argument is the seam an operator pin uses
		// so the anchor does not record it as having arrived via an invite.
		const anchor = anchorWith([]);
		const recorded: Array<[string, TrustSource]> = [];
		const service = new SeedBootstrapService({
			partyId,
			trustedOwners: {
				partyId,
				has: (key: string) => anchor.has(key),
				all: () => anchor.all(),
				trust: async (key: string, source: TrustSource) => {
					recorded.push([key, source]);
					await anchor.trust(key, source);
				},
			},
		});
		serviceInternals(service).libp2pNode = createMockLibp2p();

		const result = await service.applySeed(createSignedSeed(ownerPrivateKey, ownerPublicKey, []), {
			trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey], 'operator'),
		});
		expect(result.success).toBe(true);
		expect(recorded).toEqual([[ownerPublicKey, 'operator']]);
	});

	it('a TOFU-confirmed signer is persisted into the anchor, so confirm is not re-prompted', async () => {
		const anchor = anchorWith([]);
		const service = new SeedBootstrapService({ partyId, trustedOwners: anchor });
		serviceInternals(service).libp2pNode = createMockLibp2p();
		const seed = createSignedSeed(ownerPrivateKey, ownerPublicKey, []);

		let confirmCalls = 0;
		const policy = tofuTrustPolicy(async () => { confirmCalls++; return true; });

		expect((await service.applySeed(seed, { trustPolicy: policy })).success).toBe(true);
		expect(confirmCalls).toBe(1);
		expect(anchor.has(ownerPublicKey)).toBe(true);

		// Anchored now: the TOFU policy short-circuits before confirm.
		expect((await service.applySeed(seed, { trustPolicy: policy })).success).toBe(true);
		expect(confirmCalls).toBe(1);
	});

	it('a REJECTED signer is never persisted into the anchor', async () => {
		const anchor = anchorWith([]);
		const service = new SeedBootstrapService({ partyId, trustedOwners: anchor });
		serviceInternals(service).libp2pNode = createMockLibp2p();
		const forged = createSignedSeed(attackerPrivateKey, attackerPublicKey, []);

		// Default anchored policy rejects; a declined TOFU rejects.
		expect((await service.applySeed(forged)).success).toBe(false);
		expect((await service.applySeed(forged, {
			trustPolicy: tofuTrustPolicy(async () => false),
		})).success).toBe(false);

		expect(anchor.has(attackerPublicKey)).toBe(false);
		expect(anchor.all().size).toBe(0);
	});

	it('an anchor persist failure does not fail the seed (the key is trusted for the session)', async () => {
		// trust() reflects synchronously; only durability is deferred. A file-backed
		// anchor whose write fails must not turn a legitimate seed into an error.
		const anchor = anchorWith([]);
		const failing = {
			partyId,
			has: (k: string) => anchor.has(k),
			all: () => anchor.all(),
			trust: async () => { throw new Error('disk full'); },
		};
		const service = new SeedBootstrapService({ partyId, trustedOwners: failing });
		serviceInternals(service).libp2pNode = createMockLibp2p();

		const result = await service.applySeed(createSignedSeed(ownerPrivateKey, ownerPublicKey, []), {
			trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey]),
		});
		expect(result.success).toBe(true);
	});

	it('signature is still required even with a valid trust anchor', async () => {
		const service = new SeedBootstrapService({
			partyId,
			trustedOwners: anchorWith([ownerPublicKey]),
		});
		serviceInternals(service).libp2pNode = createMockLibp2p();

		// Valid signer key, but a corrupted signature.
		const seed = createSignedSeed(ownerPrivateKey, ownerPublicKey, []);
		const tampered: ControlNetworkSeed = { ...seed, signature: 'not-a-valid-signature' };
		const result = await service.applySeed(tampered);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Invalid seed signature');
	});

	it('the configured default policy is used when no per-call override is given', async () => {
		// anchoredTrustPolicy is the documented default; assert behaviourally
		// by configuring an explicit pinned default and omitting the override.
		const service = new SeedBootstrapService({
			partyId,
			trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey]),
		});
		serviceInternals(service).libp2pNode = createMockLibp2p();

		const seed = createSignedSeed(ownerPrivateKey, ownerPublicKey, []);
		const result = await service.applySeed(seed);

		expect(result.success).toBe(true);
		// Sanity: the same default rejects a different signer.
		expect(anchoredTrustPolicy().evaluate({
			partyId,
			signerKey: attackerPublicKey,
			knownOwnerKeys: new Set(),
		})).toMatchObject({ trusted: false });
	});

	it('SeedPeer should support publicKey field for owner peers', () => {
		const peer: SeedPeer = {
			peerId: '12D3KooWTestPeer',
			multiaddrs: [],
			isOwner: true,
			publicKey: ownerPublicKey,
		};

		expect(peer.publicKey).toBe(ownerPublicKey);
	});
});

describe('queryPeers — owner identity from the OwnerKey table', () => {
	/**
	 * Build a fake control DB exposing the two surfaces queryPeers consumes.
	 * `queryCadrePeers` stands in for the REAL reader, which already drops rows whose
	 * StampId is retired in Revocation — hence `revoked`, applied here so the fake
	 * cannot hand queryPeers a row the database would never have returned.
	 */
	function makeMockControlDb(
		ownerKeys: string[],
		cadrePeers: Array<{ PeerId: string; Multiaddr: string | null; StampId?: string | null }>,
		revoked: Set<string> = new Set<string>()
	) {
		return {
			getOwnerKeys: async () => new Set(ownerKeys),
			queryCadrePeers: async () => cadrePeers
				.filter((p) => p.StampId == null || !revoked.has(p.StampId))
				.map((p) => ({
					peerId: p.PeerId,
					multiaddr: p.Multiaddr,
					stampId: p.StampId ?? null,
					vouchOwner: null,
					vouchSig: null,
				})),
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

	it('marks two distinct owner peers, even though only one could match a local peerId', async () => {
		const a = await peerIdFor();
		const b = await peerIdFor();
		const service = new SeedBootstrapService({ partyId: 'p' });
		serviceInternals(service).libp2pNode = { peerId: { toString: () => a.id } };
		serviceInternals(service).controlDatabase = makeMockControlDb(
			[a.keyB64, b.keyB64],
			[
				{ PeerId: a.id, Multiaddr: '/ip4/1.1.1.1/tcp/4001' },
				{ PeerId: b.id, Multiaddr: '/ip4/2.2.2.2/tcp/4001' },
			]
		);

		const peers: SeedPeer[] = await serviceInternals(service).queryPeers();
		expect(peers).toHaveLength(2);
		const byId = new Map(peers.map((p) => [p.peerId, p]));
		expect(byId.get(a.id)).toMatchObject({ isOwner: true, publicKey: a.keyB64 });
		expect(byId.get(b.id)).toMatchObject({ isOwner: true, publicKey: b.keyB64 });
	});

	it('marks a peer whose key is absent from OwnerKey as non-owner with no publicKey', async () => {
		const owner = await peerIdFor();
		const plain = await peerIdFor();
		const service = new SeedBootstrapService({ partyId: 'p' });
		serviceInternals(service).libp2pNode = { peerId: { toString: () => owner.id } };
		serviceInternals(service).controlDatabase = makeMockControlDb(
			[owner.keyB64], // plain's key is NOT present
			[{ PeerId: plain.id, Multiaddr: '/ip4/3.3.3.3/tcp/4001' }]
		);

		const peers: SeedPeer[] = await serviceInternals(service).queryPeers();
		expect(peers).toHaveLength(1);
		expect(peers[0].isOwner).toBe(false);
		expect(peers[0].publicKey).toBeUndefined();
	});

	it('omits a peer whose stamp is retired, so a removed member never rides out in a seed', async () => {
		// The seed is an ADDRESS bundle: applySeed writes every peer's addrs into the
		// joiner's peerstore and dials the owner-flagged ones. A revoked peer is off the
		// addressable surface, so it must not ride out in a seed either — enforced by
		// reading through queryCadrePeers rather than selecting CadrePeer raw.
		const owner = await peerIdFor();
		const removed = await peerIdFor();
		const service = new SeedBootstrapService({ partyId: 'p' });
		serviceInternals(service).libp2pNode = { peerId: { toString: () => owner.id } };
		serviceInternals(service).controlDatabase = makeMockControlDb(
			[owner.keyB64],
			[
				{ PeerId: owner.id, Multiaddr: '/ip4/1.1.1.1/tcp/4001', StampId: 'stamp-owner' },
				{ PeerId: removed.id, Multiaddr: '/ip4/9.9.9.9/tcp/4001', StampId: 'stamp-removed' },
			],
			new Set(['stamp-removed'])
		);

		const peers: SeedPeer[] = await serviceInternals(service).queryPeers();
		expect(peers.map((p) => p.peerId)).toEqual([owner.id]);
	});

	it('treats a non-Ed25519 / unparsable peerId as non-owner without throwing', async () => {
		const service = new SeedBootstrapService({ partyId: 'p' });
		serviceInternals(service).libp2pNode = { peerId: { toString: () => 'self' } };
		serviceInternals(service).controlDatabase = makeMockControlDb(
			['some-owner-key'],
			[{ PeerId: 'not-a-valid-peer-id', Multiaddr: null }]
		);

		const peers: SeedPeer[] = await serviceInternals(service).queryPeers();
		expect(peers).toHaveLength(1);
		expect(peers[0].isOwner).toBe(false);
		expect(peers[0].publicKey).toBeUndefined();
		expect(peers[0].multiaddrs).toEqual([]);
	});
});

describe('SeedBootstrapService Helper Methods', () => {
  let ownerPrivateKey: string;
  let ownerPublicKey: string;
  const partyId = 'test-party-456';

  beforeEach(() => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  describe('encodeInvite / decodeInvite', () => {
    it('should encode and decode an invite', () => {
      const service = new SeedBootstrapService({ partyId });

      const invite: CadreInvite = {
        partyId,
        ownerAddrs: ['/ip4/192.168.1.1/tcp/4001', '/ip4/10.0.0.1/tcp/4001'],
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
        ownerAddrs: [],
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
        ownerPrivateKey
      });

      const expiredInvite: CadreInvite = {
        partyId,
        ownerAddrs: [],
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
        ownerPrivateKey
      });

      const invite: CadreInvite = {
        partyId,
        ownerAddrs: [],
        token: 'correct-token',
        createdAt: Date.now()
      };

      await expect(
        service.acceptPhone({ phonePeerId: '12D3KooWTestPhone', token: 'wrong-token' }, invite)
      ).rejects.toThrow('Invalid invite token');
    });
  });

  describe('removePeer', () => {
    it('requires an owner private key', async () => {
      const service = new SeedBootstrapService({ partyId });
      await expect(service.removePeer('12D3KooWTestPeer'))
        .rejects.toThrow('Owner private key required');
    });

    it('requires the control database to be initialized', async () => {
      const service = new SeedBootstrapService({ partyId, ownerPrivateKey });
      await expect(service.removePeer('12D3KooWTestPeer'))
        .rejects.toThrow('Control database not initialized');
    });
  });

  describe('authorizePeer', () => {
    it('checks the control database before the owner key', async () => {
      const service = new SeedBootstrapService({ partyId, ownerPrivateKey });
      await expect(service.authorizePeer({ peerId: '12D3KooWTestPeer' }))
        .rejects.toThrow('Control database not initialized');
    });
  });

  describe('reauthorizePeer', () => {
    it('requires an owner private key even with no control database attached', async () => {
      const service = new SeedBootstrapService({ partyId });
      await expect(service.reauthorizePeer('12D3KooWTestPeer', Date.now()))
        .rejects.toThrow('Owner private key required');
    });
  });

  /**
   * The node's materialized per-stream-gate snapshot (`authorizedControlPeers`).
   * Private, and deliberately read WITHOUT any refresh call: the point of the
   * assertions below is that a committed `CadrePeer` write refreshes it on its own.
   */
  function gateSnapshot(node: CadreNode): Set<string> {
    return (node as unknown as { authorizedControlPeers: Set<string> }).authorizedControlPeers;
  }

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
     * Boot a real CadreNode + ControlDatabase, insert the owner key,
     * initialize seed bootstrap, then exercise authorizePeer + removePeer
     * end-to-end and read CadrePeer back to confirm the row is gone.
     *
     * This is the integration coverage that the unit tests above can't
     * provide: it validates Quereus' DELETE-with-context syntax against
     * the `AuthorizedInsert` constraint (which signs over `coalesce(new,
     * old).PeerId`).
     */
    it('inserts then deletes a CadrePeer row via owner signature', async () => {
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
        await db!.insertOwnerKey(ownerPublicKey);

        node.initializeSeedBootstrap(ownerPrivateKey);

        // Use a real Ed25519-derived peerId so the value is shape-valid,
        // though the constraint actually only cares about the owner voucher
        // signature over the tagged (PeerId, StampId) digest.
        const droneKey = await generateKeyPair('Ed25519');
        const dronePeerId = peerIdFromPrivateKey(droneKey).toString();
        const multiaddrs = ['/ip4/192.168.1.100/tcp/4001'];

        await node.authorizePeer(dronePeerId, multiaddrs);

        const after = await readCadrePeer(node, dronePeerId);
        expect(after).toBeDefined();
        expect(after!.Multiaddr).toBe(multiaddrs.join(','));
        // …and the per-stream gate already knows about it. No test code refreshed
        // it: the committed write notified the control DB's membership hub, which
        // is wired to the gate in `start()`.
        expect(gateSnapshot(node).has(dronePeerId)).toBe(true);

        // Capture the row's stamp before removal: removePeer must retire it into
        // CadreControl.Revocation in the same transaction as the delete.
        const removedStampId = await db!.queryCadrePeerStampId(dronePeerId);
        expect(removedStampId).not.toBeNull();

        await node.removePeer(dronePeerId);

        const removed = await readCadrePeer(node, dronePeerId);
        expect(removed).toBeUndefined();
        // The delete notifies the same hub, so the gate has already dropped it.
        expect(gateSnapshot(node).has(dronePeerId)).toBe(false);
        expect((await db!.queryRevokedStamps('CadrePeer')).has(removedStampId!)).toBe(true);

        // Re-authorize the same peer to exercise the insert→delete→insert
        // cycle through the flat OLD/NEW row layout that deferred constraints
        // walk (the bug this regression test guards against was a NEW.PeerId
        // resolution failure inside the DELETE path's deferred check).
        await node.authorizePeer(dronePeerId, multiaddrs);
        const reAuthorized = await readCadrePeer(node, dronePeerId);
        expect(reAuthorized).toBeDefined();
        expect(reAuthorized!.Multiaddr).toBe(multiaddrs.join(','));
        expect(gateSnapshot(node).has(dronePeerId)).toBe(true);
      } finally {
        await node.stop();
      }
    }, 60_000);
  });

  describe('applySeed — anchored trust against a real control DB', () => {
    /**
     * End-to-end coverage the mocked unit tests can't give: a live Quereus
     * control DB holds a real `OwnerKey` table, and the default trust policy
     * must IGNORE it in favour of the node-local anchor. Proves the fix on the
     * real stack — a key written into the live table (what a stranger's
     * replicated genesis insert looks like from here) authorizes nothing, while
     * the genesis-anchored owner still applies its own seed.
     */
    function signSeed(privateKey: string, publicKey: string): ControlNetworkSeed {
      const seedData = { partyId, peers: [] as SeedPeer[] };
      const seedJson = canonicalSeedPayload(seedData);
      const seedDigest = digest([seedJson], 'sha256', 'base64url') as string;
      const signature = sign(
        seedDigest, privateKey, 'ed25519', 'base64url', 'base64url', 'base64url'
      ) as string;
      return { ...seedData, signature, signerKey: publicKey };
    }

    it('accepts the anchored owner and rejects a signer present only in the live OwnerKey table', async () => {
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

        // Owner path: initializeSeedBootstrap genesis-anchors this node's own key.
        node.initializeSeedBootstrap(ownerPrivateKey);
        expect(node.getTrustedOwnerStore()!.has(ownerPublicKey)).toBe(true);

        // The attacker's key reaches the REPLICATED table (a genesis insert that
        // synced in) but never the anchor.
        const attackerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
        const attackerPublicKey = getPublicKey(attackerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
        await db!.insertOwnerKey(attackerPublicKey);
        expect(await db!.getOwnerKeys()).toEqual(new Set([attackerPublicKey]));
        expect(node.getTrustedOwnerStore()!.has(attackerPublicKey)).toBe(false);

        // Anchored signer → accepted by the default anchored policy, no override.
        const accepted = await node.applySeed(signSeed(ownerPrivateKey, ownerPublicKey));
        expect(accepted.success).toBe(true);

        // Replicated-only signer → rejected, despite sitting in the live table.
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
      serviceInternals(service).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);

      const { invite } = await service.createInvite();
      expect(invite.ownerAddrs).toEqual(['/ip4/192.168.1.10/tcp/4001']);
    });

    it('uses the resolver when configured (NAT host substitutes DDNS hostname)', async () => {
      const resolver = async () => ['/dns4/foo.duckdns.org/tcp/4001/p2p/12D3KooWHost'];
      const service = new SeedBootstrapService({ partyId, inviteAddressResolver: resolver });
      serviceInternals(service).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);

      const { invite } = await service.createInvite();
      expect(invite.ownerAddrs).toEqual(['/dns4/foo.duckdns.org/tcp/4001/p2p/12D3KooWHost']);
    });

    it('falls back to libp2pNode.getMultiaddrs() when the resolver throws', async () => {
      const resolver = async () => { throw new Error('boom'); };
      const service = new SeedBootstrapService({ partyId, inviteAddressResolver: resolver });
      serviceInternals(service).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);

      const { invite } = await service.createInvite();
      expect(invite.ownerAddrs).toEqual(['/ip4/192.168.1.10/tcp/4001']);
    });

    /** A node-local anchor holding out-of-band-trusted owner keys. */
    function anchor(keys: string[]): MemoryTrustedOwnerStore {
      const store = new MemoryTrustedOwnerStore(partyId);
      for (const key of keys) {
        void store.trust(key, 'operator');
      }
      return store;
    }

    it('carries the node-local anchor as invite.ownerKeys', async () => {
      const service = new SeedBootstrapService({
        partyId,
        trustedOwners: anchor([ownerPublicKey, 'second-owner-key']),
      });
      serviceInternals(service).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);

      const { invite } = await service.createInvite();
      expect(invite.ownerKeys).toBeDefined();
      expect(new Set(invite.ownerKeys)).toEqual(
        new Set([ownerPublicKey, 'second-owner-key'])
      );
    });

    it('does NOT hand out a replicated-only owner key as an invite pin', async () => {
      // The invitee anchors whatever arrives in invite.ownerKeys, so a key that
      // only reached the replicated OwnerKey table (a stranger's genesis insert)
      // must not ride an otherwise-legitimate invite into the new node's anchor.
      const service = new SeedBootstrapService({
        partyId,
        trustedOwners: anchor([ownerPublicKey]),
      });
      serviceInternals(service).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);
      serviceInternals(service).controlDatabase = {
        getOwnerKeys: async () => new Set([ownerPublicKey, 'attacker-genesis-key']),
      };

      const { invite } = await service.createInvite();
      expect(new Set(invite.ownerKeys)).toEqual(new Set([ownerPublicKey]));
    });

    it('omits ownerKeys when the anchor is empty', async () => {
      const service = new SeedBootstrapService({ partyId, trustedOwners: anchor([]) });
      serviceInternals(service).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);

      const { invite } = await service.createInvite();
      expect(invite.ownerKeys).toBeUndefined();
    });

    it('hands out NO pins when no anchor is wired, even with a populated OwnerKey table', async () => {
      // A directly-constructed service (no CadreNode) has no anchor. It must not
      // degrade to the replicated table: an invite with no `ownerKeys` costs the
      // invitee an extra out-of-band step, a table-sourced one silently anchors a
      // key nobody vouched for out of band.
      const service = new SeedBootstrapService({ partyId });
      serviceInternals(service).libp2pNode = makeMockLibp2p(['/ip4/192.168.1.10/tcp/4001']);
      serviceInternals(service).controlDatabase = {
        getOwnerKeys: async () => new Set([ownerPublicKey]),
      };

      const { invite } = await service.createInvite();
      expect(invite.ownerKeys).toBeUndefined();
    });
  });
});

describe('registerSelf — owner self-registration into CadrePeer', () => {
  /** Minimal libp2p surface the receiver's applySeed consumes (merge + dial). */
  function makeReceiverLibp2p() {
    return {
      peerStore: { merge: async () => {} },
      dial: async () => {},
    };
  }

  /**
   * The CLI `--owner` shape: the node's libp2p identity key IS its owner
   * key (ed25519KeyPairFromLibp2p), so it can owner-sign the INSERT of its OWN
   * self-signed address record. This is the gap the implement ticket closes —
   * before registerSelf the owner is absent from the seed it mints; after,
   * the seed carries it as an owner peer, and a receiver that trusts the
   * signer accepts it.
   *
   * NOTE: the ticket described the receiver check as a literal
   * `seed.peers.some(p => p.isOwner && p.publicKey === seed.signerKey)` gate.
   * That inline gate was superseded by the pluggable trust-policy design (see
   * `applySeed`); this test asserts the still-true contract — the owner is
   * present in the seed AND a signer-trusting receiver applies it successfully.
   */
  it('inserts the owner into CadrePeer so seeds include it, and a receiver accepts the seed', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(nodeKey);

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
      clearTimeout(cadreNodeInternals(node).selfRegistrationTimer ?? undefined);
      cadreNodeInternals(node).selfRegistrationTimer = null;

      node.initializeSeedBootstrap(privateKeyB64);

      // Before self-registration the owner is not a CadrePeer, so the seed
      // it mints omits its own peer.
      const before = await node.createSeed();
      expect(before.peers.some((p) => p.peerId === selfPeerId)).toBe(false);

      // Enable owner-signed inserts, then self-register up-front.
      const db = node.getControlDatabase();
      expect(db).not.toBeNull();
      await db!.insertOwnerKey(publicKeyB64);

      const outcome = await node.registerSelf();
      expect(outcome).toBe('inserted');

      // The seed now carries the owner as an owner peer whose key is the
      // seed's own signer.
      const after = await node.createSeed();
      const selfPeer = after.peers.find((p) => p.peerId === selfPeerId);
      expect(selfPeer).toBeDefined();
      expect(selfPeer!.isOwner).toBe(true);
      expect(after.signerKey).toBe(publicKeyB64);
      expect(selfPeer!.publicKey).toBe(after.signerKey);

      // A second node accepts the seed once it trusts the signer (pinned key) —
      // the signer is now backed by an owner peer the seed carries.
      const receiver = new SeedBootstrapService({ partyId: after.partyId });
      serviceInternals(receiver).libp2pNode = makeReceiverLibp2p();
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
   * concurrent callers (the CLI's explicit `--owner` publish + a background
   * timer is the production shape) must collapse into ONE publish: without the
   * `registerSelfInFlight` guard both would observe "no row yet", both attempt
   * the owner-signed INSERT, and the loser would reject on a CadrePeer PK
   * conflict — which, for the awaited CLI call, exits the owner node.
   */
  it('collapses concurrent registerSelf calls into a single INSERT (no PK-conflict race)', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(nodeKey);

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
      clearTimeout(cadreNodeInternals(node).selfRegistrationTimer ?? undefined);
      cadreNodeInternals(node).selfRegistrationTimer = null;

      node.initializeSeedBootstrap(privateKeyB64);
      const db = node.getControlDatabase();
      await db!.insertOwnerKey(publicKeyB64);

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

describe('SeedBootstrapService.handleSeedStream — read-timeout + concurrency cap', () => {
  it('settles within the read timeout (does not hang) on a never-half-closing stream', async () => {
    // Same hang class as wake: a peer that opens the seed stream and never
    // half-closes. The read timeout aborts + rejects so the handler replies with
    // a non-accepting ack rather than awaiting EOF forever.
    const service = new SeedBootstrapService({ partyId: 'p', seedReadTimeoutMs: 50 });
    const stream = new NeverEndingStream();

    await runHandleSeedStream(service, stream, 'member-peer');

    const ack = decodeFrames<SeedAckMessage>(stream.sent);
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toMatch(/timed out/i);
    expect(stream.aborted).toBeTruthy();
    expect(stream.closed).toBe(true);
  });

  it('rejects over the concurrency cap with a non-accepting ack, without applying a seed', async () => {
    const service = new SeedBootstrapService({ partyId: 'p', maxConcurrentSeeds: 2 });

    // Saturate the cap with two parked reads (synchronous activeStreams++ runs
    // before the first await), then attempt a third.
    const held = [new PausableStream(), new PausableStream()];
    for (const s of held) void runHandleSeedStream(service, s, 'member-peer');

    const overflow = new PausableStream();
    await runHandleSeedStream(service, overflow, 'member-peer');

    const ack = decodeFrames<SeedAckMessage>(overflow.sent);
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toMatch(/too many concurrent/i);
    expect(overflow.closed).toBe(true);

    // Release the held reads so their read-timeout timers clear before teardown.
    for (const s of held) s.release();
  });
});

describe('SeedBootstrapService.deliverSeed — ack read timeout + size cap', () => {
  const targetAddr = '/ip4/1.2.3.4/tcp/4001';

  /** A mock control node whose `dialProtocol` hands back a fixed client stream. */
  function dialingNode(stream: unknown): unknown {
    return { dialProtocol: async () => stream };
  }

  /** A signed seed with an empty peer list — enough for a framing round trip. */
  function makeSignedSeed(partyId: string): { seed: ControlNetworkSeed; ownerPublicKey: string } {
    const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
    const ownerPublicKey = getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string;
    const seedData = { partyId, peers: [] as SeedPeer[] };
    const signature = sign(
      digest([canonicalSeedPayload(seedData)], 'sha256', 'base64url') as string,
      privateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
    return { seed: { ...seedData, signature, signerKey: ownerPublicKey }, ownerPublicKey };
  }

  /** A length-prefixed frame whose declared body length is `declared` bytes. */
  function overDeclaredFrame(declared: number, bodyBytes: number): Uint8Array {
    const out = new Uint8Array(4 + bodyBytes);
    new DataView(out.buffer).setUint32(0, declared, false);
    return out;
  }

  it('rejects and aborts the stream when the target never replies', async () => {
    // The target accepts the stream but never writes/half-closes the ack —
    // pre-fix the bare `for await` parked here forever.
    const service = new SeedBootstrapService({ partyId: 'p', seedDeliverTimeoutMs: 50 });
    const stream = new PausableStream();
    serviceInternals(service).libp2pNode = dialingNode(stream);
    const { seed } = makeSignedSeed('p');

    await expect(service.deliverSeed(targetAddr, seed)).rejects.toThrow(/timed out/i);
    expect(stream.aborted).toBeTruthy();
  });

  it('still settles at the deadline when abort does not release the read', async () => {
    // NeverEndingStream's abort() records but does NOT unblock the iterator, so
    // this proves the bound comes from the timer race, not from abort happening
    // to free the read.
    const service = new SeedBootstrapService({ partyId: 'p', seedDeliverTimeoutMs: 50 });
    const stream = new NeverEndingStream();
    serviceInternals(service).libp2pNode = dialingNode(stream);
    const { seed } = makeSignedSeed('p');

    await expect(service.deliverSeed(targetAddr, seed)).rejects.toThrow(/timed out/i);
    expect(stream.aborted).toBeTruthy();
  });

  it('rejects an oversized streamed ack without buffering it all', async () => {
    // 9 x 128KB = 1,179,648 bytes, over the 1MB MAX_SEED_SIZE. The generous
    // timeout makes it provably the size cap, not the clock, that trips.
    const chunks = Array.from({ length: 9 }, () => new Uint8Array(128 * 1024));
    const stream = new CapturingStream(chunks);
    const service = new SeedBootstrapService({ partyId: 'p', seedDeliverTimeoutMs: 5000 });
    serviceInternals(service).libp2pNode = dialingNode(stream);
    const { seed } = makeSignedSeed('p');

    await expect(service.deliverSeed(targetAddr, seed)).rejects.toThrow(/too large/i);
    // readStreamToEnd's size-cap path does not abort; sendSeed's catch does.
    expect(stream.aborted).toBeTruthy();
  });

  it('rejects an ack frame whose declared length exceeds the max', async () => {
    // A distinct guard from the streamed-bytes cap: few bytes actually arrive,
    // but the 4-byte prefix claims 2,000,000.
    const stream = new CapturingStream([overDeclaredFrame(2_000_000, 4)]);
    const service = new SeedBootstrapService({ partyId: 'p', seedDeliverTimeoutMs: 5000 });
    serviceInternals(service).libp2pNode = dialingNode(stream);
    const { seed } = makeSignedSeed('p');

    await expect(service.deliverSeed(targetAddr, seed)).rejects.toThrow(/exceeding max/i);
    expect(stream.aborted).toBeTruthy();
  });

  it('round-trips against a live receiver (framing survives the rewrite)', async () => {
    const { seed, ownerPublicKey } = makeSignedSeed('round-trip-party');

    const receiver = new SeedBootstrapService({
      partyId: 'round-trip-party',
      trustPolicy: pinnedKeyTrustPolicy([ownerPublicKey]),
    });
    serviceInternals(receiver).libp2pNode = {
      peerStore: { merge: async () => {} },
      dial: async () => {},
    };

    const sender = new SeedBootstrapService({ partyId: 'round-trip-party', seedDeliverTimeoutMs: 5000 });
    serviceInternals(sender).libp2pNode = {
      dialProtocol: async () => {
        const { clientStream, serverStream } = duplexPair();
        void runHandleSeedStream(receiver, serverStream, 'target-peer');
        return clientStream;
      },
    };

    const ack = await sender.deliverSeed(targetAddr, seed);
    expect(ack.accepted).toBe(true);
  });

  it('dials the seed protocol with the deadline signal, then frames and half-closes', async () => {
    // Pins the sender's half of the contract the mocks above take for granted:
    // the protocol id, the abort signal the deadline cancels the dial with, and
    // one framed request followed by a write-end half-close.
    const stream = new CapturingStream([frameMessage({ accepted: true } satisfies SeedAckMessage)]);
    const dial: { protocol?: string; signal?: AbortSignal } = {};
    const service = new SeedBootstrapService({ partyId: 'p', seedDeliverTimeoutMs: 5000 });
    serviceInternals(service).libp2pNode = {
      dialProtocol: async (_addr: unknown, protocol: string, opts?: { signal?: AbortSignal }) => {
        dial.protocol = protocol;
        dial.signal = opts?.signal;
        return stream;
      },
    };
    const { seed } = makeSignedSeed('p');

    const ack = await service.deliverSeed(targetAddr, seed);

    expect(ack.accepted).toBe(true);
    expect(dial.protocol).toBe(SEED_PROTOCOL);
    expect(dial.signal).toBeInstanceOf(AbortSignal);
    expect(dial.signal?.aborted).toBe(false);
    expect(decodeFrames<SeedMessage>(stream.sent).partyId).toBe('p');
    expect(stream.closed).toBe(true);
    expect(stream.aborted).toBeNull();
  });

  it('rejects an empty ack rather than reading silence as a reply', async () => {
    // A target that half-closes without writing. Surfacing the framing error is
    // deliberate — it must not be folded into a synthetic non-accepting ack,
    // which would look to the caller like a considered refusal.
    const stream = new CapturingStream([]);
    const service = new SeedBootstrapService({ partyId: 'p', seedDeliverTimeoutMs: 5000 });
    serviceInternals(service).libp2pNode = dialingNode(stream);
    const { seed } = makeSignedSeed('p');

    await expect(service.deliverSeed(targetAddr, seed)).rejects.toThrow(/too short/i);
    expect(stream.aborted).toBeTruthy();
  });

  it('rejects a well-framed ack whose body is not JSON, and resets the stream', async () => {
    // The decode runs inside the reset-on-failure path, so junk in a correctly
    // framed body cannot leak the stream. The parser's message is engine-specific,
    // so assert the reset rather than the wording.
    const body = new TextEncoder().encode('<html>not an ack</html>');
    const framed = new Uint8Array(4 + body.length);
    new DataView(framed.buffer).setUint32(0, body.length, false);
    framed.set(body, 4);
    const stream = new CapturingStream([framed]);
    const service = new SeedBootstrapService({ partyId: 'p', seedDeliverTimeoutMs: 5000 });
    serviceInternals(service).libp2pNode = dialingNode(stream);
    const { seed } = makeSignedSeed('p');

    await expect(service.deliverSeed(targetAddr, seed)).rejects.toThrow();
    expect(stream.aborted).toBeTruthy();
  });

  it('resets a stream whose dial completes after the deadline has already fired', async () => {
    // The deadline wins the race, but the dial still lands afterwards. Without the
    // post-dial abort check that stream is never referenced again and leaks.
    const stream = new PausableStream();
    const service = new SeedBootstrapService({ partyId: 'p', seedDeliverTimeoutMs: 20 });
    serviceInternals(service).libp2pNode = {
      dialProtocol: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return stream;
      },
    };
    const { seed } = makeSignedSeed('p');

    await expect(service.deliverSeed(targetAddr, seed)).rejects.toThrow(/timed out/i);
    // The dial is still in flight at this point — nothing to reset yet.
    expect(stream.aborted).toBeNull();
    await vi.waitFor(() => expect(stream.aborted).toBeTruthy());
  });
});

