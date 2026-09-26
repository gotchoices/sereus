/**
 * What ONE relayed libp2p connection setup costs at a given link delay — opt-in, and never
 * part of `yarn test`.
 *
 * This is the reproduction for `strand-node-never-redials-through-a-relay-at-a-three-second-round-trip`:
 * two machines that reach each other only through a relay stop being able to connect at all
 * once the link is slow enough, and every dial budget in the stack is a fixed number of
 * milliseconds rather than a number of round trips. The measurement below is what turns that
 * into arithmetic: it times the relayed dial under a budget far above any the stack imposes,
 * and then re-runs it under the two budgets that actually bound it in production.
 *
 * Deliberately BARE libp2p — websockets + noise + yamux + circuit-relay-v2 + identify, with
 * `@optimystic/db-p2p`'s own `connectionManager` values and cadre-core's
 * `DEFAULT_CONNECTION_MONITOR` — and no cadre, no Optimystic, no database. The cost being
 * measured is the transport's, so a cadre stack on top of it could only hide the signal.
 * Keeping the two `connectionManager` numbers in step with `libp2p-node-base.ts` is this
 * file's contract; they are what the measurement is ABOUT.
 *
 * ── Running it ──
 *
 *   RELAY_DIAL_COST=1 yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency
 *
 * Without `RELAY_DIAL_COST=1` the suite is skipped. `RELAY_DIAL_COST_DELAYS=<ms>[,<ms>…]`
 * picks the one-way delays to sweep (default `0,900,1500`); one delay costs about 40 s.
 *
 * ── What it measured, 2026-09-26, one Windows machine, loopback dedicated relay ──
 *
 * The delay is injected by `harness/ws-latency.ts` in `pipelined` mode — a constant ONE-WAY
 * latency on frames a node dials out (see docs/testing.md → "Where measurements live"; a
 * figure without its mode says nothing). Because only dialed sockets are delayed, one
 * peer-to-peer round trip through the relay costs 2× the one-way figure, while one round trip
 * between a node and the relay costs 1×.
 *
 * | one-way delay | dial the relay | request the reservation | **relayed dial** | newStream over it |
 * | --- | --- | --- | --- | --- |
 * | 0 ms    | 45 ms   | 34 ms   | 26 ms      | 18 ms   |
 * | 900 ms  | 1832 ms | 1826 ms | **7293 ms** | 1826 ms |
 * | 1500 ms | 3037 ms | 3021 ms | **12 050 ms** | 3031 ms |
 *
 * So each operation costs a fixed number of one-way delays, and a relayed dial is by far the
 * most expensive: **8 one-way delays** (a direct dial to the relay is 2, a reservation request
 * on an already-open relay connection is 2, a protocol negotiation over an established circuit
 * is 2). A budget of B milliseconds therefore stops being able to open a relayed connection
 * above a one-way delay of B/8 — B/4 stated as a round trip between the two machines.
 *
 * Against that, the budgets in force:
 *
 * | budget | value | relayed dial impossible above |
 * | --- | --- | --- |
 * | `peer-join-backfill.ts` `dialTimeoutMs`, and Optimystic's `DEFAULT_DIAL_TIMEOUT_MS` | 3 s | 375 ms one-way (0.75 s round trip) |
 * | libp2p `connectionManager.dialTimeout` (its own default; db-p2p neither sets nor exposes it) | 10 s | 1250 ms one-way (2.5 s round trip) |
 * | libp2p `connectionManager.inboundUpgradeTimeout` (db-p2p sets 10_000) | 10 s | same, on the LISTENER's side |
 *
 * The listener's budget is the one that makes the failure look like nothing at all. Above the
 * ceiling the dialer's own `dial()` still resolves — measured 12 050 ms at 1500 ms one-way —
 * but the listener abandoned the half-built connection at 10 s, so the dialer holds a
 * connection whose every stream dies with `Unexpected EOF - stream closed while reading 0/1
 * bytes` and the listener never reports a peer at all. The two arms below are what shows that
 * it is the listener and not the link: at 1500 ms one-way with the shipped 10 s, `newStream`
 * fails with exactly that error and the listener holds 0 relayed connections; with 120 s the
 * same `newStream` takes 3031 ms and the listener holds 1.
 *
 * Read the listener's count AFTER the stream, not the one right after the dial. That earlier
 * one is 0 at every delay, healthy links included — the dialer's `dial()` resolves a moment
 * before the listener finishes registering its own side — so it says nothing on its own. It is
 * reported anyway because a reader who sees only the later count will otherwise wonder.
 */

import { describe, it, expect } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { installWsLatency, startDedicatedRelay } from '../harness/index.js';

const MEASURE = process.env.RELAY_DIAL_COST === '1';

/** One-way delays to sweep, in ms. Parsed strictly: a typo must fail, not measure nothing. */
function delays(): number[] {
	const raw = process.env.RELAY_DIAL_COST_DELAYS;
	if (!MEASURE || raw === undefined || raw.trim() === '') return [0, 900, 1500];
	return raw.split(',').map((part) => {
		const value = Number(part.trim());
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`RELAY_DIAL_COST_DELAYS must be a comma-separated list of non-negative integers, not ${JSON.stringify(raw)}`);
		}
		return value;
	});
}

/**
 * The listener-side budget each arm builds its nodes with: the 10 s `libp2p-node-base.ts`
 * ships (libp2p's own default), and a 120 s control that is above the measured setup cost at
 * every delay swept. The pair is the discriminator — a failure that disappears at 120 s is the
 * listener giving up, not the link.
 */
const INBOUND_UPGRADE_TIMEOUTS = [10_000, 120_000];

/** Far above every budget in the stack, so the unbounded arm measures the cost, not a limit. */
const UNBOUNDED_MS = 300_000;

/**
 * Run `fn` under a deadline, built from an explicit controller and a timer cleared on every
 * exit path. Not `AbortSignal.timeout`: the repo's lint rule forbids it because Hermes (React
 * Native) does not reliably have it, and a harness does not get to be the exception that
 * teaches the pattern wrong.
 */
async function underBudget<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`budget of ${ms} ms elapsed`)), ms);
	try {
		return await fn(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

/** `@libp2p/circuit-relay-v2`'s transport-side reservation store, reached as cadre-core reaches it. */
interface ReservationStoreLike {
	addRelay(peerId: unknown, type: 'discovered' | 'configured'): Promise<unknown>;
}

/**
 * Ask for the reservation explicitly rather than leaving it to relay discovery, for the reason
 * `packages/cadre-core/src/relay-reservation.ts` states at length: discovery nominates a relay
 * only from its peer-store protocol list, which identify writes, and `'discovered'` is the type
 * whose pending id the bare `/p2p-circuit` listener registered.
 */
function reservationStore(node: Libp2p): ReservationStoreLike {
	const components = node as unknown as { components: { transportManager: { getTransports(): unknown[] } } };
	for (const transport of components.components.transportManager.getTransports()) {
		const store = (transport as { reservationStore?: ReservationStoreLike }).reservationStore;
		if (store !== undefined && typeof store.addRelay === 'function') return store;
	}
	throw new Error('node has no circuit-relay transport');
}

async function makeNode(inboundUpgradeTimeout: number): Promise<Libp2p> {
	return await createLibp2p({
		// The bare SEARCH listen address, the shape every cadre node takes.
		addresses: { listen: ['/p2p-circuit'] },
		transports: [webSockets(), circuitRelayTransport()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		// `libp2p-node-base.ts`'s own two values (`maxConnections` 16, `inboundUpgradeTimeout`
		// 10_000) — the second is what the arms vary.
		connectionManager: { maxConnections: 16, inboundUpgradeTimeout },
		// cadre-core's DEFAULT_CONNECTION_MONITOR, so the liveness ping does not tear a slow
		// link down underneath the measurement (`complete/slow-peer-dropped-on-ping-timeout`).
		connectionMonitor: { pingInterval: 35_000, pingTimeout: { minTimeout: 30_000, maxTimeout: 30_000 } },
		services: { identify: identify() }
	});
}

function circuitAddrOf(node: Libp2p): string | undefined {
	return node.getMultiaddrs().map(String).find((addr) => addr.includes('/p2p-circuit'));
}

async function waitForCircuitAddr(node: Libp2p, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const addr = circuitAddrOf(node);
		if (addr !== undefined) return addr;
		if (Date.now() > deadline) throw new Error('no /p2p-circuit address published in time');
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function relayedConnectionCount(node: Libp2p): number {
	return node.getConnections().filter((conn) => String(conn.remoteAddr).includes('p2p-circuit')).length;
}

/**
 * Record how long `fn` took, or how long it took to fail and why. A failure is DATA here — three
 * of the rows this file exists to report are failures — so nothing is rethrown.
 */
async function timed<T>(into: Record<string, unknown>, key: string, fn: () => Promise<T>): Promise<T | undefined> {
	const started = Date.now();
	try {
		const value = await fn();
		into[key] = Date.now() - started;
		return value;
	} catch (error) {
		into[key] = `FAILED after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`;
		return undefined;
	}
}

describe.runIf(MEASURE)('relayed dial cost by link latency (opt-in: RELAY_DIAL_COST=1)', () => {
	for (const delayMs of delays()) {
		for (const inboundUpgradeTimeout of INBOUND_UPGRADE_TIMEOUTS) {
			it(`measures a relayed dial at ${delayMs} ms one-way, listener inboundUpgradeTimeout ${inboundUpgradeTimeout} ms`, async () => {
				// Before any node exists: the shim swaps the global constructor, which is read at
				// dial time, and a node dials during start().
				const latency = installWsLatency({ delayMs, mode: 'pipelined' });
				const relay = await startDedicatedRelay();
				const relayPeer = peerIdFromString(relay.peerId);
				const measured: Record<string, unknown> = {};
				let dialer: Libp2p | undefined;
				let listener: Libp2p | undefined;
				try {
					dialer = await makeNode(inboundUpgradeTimeout);
					listener = await makeNode(inboundUpgradeTimeout);
					await listener.handle('/relay-dial-cost/1.0.0', (stream) => { void stream.close(); });

					for (const [label, node] of [['dialer', dialer], ['listener', listener]] as const) {
						await timed(measured, `${label}: dial the relay`, () =>
							underBudget(UNBOUNDED_MS, (signal) => node.dial(multiaddr(relay.dialAddr), { signal })));
						await timed(measured, `${label}: request the reservation`, () =>
							reservationStore(node).addRelay(relayPeer, 'discovered'));
						await timed(measured, `${label}: circuit addr published`, () =>
							waitForCircuitAddr(node, UNBOUNDED_MS));
					}

					const target = multiaddr(await waitForCircuitAddr(listener, UNBOUNDED_MS));

					// 1. What the relayed dial costs, under a budget nothing in the stack imposes.
					const conn = await timed(measured, 'relayed dial (300 s budget)', () =>
						underBudget(UNBOUNDED_MS, (signal) => dialer!.dial(target, { signal })));
					measured['listener holds the connection, right after the dial'] = relayedConnectionCount(listener);
					if (conn !== undefined) {
						await timed(measured, 'newStream over that circuit', () =>
							underBudget(UNBOUNDED_MS, (signal) => conn.newStream('/relay-dial-cost/1.0.0', { signal })));
						measured['listener holds the connection, after the stream'] = relayedConnectionCount(listener);
						await conn.close().catch(() => { /* measuring, not asserting teardown */ });
					}
					await new Promise((resolve) => setTimeout(resolve, 1000));

					// 2. The same dial under libp2p's connection-manager default, which is what
					//    every caller that passes no signal of its own gets.
					await timed(measured, 'relayed dial (libp2p default 10 s)', () => dialer!.dial(target));
					await Promise.all(dialer.getConnections()
						.filter((c) => String(c.remoteAddr).includes('p2p-circuit'))
						.map((c) => c.close().catch(() => { /* as above */ })));
					await new Promise((resolve) => setTimeout(resolve, 1000));

					// 3. And under the 3 s budget the peer-join backfill and every Optimystic RPC use.
					await timed(measured, 'relayed dial (3000 ms budget)', () =>
						underBudget(3000, (signal) => dialer!.dial(target, { signal })));

					// The one claim, rather than a measurement: given enough budget, a relayed dial
					// DOES complete at every delay swept — so every failure above is a budget.
					expect(typeof measured['relayed dial (300 s budget)']).toBe('number');
				} finally {
					console.log(
						`[relayed-dial-cost] one-way ${delayMs} ms, listener inboundUpgradeTimeout ${inboundUpgradeTimeout} ms ->`,
						JSON.stringify(measured, null, 1)
					);
					await Promise.resolve(dialer?.stop()).catch(() => { /* teardown */ });
					await Promise.resolve(listener?.stop()).catch(() => { /* teardown */ });
					await relay.stop().catch(() => { /* teardown */ });
					latency.restore();
				}
			}, 600_000);
		}
	}
});
