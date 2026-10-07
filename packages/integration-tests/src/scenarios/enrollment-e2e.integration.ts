/**
 * E2E Enrollment integration tests.
 *
 * Exercises the full enrollment lifecycle over real libp2p:
 * - Owner creates seed, drone applies and connects
 * - addDrone helper with out-of-band seed encoding
 * - A cadre invitation minted by the owner and redeemed at the owner itself
 * - Multi-node cadre expansion
 * - Negative validation cases (tampered seed, expired invitation)
 *
 * Note: deliverSeed (protocol-level /sereus/seed/1.0.0 delivery) is tested
 * separately in deliver-seed-cross-network.integration.ts. These tests use
 * applySeed + dial, which is the same end-to-end behavior minus the framing
 * protocol.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { TestCadreNetwork, waitUntil, controlNodeConfig, makeOwnOwner } from '../harness/index.js';
import { CadreNode, SeedBootstrapService, pinnedKeyTrustPolicy, CadreInviteRejectedError } from '@serfab/cadre-core';
import type { TestParty, TestCadreNode } from '../harness/types.js';
import type { ControlNetworkSeed } from '@serfab/cadre-core';

/** Replication and redemption waits over loopback; generous because a CadreNode's bring-up is behind each. */
const OWNER_OP_MS = 60_000;

/** A started owner `CadreNode` with its own genesis key wired, listening on loopback. */
async function startOwner(partyId: string): Promise<{ owner: CadreNode; ownerKey: string }> {
	const key = await generateKeyPair('Ed25519');
	const owner = new CadreNode(controlNodeConfig({ partyId, privateKey: key, strandFilter: 'none' }));
	await owner.start();
	return { owner, ownerKey: await makeOwnOwner(owner, key) };
}

/** A phone-shaped device: no listen address, dials only, a stable identity to sign the redemption with. */
async function startDevice(partyId: string): Promise<CadreNode> {
	const device = new CadreNode(controlNodeConfig({
		partyId, privateKey: await generateKeyPair('Ed25519'), listenAddrs: [], strandFilter: 'none',
	}));
	await device.start();
	return device;
}

/**
 * Extract raw Ed25519 private key from libp2p protobuf format as base64url.
 */
function extractPrivateKeyBase64(privateKey: Uint8Array): string {
	const rawKey = privateKey.slice(4, 36);
	return uint8ArrayToString(rawKey, 'base64url');
}

/**
 * Create a SeedBootstrapService for a test party's owner node.
 */
async function createSeedService(party: TestParty): Promise<SeedBootstrapService> {
	const privateKeyBase64 = extractPrivateKeyBase64(party.ownerPrivateKey);
	const service = new SeedBootstrapService({
		partyId: party.partyId,
		ownerPrivateKey: privateKeyBase64,
		ownerPublicKey: party.ownerPublicKey,
	});
	await service.initialize(party.ownerNode.libp2p, party.controlDatabase);
	return service;
}

/**
 * Create a receiving-only SeedBootstrapService for a drone/phone node.
 * No owner keys — can only receive and apply seeds.
 */
async function createReceiverService(partyId: string, node: TestCadreNode, controlDatabase: TestParty['controlDatabase']): Promise<SeedBootstrapService> {
	const service = new SeedBootstrapService({ partyId });
	await service.initialize(node.libp2p, controlDatabase);
	return service;
}

/**
 * Register the owner's own peer in CadrePeer so seeds include it
 * with isOwner=true and publicKey for signature validation.
 */
async function registerOwnerPeer(service: SeedBootstrapService, party: TestParty): Promise<void> {
	await service.authorizePeer({
		peerId: party.ownerNode.peerId,
		multiaddrs: party.ownerNode.multiaddrs,
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
		const owner = await network.createParty({ name: 'auth-seed' });
		const drone = await network.createParty({ name: 'drone-seed' });

		const authService = await createSeedService(owner);
		const droneService = await createReceiverService(owner.partyId, drone.ownerNode, drone.controlDatabase);

		// Owner must be in CadrePeer so the seed includes it as owner peer
		await registerOwnerPeer(authService, owner);

		// Authorize the drone peer
		await authService.authorizePeer({
			peerId: drone.ownerNode.peerId,
			multiaddrs: drone.ownerNode.multiaddrs,
		});

		// Create seed
		const seed = await authService.createSeed();

		// Verify seed structure
		expect(seed.partyId).toBe(owner.partyId);
		expect(seed.peers.length).toBeGreaterThanOrEqual(2);
		expect(seed.signature).toBeDefined();
		expect(seed.signerKey).toBe(owner.ownerPublicKey);

		const ownerPeer = seed.peers.find(p => p.peerId === owner.ownerNode.peerId);
		expect(ownerPeer?.isOwner).toBe(true);
		expect(ownerPeer?.publicKey).toBe(owner.ownerPublicKey);

		// Validate seed signature before applying
		expect(authService.validateSeedSignature(seed)).toBe(true);

		// Drone applies the seed. Its node-local trusted-owner anchor is empty, so it
		// pins the owner key out-of-band (as a CadreInvite would carry it);
		// otherwise the default anchored policy would reject the seed.
		const result = await droneService.applySeed(seed, {
			trustPolicy: pinnedKeyTrustPolicy([owner.ownerPublicKey]),
		});
		expect(result.success).toBe(true);
		expect(result.peersAdded).toBeGreaterThanOrEqual(1);

		// Drone should now have a connection to the owner
		await waitUntil(
			() => drone.ownerNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'drone connects to owner after seed apply' }
		);

		const droneConnections = drone.ownerNode.libp2p.getConnections();
		expect(droneConnections.length).toBeGreaterThanOrEqual(1);

		// Verify the connection is to the owner peer
		const connectedPeerIds = droneConnections.map(c => c.remotePeer.toString());
		expect(connectedPeerIds).toContain(owner.ownerNode.peerId);
	});

	// =========================================================================
	// 2. Server adds drone via addDrone helper + out-of-band seed
	// =========================================================================
	it('should add drone via addDrone helper with OOB seed encoding', async () => {
		const owner = await network.createParty({ name: 'auth-oob' });
		const drone = await network.createParty({ name: 'drone-oob' });

		const authService = await createSeedService(owner);
		const droneService = await createReceiverService(owner.partyId, drone.ownerNode, drone.controlDatabase);

		// Register owner in CadrePeer
		await registerOwnerPeer(authService, owner);

		// Use addDrone helper
		const result = await authService.addDrone({
			dronePeerId: drone.ownerNode.peerId,
			droneMultiaddrs: drone.ownerNode.multiaddrs,
		});

		expect(result.seed).toBeDefined();
		expect(result.encodedSeed).toBeDefined();
		expect(result.seed.partyId).toBe(owner.partyId);

		// Simulate out-of-band: encode → decode roundtrip
		const decoded = authService.decodeSeed(result.encodedSeed);
		expect(decoded.partyId).toBe(result.seed.partyId);
		expect(decoded.peers).toEqual(result.seed.peers);
		expect(decoded.signature).toBe(result.seed.signature);

		// Validate seed signature
		const isValid = authService.validateSeedSignature(decoded);
		expect(isValid).toBe(true);

		// Drone applies the decoded seed (cold-start → pin the owner key).
		const applyResult = await droneService.applySeed(decoded, {
			trustPolicy: pinnedKeyTrustPolicy([owner.ownerPublicKey]),
		});
		expect(applyResult.success).toBe(true);
		expect(applyResult.peersAdded).toBeGreaterThanOrEqual(1);

		// Drone should connect to owner
		await waitUntil(
			() => drone.ownerNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'drone connects after OOB seed apply' }
		);

		// Verify CadrePeer on owner side has both peers
		const peerCount = await countCadrePeers(owner);
		expect(peerCount).toBeGreaterThanOrEqual(2);
	});

	// =========================================================================
	// 3. Owner mints a cadre invitation; a phone-shaped device redeems it at the
	//    owner itself and syncs (the owner is the one member the bundle names)
	// =========================================================================
	it('should admit a device that redeems a cadre invitation at the owner, and sync it', async () => {
		const partyId = `enroll-invitation-${Date.now()}`;
		const { owner, ownerKey } = await startOwner(partyId);
		let device: CadreNode | undefined;
		try {
			const { invitation, encoded } = await owner.createCadreInvitation({ grantsOwner: false });
			expect(invitation.ownerKeys).toEqual([ownerKey]);
			expect(invitation.members).toEqual(owner.getMultiaddrs());
			expect(typeof encoded).toBe('string');

			device = await startDevice(partyId);
			const devicePeerId = device.peerId!.toString();
			const result = await device.redeemCadreInvitation(invitation);
			expect(result.peerId).toBe(owner.peerId!.toString());
			expect(result.grantsOwner).toBe(false);

			// The owner wrote the device's row itself (no owner signature on it: the
			// consent chain through the invitation), and judges it a member.
			expect(await owner.isAuthorizedMember(devicePeerId)).toBe(true);
			// The device pinned the bundle's owner key and syncs the control database
			// over the connection it holds: the owner's genesis key arrives by replication.
			expect(device.getTrustedOwnerStore()!.has(ownerKey)).toBe(true);
			await waitUntil(
				async () => (await device!.getControlDatabase()!.getOwnerKeys()).has(ownerKey),
				{ timeoutMs: OWNER_OP_MS, intervalMs: 500, description: 'the owner key replicates to the admitted device' }
			);
		} finally {
			await device?.stop();
			await owner.stop();
		}
	}, 3 * OWNER_OP_MS);

	// =========================================================================
	// 4. Multi-node enrollment (owner + 2 drones)
	// =========================================================================
	it('should enroll multiple drones into a cadre', async () => {
		const owner = await network.createParty({ name: 'auth-multi' });
		const drone1 = await network.createParty({ name: 'drone1-multi' });
		const drone2 = await network.createParty({ name: 'drone2-multi' });

		const authService = await createSeedService(owner);
		const drone1Service = await createReceiverService(owner.partyId, drone1.ownerNode, drone1.controlDatabase);
		const drone2Service = await createReceiverService(owner.partyId, drone2.ownerNode, drone2.controlDatabase);

		// Register owner in CadrePeer
		await registerOwnerPeer(authService, owner);

		// Enroll drone-1: authorize, create seed, apply
		await authService.authorizePeer({
			peerId: drone1.ownerNode.peerId,
			multiaddrs: drone1.ownerNode.multiaddrs,
		});
		const seed1 = await authService.createSeed();
		const result1 = await drone1Service.applySeed(seed1, {
			trustPolicy: pinnedKeyTrustPolicy([owner.ownerPublicKey]),
		});
		expect(result1.success).toBe(true);

		// Enroll drone-2: authorize, create seed (now includes drone-1), apply
		await authService.authorizePeer({
			peerId: drone2.ownerNode.peerId,
			multiaddrs: drone2.ownerNode.multiaddrs,
		});
		const seed2 = await authService.createSeed();
		const result2 = await drone2Service.applySeed(seed2, {
			trustPolicy: pinnedKeyTrustPolicy([owner.ownerPublicKey]),
		});
		expect(result2.success).toBe(true);

		// seed2 should reflect all 3 peers (owner + drone1 + drone2)
		expect(seed2.peers.length).toBeGreaterThanOrEqual(3);

		// All drones should connect to owner
		await waitUntil(
			() => drone1.ownerNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'drone1 connected to owner' }
		);
		await waitUntil(
			() => drone2.ownerNode.libp2p.getConnections().length >= 1,
			{ timeoutMs: 5000, description: 'drone2 connected to owner' }
		);

		// Owner should have connections from both drones
		await waitUntil(
			() => owner.ownerNode.libp2p.getConnections().length >= 2,
			{ timeoutMs: 5000, description: 'owner has 2+ connections' }
		);

		// Owner's CadrePeer should have 3 rows
		const peerCount = await countCadrePeers(owner);
		expect(peerCount).toBeGreaterThanOrEqual(3);
	});

	// =========================================================================
	// 5. Seed validation negative cases
	// =========================================================================
	describe('negative cases', () => {
		it('should reject tampered seed (modified partyId)', async () => {
			const owner = await network.createParty({ name: 'auth-tamper' });
			const drone = await network.createParty({ name: 'drone-tamper' });

			const authService = await createSeedService(owner);
			const droneService = await createReceiverService(owner.partyId, drone.ownerNode, drone.controlDatabase);

			await registerOwnerPeer(authService, owner);

			const seed = await authService.createSeed();

			// Tamper with the seed
			const tampered: ControlNetworkSeed = { ...seed, partyId: 'tampered-party-id' };

			const result = await droneService.applySeed(tampered);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid seed signature');
		});

		it('should reject a valid self-asserting seed at a cold-start node with no trust anchor', async () => {
			// Regression: a signature-valid seed signed by the owner must NOT be
			// accepted by a node with an empty trusted-owner anchor and no pinned keys
			// (the default anchored policy). A seed can no longer vouch for its own
			// signer.
			const owner = await network.createParty({ name: 'auth-noauth' });
			const drone = await network.createParty({ name: 'drone-noauth' });

			const authService = await createSeedService(owner);
			const droneService = await createReceiverService(owner.partyId, drone.ownerNode, drone.controlDatabase);

			await registerOwnerPeer(authService, owner);

			// A fully valid, untampered seed — its signature verifies and it names the
			// owner as an owner peer with a matching publicKey.
			const seed = await authService.createSeed();
			expect(authService.validateSeedSignature(seed)).toBe(true);

			const result = await droneService.applySeed(seed);
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/trust policy/i);

			// With the owner key pinned out-of-band, the same seed is accepted.
			const pinned = await droneService.applySeed(seed, {
				trustPolicy: pinnedKeyTrustPolicy([owner.ownerPublicKey]),
			});
			expect(pinned.success).toBe(true);
		});


		it('should refuse an expired cadre invitation with invite-spent', async () => {
			// Minted already expired (a negative lifetime), so the member's redemption fails the
			// usage row's liveness check. The owner alone has no authorized member yet, so its
			// gate admits the device's connection and the refusal comes from the protocol.
			const partyId = `enroll-expired-invitation-${Date.now()}`;
			const { owner } = await startOwner(partyId);
			let device: CadreNode | undefined;
			try {
				const { invitation } = await owner.createCadreInvitation({ grantsOwner: false, expiresInMs: -1000 });
				expect(new Date(`${invitation.invite.expiresAt}Z`).getTime()).toBeLessThan(Date.now());

				device = await startDevice(partyId);
				const failure: unknown = await device.redeemCadreInvitation(invitation).catch((err: unknown) => err);
				expect(failure).toBeInstanceOf(CadreInviteRejectedError);
				expect(failure).toMatchObject({ code: 'invite-spent', retryable: false });
				expect(await owner.isAuthorizedMember(device.peerId!.toString())).toBe(false);
			} finally {
				await device?.stop();
				await owner.stop();
			}
		}, 3 * OWNER_OP_MS);
	});
});
