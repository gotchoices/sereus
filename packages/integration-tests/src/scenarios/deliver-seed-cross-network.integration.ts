/**
 * Reproducing test for cross-network deliverSeed failure.
 *
 * Ticket: 3-deliverSeed-libp2p-v3-stream-compat
 *
 * Root cause analysis:
 * In libp2p v3.x, StreamHandler signature changed from
 *   (data: { stream, connection }) => void
 * to
 *   (stream: Stream, connection: Connection) => void
 *
 * The SeedBootstrapService handler destructures { stream, connection }
 * from the first arg (which IS the stream), getting undefined for both.
 * Handler throws → stream reset → sender sees status: 'reset'.
 *
 * Additionally, closeWrite() doesn't exist in v3.x; close() closes the
 * write end while keeping the read end open. Without calling close(),
 * the receiver's for-await loop never ends → deadlock.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { multiaddr } from '@multiformats/multiaddr';
import { TestCadreNetwork } from '../harness/index.js';
import { SeedBootstrapService, SEED_PROTOCOL, pinnedKeyTrustPolicy } from '@serfab/cadre-core';
import type { TestParty } from '../harness/types.js';
import type { Libp2p, Stream, Connection } from '@libp2p/interface';

function extractPrivateKeyBase64(privateKey: Uint8Array): string {
	const rawKey = privateKey.slice(4, 36);
	return uint8ArrayToString(rawKey, 'base64url');
}

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

async function registerAuthorityPeer(service: SeedBootstrapService, party: TestParty): Promise<void> {
	await service.authorizePeer({
		peerId: party.authorityNode.peerId,
		multiaddrs: party.authorityNode.multiaddrs,
	});
}

async function createPlainNode(): Promise<Libp2p> {
	const node = await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		connectionManager: { dialTimeout: 5000 },
	});
	await node.start();
	return node;
}

describe('deliverSeed cross-network stream negotiation', () => {
	const network = new TestCadreNetwork({ verbose: true, defaultTimeoutMs: 20_000 });
	const plainNodes: Libp2p[] = [];

	afterAll(async () => {
		for (const node of plainNodes) {
			try { await node.stop(); } catch { /* ignore */ }
		}
		await network.shutdown();
	});

	// =========================================================================
	// REPRO: handler receives (stream, connection) as separate args in v3.x
	// =========================================================================
	it('repro: handler signature is (stream, connection) not { stream, connection }', async () => {
		const sender = await createPlainNode();
		const receiver = await createPlainNode();
		plainNodes.push(sender, receiver);

		let handlerArgCount = 0;
		let firstArgIsStream = false;
		let secondArgIsConnection = false;

		await receiver.handle(SEED_PROTOCOL, async (...args: unknown[]) => {
			handlerArgCount = args.length;

			const firstArg = args[0] as Record<string, unknown>;
			// If first arg has 'status' and 'send', it's a stream (not a wrapper)
			firstArgIsStream = typeof firstArg?.status === 'string' && typeof (firstArg as { send?: unknown }).send === 'function';

			const secondArg = args[1] as Record<string, unknown>;
			secondArgIsConnection = secondArg != null && typeof secondArg?.remotePeer !== 'undefined';

			// Properly handle the stream (first arg)
			const stream = firstArg as unknown as Stream;
			for await (const _chunk of stream) { /* drain */ }
			stream.send(new TextEncoder().encode('OK'));
			await stream.close();
		});

		const addr = receiver.getMultiaddrs()[0];
		const stream = await sender.dialProtocol(addr, SEED_PROTOCOL);

		expect(stream.writeStatus).toBe('writable');

		stream.send(new TextEncoder().encode('HELLO'));
		await stream.close(); // close write, not closeWrite()

		// Read response
		const chunks: Uint8Array[] = [];
		for await (const chunk of stream) {
			const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
			chunks.push(bytes);
		}

		const totalLen = chunks.reduce((s, c) => s + c.length, 0);
		const allBytes = new Uint8Array(totalLen);
		let off = 0;
		for (const chunk of chunks) { allBytes.set(chunk, off); off += chunk.length; }
		const response = new TextDecoder().decode(allBytes);

		// Verify handler arg structure
		expect(handlerArgCount).toBeGreaterThanOrEqual(2);
		expect(firstArgIsStream).toBe(true);
		expect(secondArgIsConnection).toBe(true);
		expect(response).toBe('OK');
	});

	// =========================================================================
	// REPRO: current SeedBootstrapService handler fails
	// =========================================================================
	it('repro: current handler destructuring causes stream reset', async () => {
		const sender = await createPlainNode();
		const receiver = await createPlainNode();
		plainNodes.push(sender, receiver);

		let handlerError: Error | undefined;

		// Simulate the CURRENT (broken) handler pattern
		await receiver.handle(SEED_PROTOCOL, async (data: unknown) => {
			try {
				const { stream } = data as { stream: Stream; connection: Connection };
				// stream is undefined because 'data' IS the stream itself
				for await (const _chunk of stream) { /* drain */ }
			} catch (err) {
				handlerError = err as Error;
				throw err; // re-throw to cause stream reset
			}
		});

		const addr = receiver.getMultiaddrs()[0];
		const stream = await sender.dialProtocol(addr, SEED_PROTOCOL);

		try {
			stream.send(new TextEncoder().encode('HELLO'));
		} catch {
			// Stream may already be reset if handler crashed before send completes
		}

		// Give the handler time to fail
		await new Promise(r => setTimeout(r, 100));

		// Stream should be reset because handler threw
		expect(['reset', 'closed']).toContain(stream.status);
		expect(handlerError).toBeDefined();
	});

	// =========================================================================
	// FIX: correct handler signature with full round-trip
	// =========================================================================
	it('fix: correct v3.x handler with length-prefixed seed roundtrip', async () => {
		const authority = await network.createParty({ name: 'auth-fix' });
		const authService = createSeedService(authority);
		await registerAuthorityPeer(authService, authority);

		const sender = await createPlainNode();
		const receiver = await createPlainNode();
		plainNodes.push(sender, receiver);

		const receiverPeerId = receiver.peerId.toString();
		const receiverAddr = receiver.getMultiaddrs()[0].toString();

		await authService.authorizePeer({
			peerId: receiverPeerId,
			multiaddrs: [receiverAddr],
		});

		// Register CORRECT v3.x handler (stream, connection as separate args)
		let receivedSeed: { partyId: string } | null = null;

		await receiver.handle(SEED_PROTOCOL, async (rawStream: unknown, _rawConnection: unknown) => {
			const stream = rawStream as Stream;

			// Read all data
			const chunks: Uint8Array[] = [];
			for await (const chunk of stream) {
				const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
				chunks.push(bytes);
			}

			const allData = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
			let offset = 0;
			for (const chunk of chunks) {
				allData.set(chunk, offset);
				offset += chunk.length;
			}

			// Parse length-prefixed message
			const messageLength = new DataView(allData.buffer, allData.byteOffset).getUint32(0, false);
			const messageJson = new TextDecoder().decode(allData.slice(4, 4 + messageLength));
			receivedSeed = JSON.parse(messageJson);

			// Send ack
			const ack = JSON.stringify({ accepted: true });
			const ackBytes = new TextEncoder().encode(ack);
			const lengthBytes = new Uint8Array(4);
			new DataView(lengthBytes.buffer).setUint32(0, ackBytes.length, false);
			stream.send(lengthBytes);
			stream.send(ackBytes);
			await stream.close();
		});

		// Create seed and format message
		const seed = await authService.createSeed();
		const seedMessage = JSON.stringify({
			partyId: seed.partyId,
			peers: seed.peers,
			transactions: seed.transactions,
			signature: seed.signature,
			signerKey: seed.signerKey,
		});

		// Deliver using CORRECT v3.x pattern
		const addr = multiaddr(receiverAddr);
		const stream = await sender.dialProtocol(addr, SEED_PROTOCOL);

		expect(stream.writeStatus).toBe('writable');

		const messageBytes = new TextEncoder().encode(seedMessage);
		const lengthBytes = new Uint8Array(4);
		new DataView(lengthBytes.buffer).setUint32(0, messageBytes.length, false);

		stream.send(lengthBytes);
		stream.send(messageBytes);
		await stream.close(); // v3.x: close() closes write end only

		// Read ack
		const chunks: Uint8Array[] = [];
		for await (const chunk of stream) {
			const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
			chunks.push(bytes);
		}

		const responseData = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
		let offset = 0;
		for (const chunk of chunks) {
			responseData.set(chunk, offset);
			offset += chunk.length;
		}

		const responseLength = new DataView(responseData.buffer, responseData.byteOffset).getUint32(0, false);
		const responseJson = new TextDecoder().decode(responseData.slice(4, 4 + responseLength));
		const ack = JSON.parse(responseJson);

		expect(ack.accepted).toBe(true);
		expect(receivedSeed).not.toBeNull();
		expect(receivedSeed!.partyId).toBe(authority.partyId);
	});

	// =========================================================================
	// FIX: cross-network delivery (network-scoped sender → plain receiver)
	// =========================================================================
	it('fix: cross-network delivery works with correct handler signature', async () => {
		const authority = await network.createParty({ name: 'auth-cross-fix' });
		const authService = createSeedService(authority);
		await registerAuthorityPeer(authService, authority);

		// Plain receiver (different "network")
		const receiver = await createPlainNode();
		plainNodes.push(receiver);

		const receiverAddr = receiver.getMultiaddrs()[0].toString();

		await authService.authorizePeer({
			peerId: receiver.peerId.toString(),
			multiaddrs: [receiverAddr],
		});

		// Register CORRECT v3.x handler on receiver
		let receivedPartyId = '';

		await receiver.handle(SEED_PROTOCOL, async (rawStream: unknown, _rawConnection: unknown) => {
			const stream = rawStream as Stream;

			const chunks: Uint8Array[] = [];
			for await (const chunk of stream) {
				const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
				chunks.push(bytes);
			}

			const allData = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
			let off = 0;
			for (const c of chunks) { allData.set(c, off); off += c.length; }

			const msgLen = new DataView(allData.buffer, allData.byteOffset).getUint32(0, false);
			const msgJson = new TextDecoder().decode(allData.slice(4, 4 + msgLen));
			const msg = JSON.parse(msgJson) as { partyId: string };
			receivedPartyId = msg.partyId;

			const ack = JSON.stringify({ accepted: true });
			const ackBytes = new TextEncoder().encode(ack);
			const lb = new Uint8Array(4);
			new DataView(lb.buffer).setUint32(0, ackBytes.length, false);
			stream.send(lb);
			stream.send(ackBytes);
			await stream.close();
		});

		// Use the network-scoped authority node to dial the plain receiver
		const seed = await authService.createSeed();
		const seedMessage = JSON.stringify({
			partyId: seed.partyId,
			peers: seed.peers,
			signature: seed.signature,
			signerKey: seed.signerKey,
		});

		const addr = multiaddr(receiverAddr);
		const stream = await authority.authorityNode.libp2p.dialProtocol(addr, SEED_PROTOCOL);

		expect(stream.writeStatus).toBe('writable');

		const msgBytes = new TextEncoder().encode(seedMessage);
		const lb = new Uint8Array(4);
		new DataView(lb.buffer).setUint32(0, msgBytes.length, false);

		stream.send(lb);
		stream.send(msgBytes);
		await stream.close();

		const chunks: Uint8Array[] = [];
		for await (const chunk of stream) {
			const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
			chunks.push(bytes);
		}

		const respData = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
		let off = 0;
		for (const c of chunks) { respData.set(c, off); off += c.length; }

		const respLen = new DataView(respData.buffer, respData.byteOffset).getUint32(0, false);
		const respJson = new TextDecoder().decode(respData.slice(4, 4 + respLen));
		const ack = JSON.parse(respJson);

		expect(ack.accepted).toBe(true);
		expect(receivedPartyId).toBe(authority.partyId);
	});

	// =========================================================================
	// E2E: SeedBootstrapService.deliverSeed() → SeedBootstrapService handler
	// =========================================================================
	it('e2e: deliverSeed round-trips through service handler on both sides', async () => {
		// Sender party (authority that creates + delivers seed)
		const senderParty = await network.createParty({ name: 'auth-e2e-sender' });
		const senderService = createSeedService(senderParty);
		await registerAuthorityPeer(senderService, senderParty);

		// Receiver party (has its own SeedBootstrapService with registered handler).
		// The receiver is cold-start with respect to the *sender's* authority key,
		// so it must pin that key out-of-band (as a CadreInvite would) for the
		// DB-anchored default policy not to reject the delivered seed.
		const receiverParty = await network.createParty({ name: 'auth-e2e-receiver' });
		const receiverService = new SeedBootstrapService({
			partyId: receiverParty.partyId,
			trustPolicy: pinnedKeyTrustPolicy([senderParty.authorityPublicKey]),
		});
		receiverService.initialize(receiverParty.authorityNode.libp2p, receiverParty.controlDatabase);
		// Register the receiver's own handler + peer entry.
		await registerAuthorityPeer(receiverService, receiverParty);

		// Authorize receiver's peer on sender side so the seed includes it
		const receiverAddr = receiverParty.authorityNode.multiaddrs[0];
		await senderService.authorizePeer({
			peerId: receiverParty.authorityNode.peerId,
			multiaddrs: [receiverAddr],
		});

		// Create seed on sender
		const seed = await senderService.createSeed();
		expect(seed.peers.length).toBeGreaterThanOrEqual(2);

		// Use the actual deliverSeed method (exercises both fixed bugs)
		const ack = await senderService.deliverSeed(receiverAddr, seed);

		expect(ack.accepted).toBe(true);
		expect(ack.reason).toBeUndefined();
	});
});
