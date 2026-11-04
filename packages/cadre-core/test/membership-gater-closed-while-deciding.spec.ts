import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import type { ConnectionGater, MultiaddrConnection } from '@libp2p/interface';
import { createMembershipConnectionGater, type InboundConnectionVerdict } from '../src/membership-connection-gater.js';

/**
 * A dialer that hangs up while the control gate is still deciding must not get a muxer built for
 * its closed connection (`createMembershipConnectionGater` → `denyInboundEncryptedConnection`).
 *
 * The receiver's yamux muxer subscribes to the encrypted stream when it is constructed, so it
 * misses a `close` event dispatched earlier, stays `open`, and is then handed the frames the dialer
 * sent before hanging up. Its ping reply throws, and so does the GoAway it sends while aborting,
 * from inside an event listener: an uncaught exception, which ends a process without a handler.
 *
 * Real sockets and a real upgrade, because the defect is the order of events across libp2p's
 * layers. The decision is released by hand so the hang-up always lands inside it. The dialer's
 * `dial()` resolves first, since noise negotiates the muxer in the handshake's early data.
 */

/** Room for the throw, which Node schedules with `process.nextTick` from the listener, to surface. */
const SETTLE_MS = 100;
const CLOSE_POLL_MS = 10;
const CLOSE_TIMEOUT_MS = 5_000;

/** What one inbound connection's trip through the gate exposes to the test. */
interface HeldDecision {
	gater: ConnectionGater;
	/** Resolves with the transport as soon as the upgrade reaches the gate. */
	reachedGate: Promise<MultiaddrConnection>;
	/** Let the membership decision finish. */
	release(): void;
	/** The gate's answer: true denies. */
	verdict: Promise<boolean>;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function holdDecision(): HeldDecision {
	const reached = deferred<MultiaddrConnection>();
	const released = deferred<void>();
	const verdict = deferred<boolean>();
	const inner = createMembershipConnectionGater(
		{
			admitInbound: async (): Promise<InboundConnectionVerdict> => {
				await released.promise;
				return 'admit';
			},
			admitRelayReservation: () => true
		},
		{
			denyInboundEncryptedConnection: (_peerId, maConn) => {
				reached.resolve(maConn);
				return false;
			}
		}
	);
	return {
		gater: {
			...inner,
			denyInboundEncryptedConnection: async (peerId, maConn) => {
				const denied = await inner.denyInboundEncryptedConnection!(peerId, maConn);
				verdict.resolve(denied);
				return denied;
			}
		},
		reachedGate: reached.promise,
		release: () => released.resolve(undefined),
		verdict: verdict.promise
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitClosed(maConn: MultiaddrConnection): Promise<void> {
	const deadline = Date.now() + CLOSE_TIMEOUT_MS;
	while (maConn.status === 'open') {
		if (Date.now() > deadline) {
			throw new Error(`the receiver's transport stayed open ${CLOSE_TIMEOUT_MS}ms after the dialer hung up`);
		}
		await delay(CLOSE_POLL_MS);
	}
}

describe('the control gate, when the dialer hangs up during its decision', () => {
	const nodes: Libp2p[] = [];
	const uncaught: Error[] = [];
	const recordUncaught = (error: Error): void => {
		uncaught.push(error);
	};

	/** Plain libp2p nodes: only the upgrade and the gate are under test, and neither needs a control database. */
	async function startNode(gater: ConnectionGater, listen: string[]): Promise<Libp2p> {
		const node = await createLibp2p({
			addresses: { listen },
			transports: [webSockets()],
			connectionEncrypters: [noise()],
			streamMuxers: [yamux()],
			connectionGater: gater
		});
		nodes.push(node);
		return node;
	}

	async function startPair(held: HeldDecision): Promise<{ receiver: Libp2p; dialer: Libp2p }> {
		const receiver = await startNode(held.gater, ['/ip4/127.0.0.1/tcp/0/ws']);
		const dialer = await startNode({ denyDialMultiaddr: () => false }, []);
		return { receiver, dialer };
	}

	beforeEach(() => {
		uncaught.length = 0;
		process.on('uncaughtException', recordUncaught);
	});

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
		process.off('uncaughtException', recordUncaught);
	});

	it('refuses the closed connection, so no muxer is built and nothing throws', async () => {
		const held = holdDecision();
		const { receiver, dialer } = await startPair(held);

		const connection = await dialer.dial(receiver.getMultiaddrs()[0]!);
		const maConn = await held.reachedGate;
		await connection.close();
		await awaitClosed(maConn);
		held.release();

		const denied = await held.verdict;
		await delay(SETTLE_MS);
		expect(uncaught).toEqual([]);
		expect(denied, 'the gate denies a transport that closed while it decided').toBe(true);
		expect(receiver.getConnections()).toEqual([]);
	});

	it('still admits a connection whose dialer stays', async () => {
		const held = holdDecision();
		const { receiver, dialer } = await startPair(held);

		const connection = await dialer.dial(receiver.getMultiaddrs()[0]!);
		await held.reachedGate;
		held.release();

		expect(await held.verdict).toBe(false);
		await delay(SETTLE_MS);
		expect(uncaught).toEqual([]);
		expect(receiver.getConnections().map((c) => c.remotePeer.toString())).toEqual([dialer.peerId.toString()]);
		expect(connection.status).toBe('open');
	});
});
