/**
 * Seed Bootstrap integration test.
 * 
 * Verifies the seed bootstrap flow for adding new nodes to a cadre:
 * 1. Owner creates and initializes SeedBootstrapService
 * 2. Owner authorizes a new drone peer
 * 3. Drone receives seed and applies it
 * 4. Drone connects to owner
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { TestCadreNetwork } from '../harness/index.js';
import { SeedBootstrapService } from '@serfab/cadre-core';

/**
 * Extract raw Ed25519 private key from libp2p protobuf format and encode as base64url.
 * The protobuf format is: type (1 byte) + length (1 byte) + type2 (1 byte) + length2 (1 byte) + 32-byte seed + ...
 */
function extractPrivateKeyBase64(privateKey: Uint8Array): string {
  // Skip 4-byte protobuf header to get raw 32-byte Ed25519 seed
  const rawKey = privateKey.slice(4, 36);
  // Convert to base64url without multiformat prefix
  return uint8ArrayToString(rawKey, 'base64url');
}

describe('Seed Bootstrap', () => {
  let network: TestCadreNetwork;

  beforeAll(() => {
    network = new TestCadreNetwork({ verbose: true });
  });

  afterAll(async () => {
    await network.shutdown();
  });

  it('should authorize a peer and create a seed', async () => {
    // Create owner party (server with signing keys)
    const alice = await network.createParty({ name: 'alice-owner' });

    // Extract the raw Ed25519 private key for the service
    const privateKeyBase64 = extractPrivateKeyBase64(alice.ownerPrivateKey);

    // Create SeedBootstrapService
    // Use the same public key format that was inserted into OwnerKey table
    const seedService = new SeedBootstrapService({
      partyId: alice.partyId,
      ownerPrivateKey: privateKeyBase64,
      ownerPublicKey: alice.ownerPublicKey  // base64url encoded
    });

    // Initialize with the party's libp2p and control database
    seedService.initialize(
      alice.ownerNode.libp2p,
      alice.controlDatabase
    );

    // Generate a new peer ID for the "drone" we'll add
    const droneKey = await generateKeyPair('Ed25519');
    const dronePeerId = peerIdFromPrivateKey(droneKey);

    // Authorize the drone peer
    await seedService.authorizePeer({
      peerId: dronePeerId.toString(),
      multiaddrs: ['/ip4/192.168.1.100/tcp/4001']
    });

    // Create a seed for the drone
    const seed = await seedService.createSeed();

    // Verify seed structure
    expect(seed.partyId).toBe(alice.partyId);
    expect(seed.peers.length).toBeGreaterThanOrEqual(1);
    expect(seed.signature).toBeDefined();

    // The seed should include the drone peer we just added
    const dronePeer = seed.peers.find(p => p.peerId === dronePeerId.toString());
    expect(dronePeer).toBeDefined();
    expect(dronePeer?.multiaddrs).toContain('/ip4/192.168.1.100/tcp/4001');
  });

  it('should encode and decode seeds for out-of-band delivery', async () => {
    const alice = await network.createParty({ name: 'alice-encode' });

    const privateKeyBase64 = extractPrivateKeyBase64(alice.ownerPrivateKey);

    const seedService = new SeedBootstrapService({
      partyId: alice.partyId,
      ownerPrivateKey: privateKeyBase64,
      ownerPublicKey: alice.ownerPublicKey
    });
    
    seedService.initialize(
      alice.ownerNode.libp2p,
      alice.controlDatabase
    );
    
    // Create a seed
    const seed = await seedService.createSeed();
    
    // Encode for out-of-band delivery (QR code, link, etc.)
    const encoded = seedService.encodeSeed(seed);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    
    // Decode back
    const decoded = seedService.decodeSeed(encoded);
    expect(decoded.partyId).toBe(seed.partyId);
    expect(decoded.peers).toEqual(seed.peers);
    expect(decoded.signature).toBe(seed.signature);
  });

  it('should validate seed signature from owner', async () => {
    const alice = await network.createParty({ name: 'alice-validate' });

    const privateKeyBase64 = extractPrivateKeyBase64(alice.ownerPrivateKey);

    const seedService = new SeedBootstrapService({
      partyId: alice.partyId,
      ownerPrivateKey: privateKeyBase64,
      ownerPublicKey: alice.ownerPublicKey
    });
    
    seedService.initialize(
      alice.ownerNode.libp2p,
      alice.controlDatabase
    );
    
    const seed = await seedService.createSeed();
    
    // Validate the seed signature
    const isValid = await seedService.validateSeedSignature(seed);
    expect(isValid).toBe(true);
    
    // Tampered seed should fail validation
    const tamperedSeed = { ...seed, partyId: 'tampered-party' };
    const isTamperedValid = await seedService.validateSeedSignature(tamperedSeed);
    expect(isTamperedValid).toBe(false);
  });

  it('should use addDrone helper to authorize drone and create seed', async () => {
    const alice = await network.createParty({ name: 'alice-drone' });

    const privateKeyBase64 = extractPrivateKeyBase64(alice.ownerPrivateKey);

    const seedService = new SeedBootstrapService({
      partyId: alice.partyId,
      ownerPrivateKey: privateKeyBase64,
      ownerPublicKey: alice.ownerPublicKey
    });
    
    seedService.initialize(
      alice.ownerNode.libp2p,
      alice.controlDatabase
    );
    
    // Generate drone identity
    const droneKey = await generateKeyPair('Ed25519');
    const dronePeerId = peerIdFromPrivateKey(droneKey);
    
    // Use helper function to authorize and create seed in one call
    const result = await seedService.addDrone({
      dronePeerId: dronePeerId.toString(),
      droneMultiaddrs: ['/ip4/10.0.0.50/tcp/4001']
    });
    
    // Should return seed and encoded seed
    expect(result.seed).toBeDefined();
    expect(result.encodedSeed).toBeDefined();
    expect(result.seed.partyId).toBe(alice.partyId);
    
    // Encoded seed should be decodable
    const decoded = seedService.decodeSeed(result.encodedSeed);
    expect(decoded.partyId).toBe(alice.partyId);
  });
});

