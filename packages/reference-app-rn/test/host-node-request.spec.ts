import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HostNodeRequestError,
	requestHostNode,
	type HostNodeRequestBudgets,
	type HostNodeRequestNode,
	type HostNodeRequestStage,
} from '../src/host-node-request.js';

/**
 * The phone's side of borrowing a node from a **cadre-host** — the self-hosted
 * manager that lends nodes to other people's cadres.
 *
 * `host-node-request.ts` imports nothing native and takes both `fetch` and the
 * node surface as dependencies, so the whole six-stage flow runs here against a
 * fake host and a fake node. What that buys, and what it does not:
 *
 * - **Covered:** the call sequence and the exact POST body, stage reporting, the
 *   two bounded retry loops, cancellation, every cleanup path, and the mapping
 *   from the host's `{ ok:false, error:{ code, message } }` envelope to a message
 *   a person can act on.
 * - **NOT covered:** the real host. `FakeHost` knows only the server rules copied
 *   into it (see {@link parserRefusal}); no test runs this client against the
 *   real `/grants` server, which is
 *   `tickets/backlog/debt-phone-host-client-against-real-grants-server.md`. That a
 *   real lent node comes up, that the seed is accepted, and that a listener-less
 *   phone can actually dial it are proved by
 *   `packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts`,
 *   which runs a real `cadre-cli` child but calls `DonationService` directly
 *   rather than over HTTP. A green file here says the phone drives the protocol
 *   correctly, not that the protocol works.
 *
 * Budgets are overridden to milliseconds throughout (see {@link FAST}), so the
 * deadline tests finish in real time instead of the app's 30–90 second waits.
 */

const HOST = 'http://127.0.0.1:8088';
const TOKEN = 'grant-token-abc';
const DRONE_PEER = '12D3KooWLentNode';
const OWNER_KEY = 'owner-public-key-b64';

/** The app's budgets, scaled down so a "until the deadline" test costs milliseconds. */
const FAST: Partial<HostNodeRequestBudgets> = {
	nodeStartupMs: 300,
	seedRetryMs: 150,
	connectMs: 300,
	pollIntervalMs: 2,
	cleanupMs: 100,
};

// ── Fake host ────────────────────────────────────────────────────────────────

interface Call {
	method: string;
	/** Path only — the base URL is asserted separately, once. */
	path: string;
	url: string;
	body: unknown;
	authorization: string | undefined;
	contentType: string | undefined;
}

/** How a fake host answers one request: a body+status, or a thrown network failure. */
type Reply = { status: number; body: unknown } | { throws: Error };

function ok(body: unknown): Reply {
	return { status: 200, body };
}

function created(body: unknown): Reply {
	return { status: 201, body };
}

/** The host's failure envelope, as `server/error-handler.ts` builds it. */
function fail(status: number, code: string, message: string): Reply {
	return { status, body: { ok: false, error: { code, message } } };
}

class FakeHost {
	readonly calls: Call[] = [];
	/** Per-route queues; the last entry repeats once the queue is down to it. */
	private readonly replies = new Map<string, Reply[]>();
	/** Runs before each reply is chosen — lets a test abort or mutate mid-flight. */
	onCall: ((call: Call) => void) | undefined;

	/** Queue replies for `METHOD /path` (`:id` stands for any single path segment). */
	route(key: string, ...replies: Reply[]): this {
		this.replies.set(key, replies);
		return this;
	}

	/** Every call this host saw, as `METHOD /path`, in order. */
	sequence(): string[] {
		return this.calls.map((c) => `${c.method} ${c.path}`);
	}

	countOf(key: string): number {
		return this.sequence().filter((s) => s === key).length;
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = String(input);
		const path = url.slice(HOST.length);
		const headers = new Headers(init?.headers);
		const call: Call = {
			method: init?.method ?? 'GET',
			path,
			url,
			body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
			authorization: headers.get('authorization') ?? undefined,
			contentType: headers.get('content-type') ?? undefined,
		};
		this.calls.push(call);
		this.onCall?.(call);
		// An aborted signal must surface as a rejection, the way a real fetch does —
		// otherwise the cancellation tests pass against a fake that ignores the signal.
		if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		const reply = parserRefusal(call) ?? this.nextReply(call);
		if ('throws' in reply) throw reply.throws;
		return new Response(JSON.stringify(reply.body), {
			status: reply.status,
			headers: { 'content-type': 'application/json' },
		});
	};

	private nextReply(call: Call): Reply {
		const queue = this.replies.get(`${call.method} ${generalize(call.path)}`);
		if (!queue || queue.length === 0) {
			return fail(500, 'internal', `fake host has no reply for ${call.method} ${call.path}`);
		}
		return queue.length > 1 ? queue.shift()! : queue[0]!;
	}
}

/**
 * What a strict Fastify server (5.x, as cadre-host runs) answers before any route
 * sees the request. It reads a body only for the methods that can carry one, and
 * then needs `application/json` to be declared exactly when there is a body: an
 * empty body that declares it is `FST_ERR_CTP_EMPTY_JSON_BODY`, and a body that
 * does not is `FST_ERR_CTP_INVALID_MEDIA_TYPE`. cadre-host now tolerates the
 * first (`buildFastify` in `packages/cadre-host/src/server/server.ts`); the fake
 * stays strict so the phone keeps working against a host that does not.
 */
function parserRefusal(call: Call): Reply | undefined {
	if (call.method === 'GET' || call.method === 'HEAD') return undefined;
	const declaresJson = call.contentType?.startsWith('application/json') ?? false;
	if (declaresJson && call.body === undefined) {
		return fail(400, 'FST_ERR_CTP_EMPTY_JSON_BODY', 'Body cannot be empty when content-type is set to \'application/json\'');
	}
	if (!declaresJson && call.body !== undefined) {
		return fail(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE', `Unsupported Media Type: ${call.contentType ?? ''}`);
	}
	return undefined;
}

/** `/grants/abc123/seed` → `/grants/:id/seed`, so a route needs no id to match. */
function generalize(path: string): string {
	return path.replace(/^\/grants\/[^/]+/, '/grants/:id');
}

// ── Fake node ────────────────────────────────────────────────────────────────

interface FakeConnection {
	remotePeer: { toString(): string };
	status: string;
}

function connection(peerId: string, status = 'open'): FakeConnection {
	return { remotePeer: { toString: () => peerId }, status };
}

class FakeNode implements HostNodeRequestNode {
	readonly partyId = 'party-under-test';
	readonly addDroneArgs: Array<{ dronePeerId: string; droneMultiaddrs: string[] }> = [];
	readonly removedPeers: string[] = [];
	reconcileCount = 0;
	/** What `getControlNode().getConnections()` reports. Mutated by the fakes below. */
	connections: FakeConnection[] = [];
	/** Set to make `addDrone` fail the way a stopped node would. */
	addDroneError: Error | undefined;
	/** Set to make `removePeer` fail, so cleanup's own failure path is exercised. */
	removePeerError: Error | undefined;
	/** When true (the default), a reconcile pass brings the lent node's connection up. */
	connectOnReconcile = true;
	/** How many passes end WITHOUT the connection before one brings it up. */
	passesBeforeConnect = 0;
	/** How long each reconcile pass takes, in ms. */
	reconcileMs = 0;
	/** Set to make every reconcile pass reject. */
	reconcileError: Error | undefined;
	/** The most passes that were ever running at the same moment. */
	maxConcurrentPasses = 0;
	private runningPasses = 0;
	/** Appended to by the test so assertions can check node and host calls interleave correctly. */
	order: string[] = [];

	getIdentityOwnerKey(): { publicKeyB64: string } {
		return { publicKeyB64: OWNER_KEY };
	}

	async addDrone(options: { dronePeerId: string; droneMultiaddrs: string[] }): Promise<{ encodedSeed: string }> {
		this.order.push('addDrone');
		this.addDroneArgs.push(options);
		if (this.addDroneError) throw this.addDroneError;
		return { encodedSeed: `seed-for-${options.dronePeerId}` };
	}

	async removePeer(peerId: string): Promise<void> {
		this.order.push('removePeer');
		this.removedPeers.push(peerId);
		if (this.removePeerError) throw this.removePeerError;
	}

	async reconcileControlCohort(): Promise<void> {
		this.order.push('reconcile');
		this.reconcileCount++;
		this.runningPasses++;
		this.maxConcurrentPasses = Math.max(this.maxConcurrentPasses, this.runningPasses);
		try {
			if (this.reconcileMs > 0) await new Promise((resolve) => setTimeout(resolve, this.reconcileMs));
			if (this.reconcileError) throw this.reconcileError;
			if (this.connectOnReconcile && this.reconcileCount > this.passesBeforeConnect) {
				this.connections.push(connection(DRONE_PEER));
			}
		} finally {
			this.runningPasses--;
		}
	}

	getControlNode(): { getConnections(): ReadonlyArray<FakeConnection> } | null {
		return { getConnections: () => this.connections };
	}
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

/** A host wired for the happy path; individual tests re-route what they are testing. */
function happyHost(): FakeHost {
	return new FakeHost()
		.route('POST /grants', created({ ok: true, data: { donation: { id: 'donation-1' } } }))
		.route('GET /grants/:id/peer', ok({
			ok: true,
			data: {
				peerId: DRONE_PEER,
				// Mixed on purpose: TCP the phone cannot dial, loopback, and the `/ws`
				// entry that is the only one it can actually use.
				multiaddrs: ['/ip4/192.168.1.20/tcp/20341', '/ip4/127.0.0.1/tcp/20345/ws'],
			},
		}))
		.route('PUT /grants/:id/seed', ok({ ok: true, data: { peersAdded: 1 } }))
		.route('DELETE /grants/:id', ok({ ok: true }));
}

function run(host: FakeHost, node: FakeNode, extra?: {
	stages?: HostNodeRequestStage[];
	signal?: AbortSignal;
	hostUrl?: string;
}) {
	return requestHostNode(extra?.hostUrl ?? HOST, TOKEN, {
		fetch: host.fetch,
		node,
		budgets: FAST,
		signal: extra?.signal,
		onStage: extra?.stages ? (s) => extra.stages!.push(s) : undefined,
	});
}

/** Fail the test naming `label` if the promise resolves — `rejects` alone would not say which call. */
async function rejection(label: string, op: Promise<unknown>): Promise<HostNodeRequestError> {
	try {
		await op;
	} catch (err) {
		if (err instanceof HostNodeRequestError) return err;
		throw new Error(`${label} rejected with a non-HostNodeRequestError`, { cause: err });
	}
	throw new Error(`${label} resolved, but should have rejected`);
}

let warn: ReturnType<typeof vi.spyOn>;
/** Everything the flow logged through `console.warn`, flattened to one string per call. */
let warnings: string[] = [];

beforeEach(() => {
	// Cleanup failures are logged rather than thrown; capture them here so the tests
	// where the logging IS the point can assert on it, and the rest stay quiet.
	warnings = [];
	warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
		warnings.push(args.map((a) => String(a)).join(' '));
	});
});

afterEach(() => {
	warn.mockRestore();
});

/**
 * Cleanup ended the loan: one `DELETE` went out AND the host accepted it. A
 * refused or failed `DELETE` is only logged, so counting the call alone passes
 * for a loan that is still running on the host.
 */
function expectLoanEnded(host: FakeHost): void {
	expect(host.countOf('DELETE /grants/donation-1')).toBe(1);
	expect(warnings.filter((m) => m.includes('end loan'))).toEqual([]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('requestHostNode — the happy path', () => {
	it('drives the host and the node in order and resolves once the lent node is connected', async () => {
		const host = happyHost();
		const node = new FakeNode();
		const stages: HostNodeRequestStage[] = [];

		const result = await run(host, node, { stages });

		expect(result).toEqual({ donationId: 'donation-1', peerId: DRONE_PEER });
		expect(host.sequence()).toEqual([
			'POST /grants',
			'GET /grants/donation-1/peer',
			'PUT /grants/donation-1/seed',
		]);
		expect(node.order).toEqual(['addDrone', 'reconcile']);
		expect(stages).toEqual([
			'requesting', 'waiting-for-node', 'authorizing', 'seeding', 'connecting', 'connected',
		]);
		// Nothing to undo on success — a stray DELETE here would end the loan that
		// just succeeded.
		expect(host.countOf('DELETE /grants/donation-1')).toBe(0);
		expect(node.removedPeers).toEqual([]);
	});

	it('asks for a node with this cadre’s id and owner key, and NO bootstrap address', async () => {
		const host = happyHost();
		await run(host, new FakeNode());

		const post = host.calls[0]!;
		expect(post.url).toBe(`${HOST}/grants`);
		expect(post.authorization).toBe(`Bearer ${TOKEN}`);
		expect(post.body).toEqual({
			partyId: 'party-under-test',
			ownerKeys: [OWNER_KEY],
			profile: 'storage',
		});
		// The load-bearing absence: a phone has no address to be dialed at, so it must
		// not name itself as a bootstrap peer. Sending one would have the lent node try
		// to dial a node that never listens.
		expect(Object.keys(post.body as object)).not.toContain('bootstrapNodes');
	});

	it('hands addDrone the full mixed address list with the peer id bound on', async () => {
		const host = happyHost();
		const node = new FakeNode();
		await run(host, node);

		expect(node.addDroneArgs).toEqual([{
			dronePeerId: DRONE_PEER,
			// Unfiltered — libp2p drops what this device has no transport for, and
			// filtering here risks dropping the one address that works. Each carries
			// `/p2p/<peerId>` so the dial can authenticate the far side.
			droneMultiaddrs: [
				`/ip4/192.168.1.20/tcp/20341/p2p/${DRONE_PEER}`,
				`/ip4/127.0.0.1/tcp/20345/ws/p2p/${DRONE_PEER}`,
			],
		}]);
	});

	it('leaves an address that already names the peer alone', async () => {
		const host = happyHost()
			.route('GET /grants/:id/peer', ok({
				ok: true,
				data: { peerId: DRONE_PEER, multiaddrs: [`/ip4/127.0.0.1/tcp/20345/ws/p2p/${DRONE_PEER}`] },
			}));
		const node = new FakeNode();

		await run(host, node);

		// Appending a second `/p2p/…` would make the address unparseable, so the host
		// already having named the peer has to be a no-op rather than a concatenation.
		expect(node.addDroneArgs[0]!.droneMultiaddrs).toEqual([`/ip4/127.0.0.1/tcp/20345/ws/p2p/${DRONE_PEER}`]);
	});

	it('trims the host URL and strips a trailing slash before joining paths', async () => {
		const host = happyHost();
		await run(host, new FakeNode(), { hostUrl: `  ${HOST}/  ` });

		expect(host.calls[0]!.url).toBe(`${HOST}/grants`);
	});
});

describe('requestHostNode — waiting for the lent node to boot', () => {
	it('polls past peer_unavailable and continues once the node answers', async () => {
		const host = happyHost()
			.route('GET /grants/:id/peer',
				fail(503, 'peer_unavailable', 'Donated node has no peer identity yet'),
				fail(503, 'peer_unavailable', 'Donated node has no peer identity yet'),
				ok({ ok: true, data: { peerId: DRONE_PEER, multiaddrs: ['/ip4/127.0.0.1/tcp/20345/ws'] } }),
			);
		const node = new FakeNode();

		await run(host, node);

		expect(host.countOf('GET /grants/donation-1/peer')).toBe(3);
		expect(node.addDroneArgs).toHaveLength(1);
	});

	it('gives up on a node that never comes up, and ends the loan', async () => {
		const host = happyHost()
			.route('GET /grants/:id/peer', fail(503, 'peer_unavailable', 'no peer identity yet'));
		const node = new FakeNode();

		const err = await rejection('a node that never boots', run(host, node));

		expect(err.stage).toBe('waiting-for-node');
		expect(err.message).toContain('did not finish starting');
		expect(err.detail).toBe('no peer identity yet');
		expectLoanEnded(host);
		// `addDrone` never ran, so there is no authorization row to undo.
		expect(node.removedPeers).toEqual([]);
	});

	it('stops immediately on a 404 — the loan ended, and retrying only burns the budget', async () => {
		const host = happyHost()
			.route('GET /grants/:id/peer', fail(404, 'not_found', 'No such donation: donation-1'));
		const node = new FakeNode();

		const err = await rejection('a loan that ended mid-poll', run(host, node));

		expect(err.message).toContain('no record of this loan');
		expect(host.countOf('GET /grants/donation-1/peer')).toBe(1);
		expect(node.removedPeers).toEqual([]);
	});
});

describe('requestHostNode — seeding', () => {
	it('retries a 502 seed_failed, then rejects with the host’s own wording and undoes both halves', async () => {
		const host = happyHost()
			.route('PUT /grants/:id/seed', fail(502, 'seed_failed', 'Node rejected the seed: untrusted owner'));
		const node = new FakeNode();

		const err = await rejection('a seed the node keeps refusing', run(host, node));

		expect(err.stage).toBe('seeding');
		expect(err.code).toBe('seed_failed');
		expect(err.message).toContain('would not accept');
		expect(err.detail).toBe('Node rejected the seed: untrusted owner');
		// It really retried rather than failing on the first answer — the same code
		// covers "the seed route is not up yet", which does clear on its own.
		expect(host.countOf('PUT /grants/donation-1/seed')).toBeGreaterThan(1);
		// Both halves of cleanup: the host's quota slot AND the local authorization row.
		expectLoanEnded(host);
		expect(node.removedPeers).toEqual([DRONE_PEER]);
	});

	it('succeeds when the seed route comes up part-way through the retry window', async () => {
		const host = happyHost()
			.route('PUT /grants/:id/seed',
				fail(502, 'seed_failed', 'node not reachable yet'),
				ok({ ok: true, data: { peersAdded: 1 } }),
			);
		const node = new FakeNode();

		await run(host, node);

		expect(host.countOf('PUT /grants/donation-1/seed')).toBe(2);
		expect(node.removedPeers).toEqual([]);
	});

	it('surfaces a 409 without retrying — the loan ended while the seed was in flight', async () => {
		const host = happyHost()
			.route('PUT /grants/:id/seed', fail(409, 'invalid_state', 'Donation donation-1 ended (terminated)'));
		const node = new FakeNode();

		const err = await rejection('a seed against an ended loan', run(host, node));

		expect(err.message).toContain('loan ended while this request was still running');
		expect(host.countOf('PUT /grants/donation-1/seed')).toBe(1);
		expect(node.removedPeers).toEqual([DRONE_PEER]);
		expectLoanEnded(host);
	});
});

describe('requestHostNode — connecting', () => {
	it('matches the lent node’s own peer id, not just any open connection', async () => {
		const host = happyHost();
		const node = new FakeNode();
		// A relay, say. The phone holds it open the whole time and it says nothing
		// about whether the lent node answered.
		node.connections = [connection('12D3KooWSomeoneElse')];
		node.connectOnReconcile = false;

		const err = await rejection('a connection to an unrelated peer', run(host, node));

		expect(err.stage).toBe('connecting');
		expect(err.message).toContain('could not reach it');
		// Re-driven the whole time it stayed unconnected, not tried once.
		expect(node.reconcileCount).toBeGreaterThan(1);
		expectLoanEnded(host);
		expect(node.removedPeers).toEqual([DRONE_PEER]);
	});

	it('ignores a closed connection to the right peer', async () => {
		const host = happyHost();
		const node = new FakeNode();
		node.connections = [connection(DRONE_PEER, 'closed')];
		node.connectOnReconcile = false;

		const err = await rejection('a closed connection to the lent node', run(host, node));

		expect(err.stage).toBe('connecting');
	});

	it('starts another reconcile pass whenever one ends without the connection', async () => {
		// A pass that listed the cadre's members before `addDrone`, or whose dial found
		// nothing answering yet, must not leave the flow waiting for a timed pass.
		const host = happyHost();
		const node = new FakeNode();
		node.passesBeforeConnect = 2;

		const result = await run(host, node);

		expect(result.peerId).toBe(DRONE_PEER);
		expect(node.reconcileCount).toBe(3);
	});

	it('never runs a second pass while the first is still going', async () => {
		const host = happyHost();
		const node = new FakeNode();
		node.connectOnReconcile = false;
		// Many polls fit inside one pass (2 ms apart); none of them may start another.
		node.reconcileMs = 60;

		await rejection('a lent node that never connects', run(host, node));

		expect(node.maxConcurrentPasses).toBe(1);
		expect(node.reconcileCount).toBeGreaterThan(1);
	});

	it('counts connectMs from before the first pass, not from when it ends', async () => {
		// The device run that found this: the step's real length was the pass PLUS the
		// budget, while the message still named the budget alone.
		const host = happyHost();
		const node = new FakeNode();
		node.connectOnReconcile = false;
		node.reconcileMs = 2_000;
		let connectingAt = 0;

		const err = await rejection('a pass slower than the whole budget', requestHostNode(HOST, TOKEN, {
			fetch: host.fetch,
			node,
			budgets: FAST,
			onStage: (stage) => {
				if (stage === 'connecting') connectingAt = Date.now();
			},
		}));
		const connectStep = Date.now() - connectingAt;

		expect(err.stage).toBe('connecting');
		expect(err.message).toContain('could not reach it');
		expect(connectingAt).toBeGreaterThan(0);
		// FAST.connectMs is 300; waiting out the 2 s pass first would take over 2 s.
		expect(connectStep).toBeLessThan(1_500);
	});

	it('reports a pass that throws as this phone failing to dial, without retrying it', async () => {
		const host = happyHost();
		const node = new FakeNode();
		node.reconcileError = new Error('control node stopped');

		const err = await rejection('a reconcile pass that throws', run(host, node));

		expect(err.stage).toBe('connecting');
		expect(err.message).toBe('This phone could not dial the lent node.');
		expect(err.detail).toBe('control node stopped');
		expect(node.reconcileCount).toBe(1);
		expect(node.removedPeers).toEqual([DRONE_PEER]);
		expectLoanEnded(host);
	});
});

describe('requestHostNode — failures with nothing, or everything, to undo', () => {
	it('maps a 401 on the first call to the grant-token message and undoes nothing', async () => {
		const host = happyHost()
			.route('POST /grants', fail(401, 'unauthorized', 'Grant is unknown_token'));
		const node = new FakeNode();

		const err = await rejection('an unknown grant token', run(host, node));

		expect(err.stage).toBe('requesting');
		expect(err.code).toBe('unauthorized');
		expect(err.message).toContain('does not recognise this grant token');
		// There is no donation id yet, so there is nothing to DELETE.
		expect(host.sequence()).toEqual(['POST /grants']);
		expect(node.removedPeers).toEqual([]);
	});

	it('maps a revoked or expired grant to its own message', async () => {
		const host = happyHost().route('POST /grants', fail(403, 'forbidden', 'Grant is revoked'));

		const err = await rejection('a revoked grant', run(host, new FakeNode()));

		expect(err.message).toContain('expired or been revoked');
	});

	it('maps the host’s origin guard to the adb-reverse instruction', async () => {
		const host = happyHost()
			.route('POST /grants', fail(403, 'forbidden_origin', 'Host header "192.168.1.5:8088" is not allowed'));

		const err = await rejection('a LAN-address host URL', run(host, new FakeNode()));

		expect(err.code).toBe('forbidden_origin');
		expect(err.message).toContain('only accepts requests from the machine it runs on');
		expect(err.message).toContain('127.0.0.1');
	});

	it('maps a used-up grant to the node-limit message', async () => {
		const host = happyHost()
			.route('POST /grants', fail(429, 'quota_exceeded', 'Grant already at its maxNodes cap'));

		const err = await rejection('a grant at its cap', run(host, new FakeNode()));

		expect(err.message).toContain('already lent out every node it is allowed to');
	});

	it('says the host is unreachable when fetch itself fails', async () => {
		const host = happyHost()
			.route('POST /grants', { throws: new TypeError('Network request failed') });

		const err = await rejection('an unreachable host', run(host, new FakeNode()));

		expect(err.message).toContain(`Could not reach the host at ${HOST}`);
		expect(err.detail).toBe('Network request failed');
	});

	it('rejects a host address with no scheme before calling anything', async () => {
		const host = happyHost();

		const err = await rejection('a scheme-less host address', run(host, new FakeNode(), { hostUrl: '192.168.1.5:8088' }));

		expect(err.message).toContain('must start with http:// or https://');
		expect(host.calls).toEqual([]);
	});

	it('surfaces the original failure when cleanup’s own DELETE fails, and logs the cleanup failure', async () => {
		const host = happyHost()
			.route('PUT /grants/:id/seed', fail(409, 'invalid_state', 'Donation ended (terminated)'))
			.route('DELETE /grants/:id', { throws: new TypeError('Network request failed') });
		const node = new FakeNode();
		node.removePeerError = new Error('control database is closed');

		const err = await rejection('a failure whose cleanup also fails', run(host, node));

		// The original failure is what the user is told about — not the cleanup's.
		expect(err.message).toContain('loan ended while this request was still running');
		expect(warnings.some((m) => m.includes('could not end loan donation-1'))).toBe(true);
		expect(warnings.some((m) => m.includes('could not remove the lent node'))).toBe(true);
	});

	it('drops the local authorization row BEFORE it ends the loan on the host', async () => {
		const host = happyHost()
			.route('PUT /grants/:id/seed', fail(409, 'invalid_state', 'Donation ended (terminated)'));
		const node = new FakeNode();
		// Interleave the host's calls into the node's own log, so one array shows the order.
		host.onCall = (call) => { node.order.push(`${call.method} ${generalize(call.path)}`); };

		await rejection('a seed against an ended loan', run(host, node));

		// `removePeer` is the only half that needs the phone's node still running, and
		// the usual reason cleanup runs at all is that the node is being stopped — so it
		// must not be queued behind a DELETE to a host that may have gone quiet.
		expect(node.order.slice(-2)).toEqual(['removePeer', 'DELETE /grants/:id']);
	});

	it('says the host named no node when the accept reply carries no donation id', async () => {
		const host = happyHost().route('POST /grants', created({ ok: true, data: { donation: {} } }));
		const node = new FakeNode();

		const err = await rejection('an accept with no id', run(host, node));

		expect(err.stage).toBe('requesting');
		expect(err.message).toContain('did not say which node it lent');
		// Nothing to undo BY: the id was what this reply was carrying. The message has
		// to say so, because only the host can end that loan.
		expect(err.message).toContain('End the loan from the host');
		expect(host.sequence()).toEqual(['POST /grants']);
	});

	it('rejects a peer reply with no address to dial', async () => {
		const host = happyHost()
			.route('GET /grants/:id/peer', ok({ ok: true, data: { peerId: DRONE_PEER, multiaddrs: [] } }));
		const node = new FakeNode();

		const err = await rejection('a peer with no addresses', run(host, node));

		expect(err.message).toContain('without an address to reach it at');
		expect(node.addDroneArgs).toEqual([]);
		expectLoanEnded(host);
	});

	it('rejects a success reply this app cannot read', async () => {
		const host = happyHost().route('POST /grants', { status: 201, body: undefined });

		const err = await rejection('an unreadable 201', run(host, new FakeNode()));

		expect(err.message).toContain('could not read');
	});

	it('describes a failure by its status when the body is not the host’s envelope', async () => {
		// A reverse proxy's own error page, say — no `{ ok:false, error:{ code } }`.
		const host = happyHost().route('PUT /grants/:id/seed', { status: 502, body: undefined });
		const node = new FakeNode();

		const err = await rejection('a proxy error page', run(host, node));

		expect(err.code).toBeUndefined();
		expect(err.message).toContain('HTTP 502');
		// Not retried: without the `seed_failed` code there is no reason to believe
		// waiting helps, and the retry window would only delay the real failure.
		expect(host.countOf('PUT /grants/donation-1/seed')).toBe(1);
	});

	it('reports a node that stopped mid-request rather than blaming the host', async () => {
		const host = happyHost();
		const node = new FakeNode();
		node.addDroneError = new Error('Seed bootstrap service not initialized');

		const err = await rejection('a node that stopped mid-request', run(host, node));

		expect(err.stage).toBe('authorizing');
		expect(err.message).toContain('could not authorize the lent node');
		expect(err.detail).toBe('Seed bootstrap service not initialized');
		// `addDrone` writes the authorization row before it mints the seed, so the row
		// may exist even though the call threw — cleanup has to try either way.
		expect(node.removedPeers).toEqual([DRONE_PEER]);
		expectLoanEnded(host);
	});

	it('ends the loan with the bearer and no JSON content type, because the DELETE has no body', async () => {
		// The device run that found this: every request carried
		// `content-type: application/json`, and a body-less DELETE declaring it is
		// refused by a strict Fastify server — so the loan, and the host's node, lived on.
		const host = happyHost()
			.route('GET /grants/:id/peer', fail(404, 'not_found', 'No such donation: donation-1'));

		await rejection('a failure after the node was provisioned', run(host, new FakeNode()));

		const del = host.calls.find((c) => c.method === 'DELETE')!;
		expect(del.authorization).toBe(`Bearer ${TOKEN}`);
		expect(del.contentType).toBeUndefined();
		expectLoanEnded(host);
	});

	it('declares JSON on the requests that carry a body, and only on those', async () => {
		const host = happyHost();
		await run(host, new FakeNode());

		expect(host.calls.map((c) => [`${c.method} ${generalize(c.path)}`, c.contentType])).toEqual([
			['POST /grants', 'application/json'],
			['GET /grants/:id/peer', undefined],
			['PUT /grants/:id/seed', 'application/json'],
		]);
	});
});

describe('requestHostNode — cancellation', () => {
	it('rejects promptly when the caller aborts mid-poll, and still ends the loan', async () => {
		const abort = new AbortController();
		const host = happyHost()
			.route('GET /grants/:id/peer', fail(503, 'peer_unavailable', 'still booting'));
		// Abort once the poll is genuinely under way rather than before the first call.
		host.onCall = (call) => {
			if (call.path.endsWith('/peer')) abort.abort();
		};
		const node = new FakeNode();

		const err = await rejection('an aborted request', run(host, node, { signal: abort.signal }));

		expect(err.message).toBe('The request was cancelled.');
		expect(err.stage).toBe('waiting-for-node');
		// One poll, then the abort — not the full 300 ms budget's worth.
		expect(host.countOf('GET /grants/donation-1/peer')).toBe(1);
		// Cleanup runs on the aborted caller's behalf, and its DELETE is NOT bound to
		// the aborted signal — otherwise cancelling would leave the host's node running.
		expectLoanEnded(host);
	});

	it('refuses an empty grant token without calling the host', async () => {
		const host = happyHost();

		await expect(requestHostNode(HOST, '   ', { fetch: host.fetch, node: new FakeNode(), budgets: FAST }))
			.rejects.toThrow(/grant token/i);
		expect(host.calls).toEqual([]);
	});
});
