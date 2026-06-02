/**
 * E2E Enrollment integration tests.
 *
 * Exercises the full enrollment lifecycle over real libp2p:
 * - Authority creates seed, drone applies and connects
 * - addDrone helper with out-of-band seed encoding
 * - Invite flow for phone enrollment
 * - Multi-node cadre expansion
 * - Negative validation cases (tampered seed, expired invite)
 *
 * Note: deliverSeed (protocol-level /sereus/seed/1.0.0 delivery) is tested
 * separately in deliver-seed-cross-network.integration.ts. These tests use
 * applySeed + dial, which is the same end-to-end behavior minus the framing
 * protocol.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { TestCadreNetwork, waitUntil } from '../harness/index.js';
import { SeedBootstrapService, pinnedKeyTrustPolicy } from '@serfab/cadre-core';
import type { TestParty, TestCadreNode } from '../harness/types.js';
import type { ControlNetworkSeed } from '@serfab/cadre-core';

/**
 * Extract raw Ed25519 private key from libp2p protobuf format as base64url.
 */
function extractPrivateKeyBase64(privateKey: Uint8Array): string {
	const rawKey = privateKey.slice(4, 36);
	return uint8ArrayToString(rawKey, 'base64url');
}

/**
 * Create a SeedBootstrapService for a test party's authority node.
 */
function createSeedService(party: TestParty): SeedBootstrapService {
	const privateKeyBase64 = extractPrivateKeyBase64(party.authorityPrivateKey);
	const service = new SeedBootstrapService({
		partyId: party.partyId,
		authorityPrivateKey: privateKeyBase64,
		authorityPublicKey: party.authorityPublicKey,
	});
	service.initialize(party.authorityNode.libp2p, party.controlDatabase);
	return service;
}

/**
 * Create a receiving-only SeedBootstrapService for a drone/phone node.
 * No authority keys — can only receive and apply seeds.
 */
function createReceiverService(partyId: string, node: TestCadreNode, controlDatabase: TestParty['controlDatabase']): SeedBootstrapService {
	const service = new SeedBootstrapService({ partyId });
	service.initialize(node.libp2p, controlDatabase);
	return service;
}

/**
 * Register the authority's own peer in CadrePeer so seeds include it
 * with isAuthority=true and publicKey for signature validation.
 */
async function registerAuthorityPeer(service: SeedBootstrapService, party: TestParty): Promise<void> {
	await service.authorizePeer({
		peerId: party.authorityNode.peerId,
		multiaddrs: party.authorityNode.multiaddrs,
	});
}

/**
 * Count rows in CadrePeer for a party's control database.
 */
async function countCadrePeers(party: TestParty): Promise<number> {
	const db = party.controlDatabase.getDatabase();
	let count = 0;
	for await (const row of db.eval('select count(*) as cnt from CadreControl.CadrePeer')) {
		count = row.cnt as number;
	}
	return count;
}

describe('E2E Enrollment', () => {
	let network: TestCadreNetwork;

	beforeAll(() => {
		network = new TestCadreNetwork({ verbose: true, defaultTimeoutMs: 20_000 });
	});

	afterAll(async () => {
		await network.shutdown();
	});

	// =========================================================================
	// 1. Server creates seed, drone applies and connects
	// =========================================================================
	it('should enroll drone via seed creation + applySeed + dial', async () => {
		const authority = await network.createParty({ name: 'auth-seed' });
		const drone = await network.createParty({ name: 'drone-seed' });

		const authService = createSeedService(authority);
		const droneService = createReceiverService(authority.partyId, drone.authorityNode, drone.controlDatabase);

		// Authority must be in CadrePeer so the seed includes it as authority peer
		await registerAuthorityPeer(authService, authority);

		// Authorize the drone peer
		await authService.authorizePeer({
			peerId: drone.authorityNode.peerId,
			multiaddrs: drone.authorityNode.multiaddrs,
		});

		// Create seed
		const seed = await authService.createSeed();

		// Verify seed structure
		expect(seed.partyId).toBe(authority.partyId);
		expect(seed.peers.length).toBeGreaterThanOrEqual(2);
		expect(seed.signature).toBeDefined();
		expect(seed.signerKey).toBe(authority.authorityPublicKey);

		const authorityPeer = seed.peers.find(p => p.peerId === authority.authorityNode.peerId);
		expect(authorityPeer?.isAuthority).toBe(true);
		expect(authorityPeer?.publicKey).toBe(authority.authorityPublicKey);

		// Validate seed signature before applying
		expect(authService.validateSeedSignature(seed)).toBe(true);

		// Drone applies the seed. It is cold-start (empty AuthorityKey table), so it
		// pins the authority key out-of-band (as a CadreInvite would carry it);
		// otherwise the DB-anchored default policy would reject the seed.
		const result = await droneService.applySeed(seed, {
			trustPolicy: pinnedKeyTrustPolicy([authority.authorityPublicKey]),
		});
		expect(result.success).toBe(true);
		expect(result.peersAdded).toBeGreaterThanOrEqual(1);

		// Drone should now have a connection to the authority
		await waitUntil(
			() => drone.authorityNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'drone connects to authority after seed apply' }
		);

		const droneConnections = drone.authorityNode.libp2p.getConnections();
		expect(droneConnections.length).toBeGreaterThanOrEqual(1);

		// Verify the connection is to the authority peer
		const connectedPeerIds = droneConnections.map(c => c.remotePeer.toString());
		expect(connectedPeerIds).toContain(authority.authorityNode.peerId);
	});

	// =========================================================================
	// 2. Server adds drone via addDrone helper + out-of-band seed
	// =========================================================================
	it('should add drone via addDrone helper with OOB seed encoding', async () => {
		const authority = await network.createParty({ name: 'auth-oob' });
		const drone = await network.createParty({ name: 'drone-oob' });

		const authService = createSeedService(authority);
		const droneService = createReceiverService(authority.partyId, drone.authorityNode, drone.controlDatabase);

		// Register authority in CadrePeer
		await registerAuthorityPeer(authService, authority);

		// Use addDrone helper
		const result = await authService.addDrone({
			dronePeerId: drone.authorityNode.peerId,
			droneMultiaddrs: drone.authorityNode.multiaddrs,
		});

		expect(result.seed).toBeDefined();
		expect(result.encodedSeed).toBeDefined();
		expect(result.seed.partyId).toBe(authority.partyId);

		// Simulate out-of-band: encode → decode roundtrip
		const decoded = authService.decodeSeed(result.encodedSeed);
		expect(decoded.partyId).toBe(result.seed.partyId);
		expect(decoded.peers).toEqual(result.seed.peers);
		expect(decoded.signature).toBe(result.seed.signature);

		// Validate seed signature
		const isValid = authService.validateSeedSignature(decoded);
		expect(isValid).toBe(true);

		// Drone applies the decoded seed (cold-start → pin the authority key).
		const applyResult = await droneService.applySeed(decoded, {
			trustPolicy: pinnedKeyTrustPolicy([authority.authorityPublicKey]),
		});
		expect(applyResult.success).toBe(true);
		expect(applyResult.peersAdded).toBeGreaterThanOrEqual(1);

		// Drone should connect to authority
		await waitUntil(
			() => drone.authorityNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'drone connects after OOB seed apply' }
		);

		// Verify CadrePeer on authority side has both peers
		const peerCount = await countCadrePeers(authority);
		expect(peerCount).toBeGreaterThanOrEqual(2);
	});

	// =========================================================================
	// 3. Server invites phone (invite flow, no seed)
	// =========================================================================
	it('should invite phone via createInvite/dialInvite flow', async () => {
		const server = await network.createParty({ name: 'server-invite' });
		const phone = await network.createParty({ name: 'phone-invite' });

		const serverService = createSeedService(server);
		const phoneService = createReceiverService(server.partyId, phone.authorityNode, phone.controlDatabase);

		// Server creates invite
		const { invite, encodedInvite } = await serverService.createInvite('test-token-123', 60_000);

		expect(invite.partyId).toBe(server.partyId);
		expect(invite.authorityAddrs.length).toBeGreaterThan(0);
		expect(invite.token).toBe('test-token-123');
		expect(invite.expiresAt).toBeDefined();

		// Phone decodes and dials invite
		const decodedInvite = phoneService.decodeInvite(encodedInvite);
		expect(decodedInvite.partyId).toBe(invite.partyId);
		expect(decodedInvite.token).toBe(invite.token);

		await phoneService.dialInvite(decodedInvite);

		// Phone should be connected to server
		await waitUntil(
			() => phone.authorityNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'phone connects to server after dialInvite' }
		);

		const phoneConns = phone.authorityNode.libp2p.getConnections();
		const connectedPeerIds = phoneConns.map(c => c.remotePeer.toString());
		expect(connectedPeerIds).toContain(server.authorityNode.peerId);

		// Server accepts phone (authorizes in CadrePeer)
		await serverService.acceptPhone(
			{ phonePeerId: phone.authorityNode.peerId, token: 'test-token-123' },
			invite
		);

		// Verify phone is in server's CadrePeer
		const db = server.controlDatabase.getDatabase();
		let phonePeerFound = false;
		for await (const row of db.eval('select PeerId from CadreControl.CadrePeer')) {
			if (row.PeerId === phone.authorityNode.peerId) {
				phonePeerFound = true;
			}
		}
		expect(phonePeerFound).toBe(true);
	});

	// =========================================================================
	// 4. Multi-node enrollment (authority + 2 drones)
	// =========================================================================
	it('should enroll multiple drones into a cadre', async () => {
		const authority = await network.createParty({ name: 'auth-multi' });
		const drone1 = await network.createParty({ name: 'drone1-multi' });
		const drone2 = await network.createParty({ name: 'drone2-multi' });

		const authService = createSeedService(authority);
		const drone1Service = createReceiverService(authority.partyId, drone1.authorityNode, drone1.controlDatabase);
		const drone2Service = createReceiverService(authority.partyId, drone2.authorityNode, drone2.controlDatabase);

		// Register authority in CadrePeer
		await registerAuthorityPeer(authService, authority);

		// Enroll drone-1: authorize, create seed, apply
		await authService.authorizePeer({
			peerId: drone1.authorityNode.peerId,
			multiaddrs: drone1.authorityNode.multiaddrs,
		});
		const seed1 = await authService.createSeed();
		const result1 = await drone1Service.applySeed(seed1, {
			trustPolicy: pinnedKeyTrustPolicy([authority.authorityPublicKey]),
		});
		expect(result1.success).toBe(true);

		// Enroll drone-2: authorize, create seed (now includes drone-1), apply
		await authService.authorizePeer({
			peerId: drone2.authorityNode.peerId,
			multiaddrs: drone2.authorityNode.multiaddrs,
		});
		const seed2 = await authService.createSeed();
		const result2 = await drone2Service.applySeed(seed2, {
			trustPolicy: pinnedKeyTrustPolicy([authority.authorityPublicKey]),
		});
		expect(result2.success).toBe(true);

		// seed2 should reflect all 3 peers (authority + drone1 + drone2)
		expect(seed2.peers.length).toBeGreaterThanOrEqual(3);

		// All drones should connect to authority
		await waitUntil(
			() => drone1.authorityNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'drone1 connected to authority' }
		);
		await waitUntil(
			() => drone2.authorityNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'drone2 connected to authority' }
		);

		// Authority should have connections from both drones
		await waitUntil(
			() => authority.authorityNode.libp2p.getConnections().length >= 2,
			{ timeoutMs: 5000, description: 'authority has 2+ connections' }
		);

		// Authority's CadrePeer should have 3 rows
		const peerCount = await countCadrePeers(authority);
		expect(peerCount).toBeGreaterThanOrEqual(3);
	});

	// =========================================================================
	// 5. Seed validation negative cases
	// =========================================================================
	describe('negative cases', () => {
		it('should reject tampered seed (modified partyId)', async () => {
			const authority = await network.createParty({ name: 'auth-tamper' });
			const drone = await network.createParty({ name: 'drone-tamper' });

			const authService = createSeedService(authority);
			const droneService = createReceiverService(authority.partyId, drone.authorityNode, drone.controlDatabase);

			await registerAuthorityPeer(authService, authority);

			const seed = await authService.createSeed();

			// Tamper with the seed
			const tampered: ControlNetworkSeed = { ...seed, partyId: 'tampered-party-id' };

			const result = await droneService.applySeed(tampered);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid seed signature');
		});

		it('should reject a valid self-asserting seed at a cold-start node with no trust anchor', async () => {
			// Regression: a signature-valid seed signed by the authority must NOT be
			// accepted by a cold-start node (empty AuthorityKey table, no pinned keys
			// and the default DB-anchored policy). A seed can no longer vouch for its
			// own signer.
			const authority = await network.createParty({ name: 'auth-noauth' });
			const drone = await network.createParty({ name: 'drone-noauth' });

			const authService = createSeedService(authority);
			const droneService = createReceiverService(authority.partyId, drone.authorityNode, drone.controlDatabase);

			await registerAuthorityPeer(authService, authority);

			// A fully valid, untampered seed — its signature verifies and it names the
			// authority as an authority peer with a matching publicKey.
			const seed = await authService.createSeed();
			expect(authService.validateSeedSignature(seed)).toBe(true);

			const result = await droneService.applySeed(seed);
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/trust policy/i);

			// With the authority key pinned out-of-band, the same seed is accepted.
			const pinned = await droneService.applySeed(seed, {
				trustPolicy: pinnedKeyTrustPolicy([authority.authorityPublicKey]),
			});
			expect(pinned.success).toBe(true);
		});

		it('should reject expired invite via dialInvite', async () => {
			const server = await network.createParty({ name: 'server-expired' });
			const phone = await network.createParty({ name: 'phone-expired' });

			const serverService = createSeedService(server);
			const phoneService = createReceiverService(server.partyId, phone.authorityNode, phone.controlDatabase);

			// Create invite that expired 1 second ago
			const { invite } = await serverService.createInvite('expired-token', -1000);

			expect(invite.expiresAt).toBeDefined();
			expect(invite.expiresAt!).toBeLessThan(Date.now());

			// dialInvite should throw on expired invite
			await expect(phoneService.dialInvite(invite)).rejects.toThrow('Invite has expired');
		});

		it('should reject expired invite via acceptPhone', async () => {
			const server = await network.createParty({ name: 'server-exp-accept' });

			const serverService = createSeedService(server);

			// Create expired invite
			const { invite } = await serverService.createInvite('accept-token', -1000);

			// acceptPhone with expired invite should throw
			await expect(
				serverService.acceptPhone(
					{ phonePeerId: 'fake-peer-id', token: 'accept-token' },
					invite
				)
			).rejects.toThrow('Invite has expired');
		});

		it('should reject acceptPhone with wrong token', async () => {
			const server = await network.createParty({ name: 'server-bad-token' });

			const serverService = createSeedService(server);

			const { invite } = await serverService.createInvite('correct-token', 60_000);

			await expect(
				serverService.acceptPhone(
					{ phonePeerId: 'fake-peer-id', token: 'wrong-token' },
					invite
				)
			).rejects.toThrow('Invalid invite token');
		});
	});
});
