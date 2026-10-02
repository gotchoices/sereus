/**
 * What ONE relayed libp2p connection setup costs at a given link delay — opt-in, and never
 * part of `yarn test`.
 *
 * This was the reproduction for `strand-node-never-redials-through-a-relay-at-a-three-second-round-trip`:
 * two machines that reach each other only through a relay stop being able to connect at all
 * once the link is slow enough, and every dial budget in the stack was a fixed number of
 * milliseconds rather than a number of round trips. The measurement below is what turns that
 * into arithmetic: it times the relayed dial under a budget far above any the stack imposes,
 * and then re-runs it under the budgets that actually bound it in production. It is now also
 * the proof that the limits cadre-core declares carry the slowest link sereus supports (a
 * 3-second round trip, 1500 ms one-way — `docs/architecture.md` → "Relay Integration").
 *
 * Deliberately BARE libp2p — websockets + noise + yamux + circuit-relay-v2 + identify, with
 * cadre-core's `DEFAULT_CONNECTION_MONITOR` — and no cadre, no Optimystic, no database. The
 * cost being measured is the transport's, so a cadre stack on top of it could only hide the
 * signal. The two arms differ ONLY in the deadlines a node gets, which are what the
 * measurement is ABOUT: the `db-p2p fallback` arm takes what `@optimystic/db-p2p` gives a node
 * that declares no link round trip, and the `cadre-core declared` arm what a cadre node gets at
 * cadre-core's default declared link: Optimystic's derivation, with the dial limits cadre-core
 * states on top of it. Both are read from Optimystic's own `resolveLinkDeadlines` and
 * cadre-core's own `optimysticDialLimits`, so neither can drift from what a node really gets.
 *
 * ── Running it ──
 *
 *   RELAY_DIAL_COST=1 yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency
 *
 * Without `RELAY_DIAL_COST=1` the suite is skipped. `RELAY_DIAL_COST_DELAYS=<ms>[,<ms>…]`
 * picks the one-way delays to sweep (default `0,900,1500`); one arm at one delay costs about
 * 40 s.
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
 * **Re-run** the same day, same machine, when cadre's budgets were changed to count round trips:
 * relayed dial 20-25 ms at no delay, 7 255-7 279 ms at 900 ms one-way, 12 066-12 094 ms at
 * 1 500 ms one-way, across both listener arms. Within about 40 ms of the figures above, and
 * still 60-95 ms ABOVE four round trips of pure delay — the handshakes, which no delay figure
 * contains. So the COUNT is the repeatable quantity, and a budget derived from it needs a
 * declared round trip with a little headroom rather than one equal to the measured link.
 *
 * Against that, the budgets in force:
 *
 * | budget | value | relayed dial impossible above |
 * | --- | --- | --- |
 * | cadre's own dial budgets, DERIVED from this count (`cadre-core/src/link-budget.ts`) | 16 s at the default declared link: 4 round trips plus a flat 2 s for the called machine's admission decision | 1750 ms one-way when that decision takes its whole 2 s (2000 ms to a machine that runs no gate), and moves with `NetworkConfig.linkRoundTripMs` |
 * | libp2p `connectionManager.addressDialTimeout` and `dialTimeout` on every cadre node: Optimystic's derivation from the declared link (10 round trips, `resolveLinkDeadlines`) plus two admission decisions (`optimysticDialLimits`) | 39 s at the default declared link | 4375 ms one-way when both decisions take their whole 2 s (4875 ms through no gate) |
 * | libp2p `connectionManager.inboundUpgradeTimeout` on every cadre node, Optimystic's derivation alone (5 round trips) | 17.5 s at the default declared link | 2187 ms one-way |
 * | the three on a node that declares no link (db-p2p's floors, libp2p's own defaults) | 6 s per address; 10 s per dial and for the listener | 750 ms one-way (1.5 s round trip), at the per-address limit |
 * | Optimystic's request dial deadline on every cadre node: its derivation (11 round trips) plus two admission decisions | 42.5 s at the default declared link | the per-address limit above binds first |
 * | the same on a node that declares no link (`DEFAULT_DIAL_TIMEOUT_MS`) | 3 s | 375 ms one-way (0.75 s round trip) |
 *
 * The first two rows are what this measurement is FOR: cadre-core no longer types dial budgets
 * as milliseconds. `link-budget.ts` holds one round-trip count per operation, taken from the
 * table above, times one declared link round trip — so re-run this before changing a count
 * there, and update the counts here if a libp2p upgrade moves them. Before that change the
 * peer-join block catch-up allowed its dial 3 s, so over a relay it had never once been able to
 * copy a rejoining machine's missing blocks at any link slow enough to matter. The last row held
 * on every cadre node until `@optimystic/db-p2p` 1.8.0 let cadre-core state its declared link to
 * Optimystic: before that, an Optimystic request that had to open its own relayed connection
 * failed above 375 ms one-way.
 *
 * The listener's budget is the one that makes the failure look like nothing at all. Above the
 * ceiling the dialer's own `dial()` still resolves — measured 12 050 ms at 1500 ms one-way —
 * but the listener abandoned the half-built connection at 10 s, so the dialer holds a
 * connection whose every stream dies with `Unexpected EOF - stream closed while reading 0/1
 * bytes` and the listener never reports a peer at all. The two arms showed that it is the
 * listener and not the link, on libp2p 3.1, which had no per-address limit: at 1500 ms one-way
 * under db-p2p's fallback 10 s, `newStream` failed with exactly that error and the listener held
 * 0 relayed connections; with a 120 s listener limit (the arm this file carried before
 * cadre-core declared its own) the same `newStream` took 3031 ms and the listener held 1.
 *
 * **Proved** 2026-09-26, same machine, with `RELAY_DIAL_COST_DELAYS=0,1500`, once cadre-core
 * declared both limits (then 14 000 ms each at its default link): at 1500 ms one-way, the
 * `cadre-core declared` arm's relayed dial took 12 061 ms, `newStream` over it took 3016 ms,
 * the listener held 1 relayed connection after the stream, and a second dial with no signal of
 * its own completed in 12 068 ms inside the node's `dialTimeout`. The `db-p2p fallback` arm in
 * the same run reproduced the failure: dial 12 061 ms, `newStream` `Unexpected EOF` after
 * 2465 ms, listener holding 0, the signal-less dial aborted at 10 015 ms. Both arms' 3000 ms
 * dial failed at 3 s, as the last row of the table says it must. At 0 ms every operation in
 * both arms took 13-43 ms. The arm's assertions pin the passing half, at every delay up to
 * {@link SUPPORTED_ONE_WAY_MS}; the connection was not held past one liveness-ping cycle
 * (35 s), which this file does not wait for.
 *
 * **Proved again** 2026-09-29, same machine, same delays, once cadre-core stated its declared
 * link to Optimystic and took Optimystic's derived limits instead of setting its own (17 500 ms
 * each, and a 21 000 ms request dial deadline): at 1500 ms one-way the `cadre-core declared`
 * arm's relayed dial took 12 086 ms, `newStream` over it 3011 ms, the listener held 1, and both
 * the signal-less dial and the dial under the request deadline completed (12 086 and 12 091 ms).
 * The `db-p2p fallback` arm reproduced the failure as before (`newStream` `Unexpected EOF` after
 * 2455 ms, listener holding 0, the signal-less dial aborted at 10 005 ms, the 3000 ms request
 * dial at 3012 ms).
 *
 * **Proved again** 2026-10-01, same machine, `RELAY_DIAL_COST_DELAYS=1500`, on libp2p 3.3.11 and
 * `@optimystic/*` 1.9.0, once cadre-core stated its dial limits on top of Optimystic's (39 000 ms
 * per address and per dial, a 42 500 ms request dial, the listener's 17 500 ms): the
 * `cadre-core declared` arm's relayed dial took 12 089 ms, `newStream` over it 3018 ms, the
 * listener held 1, and the signal-less dial and the dial under the request deadline completed
 * in 12 100 and 12 094 ms. The `db-p2p fallback` arm now fails before the listener's limit is
 * reached: libp2p 3.3 applies its per-address limit (6 000 ms in that arm) inside every dial, a
 * caller's own signal included, so the 300 s dial and the signal-less dial both aborted at
 * 6 004-6 007 ms. That is the cut-off reported on gotchoices/sereus#13, and it is why that arm
 * no longer shows the listener's silent failure.
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
import { resolveLinkDeadlines, type Libp2pConnectionTimeouts, type LinkDeadlines } from '@optimystic/db-p2p';
import { DECLARED_LINK_ROUND_TRIP_MS, optimysticDialLimits } from '@serfab/cadre-core';
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

interface Arm {
	name: string;
	/** The connection-manager limits the arm builds BOTH its nodes with. */
	limits: Libp2pConnectionTimeouts;
	/** The deadline an Optimystic request dials under on a node of this arm. */
	requestDialTimeoutMs: number;
}

/**
 * The deadlines a node gets, as an arm: Optimystic's derivation, with an explicit
 * `connectionManager` limit winning over it the way `createLibp2pNode` resolves them. Both nodes
 * take the connection limits, because each is the listener for the other's dial. The pair is the
 * discriminator: a failure present under db-p2p's fallback and gone under cadre-core's
 * declaration is those limits giving up, not the link.
 */
function armOf(name: string, deadlines: LinkDeadlines, stated: Libp2pConnectionTimeouts = {}): Arm {
	const limits = {
		addressDialTimeout: stated.addressDialTimeout ?? deadlines.addressDialTimeoutMs,
		dialTimeout: stated.dialTimeout ?? deadlines.libp2pDialTimeoutMs,
		inboundUpgradeTimeout: stated.inboundUpgradeTimeout ?? deadlines.inboundUpgradeTimeoutMs
	};
	return { name, limits, requestDialTimeoutMs: deadlines.dialTimeoutMs };
}

const DB_P2P_FALLBACK = armOf('db-p2p fallback', resolveLinkDeadlines());
// What the control node and every strand node get: cadre-core always states its declared link,
// and the dial limits it derives from it on top of Optimystic's.
const CADRE_DIAL_LIMITS = optimysticDialLimits(DECLARED_LINK_ROUND_TRIP_MS);
const CADRE_DECLARED = armOf(
	'cadre-core declared',
	resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS, CADRE_DIAL_LIMITS.rpcDeadlines),
	CADRE_DIAL_LIMITS.connectionManager
);
const ARMS = [DB_P2P_FALLBACK, CADRE_DECLARED];

/**
 * The slowest link sereus supports, one-way: a 3-second round trip (`docs/architecture.md` →
 * "Relay Integration"). At or below it the `cadre-core declared` arm must open a connection
 * the listener holds and a stream works on.
 */
const SUPPORTED_ONE_WAY_MS = 1500;

/** Report keys the assertions read back. */
const LISTENER_AFTER_STREAM = 'listener holds the connection, after the stream';
const OWN_DIAL_TIMEOUT = 'relayed dial (the node\'s own dialTimeout)';
const REQUEST_DIAL_TIMEOUT = 'relayed dial (Optimystic request dial deadline)';

/**
 * Far above every budget a caller imposes. libp2p still applies the arm's per-address limit
 * (`addressDialTimeout`) inside a dial under this signal, so the dial measures the cost only while
 * that limit is longer: under the `cadre-core declared` arm (39 s) up to about 4 875 ms one-way,
 * under the `db-p2p fallback` arm (6 s) up to about 750 ms (eight one-way delays per dial).
 */
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

async function makeNode(limits: Libp2pConnectionTimeouts): Promise<Libp2p> {
	return await createLibp2p({
		// The bare SEARCH listen address, the shape every cadre node takes.
		addresses: { listen: ['/p2p-circuit'] },
		transports: [webSockets(), circuitRelayTransport()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		// `libp2p-node-base.ts`'s own `maxConnections` 16, plus the two limits the arms vary.
		connectionManager: { maxConnections: 16, ...limits },
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
		for (const arm of ARMS) {
			it(`measures a relayed dial at ${delayMs} ms one-way, ${arm.name} connection limits ${JSON.stringify(arm.limits)}`, async () => {
				// Before any node exists: the shim swaps the global constructor, which is read at
				// dial time, and a node dials during start().
				const latency = installWsLatency({ delayMs, mode: 'pipelined' });
				const relay = await startDedicatedRelay();
				const relayPeer = peerIdFromString(relay.peerId);
				const measured: Record<string, unknown> = {};
				let dialer: Libp2p | undefined;
				let listener: Libp2p | undefined;
				try {
					dialer = await makeNode(arm.limits);
					listener = await makeNode(arm.limits);
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
						measured[LISTENER_AFTER_STREAM] = relayedConnectionCount(listener);
						await conn.close().catch(() => { /* measuring, not asserting teardown */ });
					}
					await new Promise((resolve) => setTimeout(resolve, 1000));

					// 2. The same dial under the node's own `dialTimeout`, which is what every
					//    caller that passes no signal of its own gets.
					await timed(measured, OWN_DIAL_TIMEOUT, () => dialer!.dial(target));
					await Promise.all(dialer.getConnections()
						.filter((c) => String(c.remoteAddr).includes('p2p-circuit'))
						.map((c) => c.close().catch(() => { /* as above */ })));
					await new Promise((resolve) => setTimeout(resolve, 1000));

					// 3. And under the deadline an Optimystic request dials with on this arm's node.
					await timed(measured, REQUEST_DIAL_TIMEOUT, () =>
						underBudget(arm.requestDialTimeoutMs, (signal) => dialer!.dial(target, { signal })));

					if (arm === CADRE_DECLARED && delayMs <= SUPPORTED_ONE_WAY_MS) {
						// The claim this arm exists for, rather than a measurement: at the supported
						// link, a relayed dial completes inside cadre-core's per-address limit (so
						// every failure under the fallback arm is a limit, not the link), opens a
						// connection the LISTENER holds, and a stream works on it; and a dial with no
						// signal of its own completes inside the node's own `dialTimeout`, as does one
						// under an Optimystic request's dial deadline. Not claimed for the fallback
						// arm: its 6 s per-address limit cuts the first dial off above about 750 ms
						// one-way, whatever the caller's budget (see UNBOUNDED_MS).
						expect(typeof measured['relayed dial (300 s budget)']).toBe('number');
						expect(measured[LISTENER_AFTER_STREAM]).toBe(1);
						expect(typeof measured['newStream over that circuit']).toBe('number');
						expect(typeof measured[OWN_DIAL_TIMEOUT]).toBe('number');
						expect(typeof measured[REQUEST_DIAL_TIMEOUT]).toBe('number');
					}
				} finally {
					console.log(
						`[relayed-dial-cost] one-way ${delayMs} ms, ${arm.name} ${JSON.stringify(arm.limits)} ->`,
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
