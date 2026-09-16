/**
 * host-node-request.ts — ask a **cadre-host** for a node, and walk the phone
 * through every step until that node is connected.
 *
 * Terms, because nothing else in this package uses them:
 *
 * - **cadre-host** — the self-hosted manager someone runs on a machine at home.
 *   It can lend nodes to other people's cadres (`docs/cadre-host.md` → Node
 *   donation).
 * - **Grant token** — a secret that host's admin issues (`cadre-host grant
 *   issue`). Every call below presents it as `Authorization: Bearer <token>`.
 * - **Lent node** — the node cadre-host spawns as a child process and hands to
 *   this phone's cadre.
 *
 * No native imports, on purpose: `fetch` and the node surface both arrive as
 * dependencies, so `test/host-node-request.spec.ts` drives the whole flow in
 * plain Node against fakes. `use-cadre.ts` is what passes the real ones.
 *
 * The six stages, against the routes in
 * `packages/cadre-host/src/server/routes/grants.ts`:
 *
 *   1. `requesting`       POST /grants — the host provisions a node.
 *   2. `waiting-for-node` GET /grants/:id/peer until the child reports an identity.
 *   3. `authorizing`      addDrone — the phone vouches it and mints a seed.
 *   4. `seeding`          PUT /grants/:id/seed — the node learns who its owner is.
 *   5. `connecting`       the phone dials the node and waits for the connection.
 *   6. `connected`        done.
 *
 * WHO DIALS WHOM. The phone listens on nothing, so it never hands over a
 * bootstrap address (`bootstrapNodes` is left off the POST body) and is always
 * the side that opens the connection. `addDrone` retains the addresses the host
 * handed over as a durable dial target, which is what lets step 5 — and every
 * reconnect after a restart — find the node at all. The wire-level proof of this
 * whole path is
 * `packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts`.
 */

/** Where the flow has got to. Reported through {@link HostNodeRequestDeps.onStage}. */
export type HostNodeRequestStage =
	| 'requesting'
	| 'waiting-for-node'
	| 'authorizing'
	| 'seeding'
	| 'connecting'
	| 'connected';

/**
 * The slice of `CadreNode` this flow touches. Declared structurally rather than
 * as a `Pick<CadreNode, …>` so a test fake does not have to satisfy libp2p's
 * `Libp2p` type for {@link getControlNode}; a real `CadreNode` still satisfies it.
 */
export interface HostNodeRequestNode {
	/** The cadre the lent node is asked to join. */
	readonly partyId: string;
	/** This phone's owner keypair; only the public half is sent to the host. */
	getIdentityOwnerKey(): { publicKeyB64: string };
	/** Vouch the lent node into the cadre and mint the seed that proves it. */
	addDrone(options: { dronePeerId: string; droneMultiaddrs: string[] }): Promise<{ encodedSeed: string }>;
	/** Undo an {@link addDrone} whose loan then failed. */
	removePeer(peerId: string): Promise<void>;
	/** Dial the cohort now instead of waiting out the next timed pass. */
	reconcileControlCohort(): Promise<void>;
	/** The libp2p node behind the control network; null before start. */
	getControlNode(): { getConnections(): ReadonlyArray<{ remotePeer: { toString(): string }; status: string }> } | null;
}

/**
 * How long each bounded wait may run. Overridable so tests do not sit through
 * the real budgets; the defaults are what the app uses.
 */
export interface HostNodeRequestBudgets {
	/**
	 * Wait for the lent node to report a peer identity. 90 s matches the startup
	 * budget the donation integration scenarios allow a real child process.
	 */
	nodeStartupMs: number;
	/**
	 * Keep retrying a `502 seed_failed`. 30 s, as
	 * `cadre-host-node-donation.integration.ts` does — right after boot the node's
	 * seed route may not be up yet, and that answers the same way a real rejection
	 * does (see {@link putSeed}).
	 */
	seedRetryMs: number;
	/**
	 * Wait for the control connection to the lent node to come up, counted from
	 * before the first dial. 60 s is two full dials of the lent node at cadre-core's
	 * per-peer limit (30 s, `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS`): room for a
	 * first dial that finds nothing answering yet and a second one after it. See
	 * {@link connectToNode}.
	 */
	connectMs: number;
	/** Gap between polls in each of the waits above. */
	pollIntervalMs: number;
	/**
	 * Bound on the best-effort `DELETE /grants/:id` that cleanup issues. Without
	 * it a host that accepts the connection and then goes quiet would hold the
	 * flow open forever and the real failure would never reach the user.
	 */
	cleanupMs: number;
}

export interface HostNodeRequestDeps {
	/** The platform `fetch`. Injected so a test can drive the host side. */
	fetch: typeof fetch;
	node: HostNodeRequestNode;
	/** Called as each stage begins, for the progress line in Settings. */
	onStage?: (stage: HostNodeRequestStage) => void;
	/**
	 * Cancels the request — the phone's node stopping, or the screen going away.
	 * Cleanup still runs (and its `DELETE` is deliberately NOT bound to this
	 * signal, or cancelling would leak the host's node).
	 */
	signal?: AbortSignal;
	budgets?: Partial<HostNodeRequestBudgets>;
}

export interface HostNodeRequestResult {
	/** The host's id for this loan. */
	donationId: string;
	/** The lent node's libp2p peer id. */
	peerId: string;
}

const DEFAULT_BUDGETS: HostNodeRequestBudgets = {
	nodeStartupMs: 90_000,
	seedRetryMs: 30_000,
	connectMs: 60_000,
	pollIntervalMs: 1_000,
	cleanupMs: 10_000,
};

/**
 * A failure with a message meant for the person holding the phone. The host's
 * own wording is kept in {@link detail} rather than shown as the headline — its
 * codes and internal ids mean nothing to a user, but they are what makes a bug
 * report useful.
 */
export class HostNodeRequestError extends Error {
	readonly stage: HostNodeRequestStage;
	/** The host's error code (`unauthorized`, `seed_failed`, …), when it sent one. */
	readonly code?: string;
	/** The host's own message, or the underlying failure's. */
	readonly detail?: string;

	constructor(stage: HostNodeRequestStage, message: string, opts?: { code?: string; detail?: string; cause?: unknown }) {
		// `detail` is the readable half and `cause` the debuggable one — the original
		// error object, so a stack survives the rewrite into user-facing wording.
		super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
		this.name = 'HostNodeRequestError';
		this.stage = stage;
		this.code = opts?.code;
		this.detail = opts?.detail;
	}
}

/** What the host sends on a failure — `server/error-handler.ts` and the routes agree on this. */
interface HostErrorEnvelope {
	code: string;
	message: string;
}

/** Mutable context threaded through the steps, so each helper takes one argument. */
interface Flow {
	readonly base: string;
	readonly headers: Record<string, string>;
	readonly deps: HostNodeRequestDeps;
	readonly budgets: HostNodeRequestBudgets;
	stage: HostNodeRequestStage;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Borrow a node from the cadre-host at `hostUrl` and return once the phone holds
 * a control connection to it.
 *
 * On any failure after the node was provisioned, the loan is ended and the
 * phone's authorization for it removed, both best-effort — see {@link cleanup}
 * for why leaving either behind is worse than the failure itself.
 *
 * @param hostUrl The host's management address, e.g. `http://127.0.0.1:8088`.
 * @param grantToken The bearer the host's admin issued.
 */
export async function requestHostNode(
	hostUrl: string,
	grantToken: string,
	deps: HostNodeRequestDeps,
): Promise<HostNodeRequestResult> {
	const token = grantToken.trim();
	if (!token) {
		throw new HostNodeRequestError('requesting', 'Enter the grant token the host gave you.');
	}
	const flow: Flow = {
		base: normalizeHostUrl(hostUrl),
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		deps,
		budgets: { ...DEFAULT_BUDGETS, ...deps.budgets },
		stage: 'requesting',
	};

	// What `cleanup` has to undo, filled in as the flow gets far enough to create
	// each of them.
	let donationId: string | undefined;
	let dronePeerId: string | undefined;
	try {
		setStage(flow, 'requesting');
		donationId = await provisionNode(flow);

		setStage(flow, 'waiting-for-node');
		const peer = await waitForPeer(flow, donationId);

		setStage(flow, 'authorizing');
		// Marked as needing cleanup BEFORE the call, not after it: `addDrone` writes
		// the authorization row and THEN mints the seed (`seed-bootstrap.ts`), so a
		// failure in the second half leaves the row behind. Cleaning up a row that was
		// never written is a logged no-op; leaving one that was is a lasting authorized
		// member for a node nobody has.
		dronePeerId = peer.peerId;
		const encodedSeed = await authorizeNode(flow, peer);

		setStage(flow, 'seeding');
		await putSeed(flow, donationId, encodedSeed);

		setStage(flow, 'connecting');
		await connectToNode(flow, peer.peerId);

		setStage(flow, 'connected');
		return { donationId, peerId: peer.peerId };
	} catch (err) {
		await cleanup(flow, donationId, dronePeerId);
		throw err;
	}
}

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * `POST /grants` — the host spawns a node into this phone's cadre.
 *
 * `bootstrapNodes` is deliberately absent: the phone has no address to give, so
 * the node comes up with no bootstrap peers and the phone dials in (see the
 * module comment). `profile: 'storage'` asks for a node that participates in
 * storage — the point of borrowing one.
 */
async function provisionNode(flow: Flow): Promise<string> {
	// Reading the owner key can throw on a node whose identity never resolved, and
	// that has to surface as this flow's own error type — every caller reads
	// `detail` and `stage` off it.
	let ownerKey: string;
	try {
		ownerKey = flow.deps.node.getIdentityOwnerKey().publicKeyB64;
	} catch (err) {
		throw nodeError(flow, 'This phone has no owner key to vouch for a lent node with.', err);
	}

	const res = await send(flow, 'POST', '/grants', {
		partyId: flow.deps.node.partyId,
		ownerKeys: [ownerKey],
		profile: 'storage',
	});
	if (!res.ok) throw await hostError(flow, res);

	const body = await readJson(flow, res) as { data?: { donation?: { id?: unknown } } };
	const id = body.data?.donation?.id;
	if (typeof id !== 'string' || id.length === 0) {
		// The one leak `cleanup` cannot close: the host provisioned a node and this
		// reply is how its id was to arrive, so there is nothing to `DELETE` by. Say so,
		// because the only remedy is on the host side.
		throw new HostNodeRequestError(
			flow.stage,
			'The host accepted the request but did not say which node it lent, so the app cannot manage it. End the loan from the host.',
		);
	}
	return id;
}

interface LentNodePeer {
	peerId: string;
	/** Already carrying `/p2p/<peerId>`, as {@link authorizeNode} needs them. */
	multiaddrs: string[];
}

/**
 * Poll `GET /grants/:id/peer` until the child process has a libp2p identity.
 *
 * Only `peer_unavailable` (503) is retried — that is the host saying "still
 * booting". A 404 means the loan has ended, either terminated or reaped after
 * its half-hour in `awaiting_seed`, and retrying it would only burn the budget.
 */
async function waitForPeer(flow: Flow, donationId: string): Promise<LentNodePeer> {
	const deadline = Date.now() + flow.budgets.nodeStartupMs;
	for (;;) {
		const res = await send(flow, 'GET', `/grants/${donationId}/peer`);
		if (res.ok) return readPeer(flow, res);

		const envelope = await readErrorEnvelope(res);
		if (envelope.code !== 'peer_unavailable') throw hostErrorFrom(flow, res.status, envelope);
		if (Date.now() >= deadline) {
			throw new HostNodeRequestError(
				flow.stage,
				`The lent node did not finish starting within ${seconds(flow.budgets.nodeStartupMs)} seconds.`,
				{ code: envelope.code, detail: envelope.message },
			);
		}
		await delay(flow, flow.budgets.pollIntervalMs);
	}
}

/** The peer identity out of a 200 from `/peer`, with the peer id bound onto each address. */
async function readPeer(flow: Flow, res: Response): Promise<LentNodePeer> {
	const body = await readJson(flow, res) as { data?: { peerId?: unknown; multiaddrs?: unknown } };
	const peerId = body.data?.peerId;
	const multiaddrs = body.data?.multiaddrs;
	if (typeof peerId !== 'string' || !Array.isArray(multiaddrs) || multiaddrs.length === 0) {
		throw new HostNodeRequestError(flow.stage, 'The host reported the lent node without an address to reach it at.');
	}
	return {
		peerId,
		multiaddrs: multiaddrs.filter((a): a is string => typeof a === 'string').map((a) => withPeerId(a, peerId)),
	};
}

/**
 * Vouch the lent node into this cadre and mint the seed that proves it.
 *
 * The address list is MIXED — TCP as well as WebSocket, loopback as well as LAN —
 * and is passed through unfiltered. cadre-core normalises it and dials each
 * address on its own, and one this device has no transport for fails at once;
 * filtering here would only risk dropping the one address that works.
 */
async function authorizeNode(flow: Flow, peer: LentNodePeer): Promise<string> {
	try {
		const drone = await flow.deps.node.addDrone({
			dronePeerId: peer.peerId,
			droneMultiaddrs: peer.multiaddrs,
		});
		return drone.encodedSeed;
	} catch (err) {
		throw nodeError(flow, 'This phone could not authorize the lent node.', err);
	}
}

/**
 * `PUT /grants/:id/seed` — hand the node the seed, which is how it learns who its
 * owner is and where to find the rest of the cadre.
 *
 * Retried while the host answers `502 seed_failed`. That single code covers both
 * "the node's seed route is not up yet" (common for a few seconds after boot) and
 * "the node's trust policy rejected the seed" (permanent). Nothing distinguishes
 * them but the message text, and parsing that would be guesswork — so both are
 * retried, and a real rejection costs the retry window and then surfaces the
 * host's own wording.
 */
async function putSeed(flow: Flow, donationId: string, encodedSeed: string): Promise<void> {
	const deadline = Date.now() + flow.budgets.seedRetryMs;
	for (;;) {
		const res = await send(flow, 'PUT', `/grants/${donationId}/seed`, { seed: encodedSeed });
		if (res.ok) return;

		const envelope = await readErrorEnvelope(res);
		if (envelope.code !== 'seed_failed') throw hostErrorFrom(flow, res.status, envelope);
		if (Date.now() >= deadline) throw hostErrorFrom(flow, res.status, envelope);
		await delay(flow, flow.budgets.pollIntervalMs);
	}
}

/**
 * Dial the lent node and wait for the connection.
 *
 * The dialing is `reconcileControlCohort`: it finds the lent node among the
 * cadre's members and dials the addresses `addDrone` retained, each address on
 * its own time limit so an unreachable one cannot use up the time the others
 * needed. It is also what reconnects after a restart, so the flow uses the same
 * path rather than a dial of its own. The match is on the lent node's own peer
 * id, not "any connection": a phone can hold unrelated connections (a relay, in
 * future), and counting one of those would report success for a node that never
 * answered.
 *
 * The whole step is bounded by `connectMs`, counted from before the first pass.
 * Whenever a pass ends without the connection — one that listed the cadre's
 * members before `addDrone` ran, or one whose dial found nothing answering yet —
 * the next starts at the following poll rather than waiting for the node's timed
 * pass. `reconcileControlCohort` runs one pass at a time and a call made during a
 * pass joins it, so this never dials twice at once.
 *
 * NOTE: a pass dials the cadre's members one after another, owners first, and an
 * unreachable member costs up to cadre-core's per-peer limit (30 s) before the
 * lent node's turn. A cadre with an offline owner device can therefore use most
 * of `connectMs` before this node is dialed. If that shows up, dial the lent node
 * ahead of the pass rather than raising the budget again.
 */
async function connectToNode(flow: Flow, dronePeerId: string): Promise<void> {
	const deadline = Date.now() + flow.budgets.connectMs;
	const passes = reconcilePasses(flow.deps.node);
	for (;;) {
		if (isConnectedTo(flow.deps.node, dronePeerId)) return;
		const failure = passes.failure();
		if (failure) throw nodeError(flow, 'This phone could not dial the lent node.', failure.error);
		if (Date.now() >= deadline) {
			throw new HostNodeRequestError(
				flow.stage,
				`The lent node was set up but this phone could not reach it within ${seconds(flow.budgets.connectMs)} seconds. `
				+ 'Check that the phone and the host are on the same Wi-Fi network.',
			);
		}
		passes.ensureRunning();
		await delay(flow, flow.budgets.pollIntervalMs);
	}
}

/**
 * Keeps a `reconcileControlCohort` pass going for {@link connectToNode}.
 * `ensureRunning` starts a pass unless one this flow started is still running; a
 * pass that throws is kept, and every later call to `ensureRunning` does nothing,
 * so the caller reports that failure instead of retrying it.
 */
function reconcilePasses(node: HostNodeRequestNode): {
	ensureRunning(): void;
	failure(): { error: unknown } | undefined;
} {
	let running = false;
	let failed: { error: unknown } | undefined;
	return {
		ensureRunning() {
			if (running || failed) return;
			running = true;
			void node.reconcileControlCohort().then(
				() => { running = false; },
				(error: unknown) => { failed = { error }; },
			);
		},
		failure: () => failed,
	};
}

/** Does the control node hold an open connection to `dronePeerId` right now? */
function isConnectedTo(node: HostNodeRequestNode, dronePeerId: string): boolean {
	const connections = node.getControlNode()?.getConnections() ?? [];
	return connections.some((c) => c.status === 'open' && c.remotePeer.toString() === dronePeerId);
}

/**
 * Undo as much of a failed request as is still undoable, best-effort.
 *
 * Both halves matter and neither may replace the original error:
 *
 * - `removePeer` drops the authorization row `addDrone` wrote. Leaving it means
 *   the phone keeps an authorized member — and a dial hint — for a node that no
 *   longer exists, and every seed it later mints names that ghost.
 * - `DELETE /grants/:id` frees the grant's node-quota slot and the host's ports.
 *   Skipping it means a grant that allows one node is used up by a node nobody
 *   has.
 *
 * `removePeer` goes FIRST because it is the only half that needs the phone's own
 * node to still be running, and the usual reason this runs is that the node is
 * being stopped (`use-cadre.ts`'s `stop` aborts, then waits for this to finish —
 * a wait it bounds, so a `DELETE` to a host that has gone quiet must not be what
 * the local removal is queued behind). `endLoan` needs only the network.
 */
async function cleanup(flow: Flow, donationId?: string, dronePeerId?: string): Promise<void> {
	if (dronePeerId) {
		try {
			await flow.deps.node.removePeer(dronePeerId);
		} catch (err) {
			console.warn('[host-node-request] could not remove the lent node’s authorization row:', err);
		}
	}
	if (donationId) await endLoan(flow, donationId);
}

/** The `DELETE` half of {@link cleanup}, on its own deadline and its own signal. */
async function endLoan(flow: Flow, donationId: string): Promise<void> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), flow.budgets.cleanupMs);
	try {
		// Deliberately NOT `flow.deps.signal`: the caller's signal is usually already
		// aborted by the time we get here, and an aborted DELETE leaks the host's node.
		const res = await flow.deps.fetch(`${flow.base}/grants/${donationId}`, {
			method: 'DELETE',
			headers: flow.headers,
			signal: abort.signal,
		});
		if (!res.ok) {
			console.warn(`[host-node-request] the host refused to end loan ${donationId} (HTTP ${res.status})`);
		}
	} catch (err) {
		console.warn(`[host-node-request] could not end loan ${donationId} on the host:`, err);
	} finally {
		clearTimeout(timer);
	}
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

/** One request against the host, with the bearer attached and the caller's signal honoured. */
async function send(flow: Flow, method: string, path: string, body?: unknown): Promise<Response> {
	try {
		return await flow.deps.fetch(`${flow.base}${path}`, {
			method,
			headers: flow.headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: flow.deps.signal,
		});
	} catch (err) {
		throwIfAborted(flow);
		throw new HostNodeRequestError(
			flow.stage,
			`Could not reach the host at ${flow.base}. Check the address, and that the host is running and on the same network.`,
			{ detail: errorMessage(err), cause: err },
		);
	}
}

/** A success body as JSON; a host that answers 200 with something else is still a failure. */
async function readJson(flow: Flow, res: Response): Promise<Record<string, unknown>> {
	try {
		return await res.json() as Record<string, unknown>;
	} catch (err) {
		throw new HostNodeRequestError(flow.stage, 'The host sent a reply this app could not read.', {
			detail: errorMessage(err),
			cause: err,
		});
	}
}

/**
 * The `{ code, message }` out of a failure response. A body that is not the
 * host's envelope — a proxy's HTML error page, say — still yields something
 * usable rather than throwing over the top of the real failure.
 */
async function readErrorEnvelope(res: Response): Promise<HostErrorEnvelope> {
	try {
		const body = await res.json() as { error?: { code?: unknown; message?: unknown } };
		const code = body.error?.code;
		const message = body.error?.message;
		if (typeof code === 'string') {
			return { code, message: typeof message === 'string' ? message : `HTTP ${res.status}` };
		}
	} catch {
		// Fall through — an unparseable body is described by its status alone.
	}
	return { code: '', message: `HTTP ${res.status}` };
}

/** Read the envelope off a failure response and turn it into the error to throw. */
async function hostError(flow: Flow, res: Response): Promise<HostNodeRequestError> {
	return hostErrorFrom(flow, res.status, await readErrorEnvelope(res));
}

/**
 * Map the host's status + code to something a person can act on.
 *
 * The codes come from `packages/cadre-host/src/server/error-handler.ts`
 * (`DonationError`), `routes/grants.ts` (the bearer gate) and
 * `server/origin-guard.ts` (`forbidden_origin`).
 */
function hostErrorFrom(flow: Flow, status: number, envelope: HostErrorEnvelope): HostNodeRequestError {
	return new HostNodeRequestError(flow.stage, plainMessage(status, envelope.code), {
		code: envelope.code || undefined,
		detail: envelope.message,
	});
}

function plainMessage(status: number, code: string): string {
	switch (code) {
		case 'forbidden_origin':
			return 'This host only accepts requests from the machine it runs on. '
				+ 'Forward its port to the phone (adb reverse) and use a http://127.0.0.1:<port> address, not the machine’s network address.';
		case 'quota_exceeded':
			return 'This grant has already lent out every node it is allowed to. Ask for a new grant, or end a loan on the host.';
		case 'seed_failed':
			return 'The lent node would not accept this cadre’s seed.';
		case 'peer_unavailable':
			return 'The lent node is not answering yet.';
		default:
			break;
	}
	switch (status) {
		case 400: return 'The host rejected this request as malformed. This is a bug in the app, not something you did.';
		case 401: return 'The host does not recognise this grant token. Check it was copied whole, from this host.';
		case 403: return 'This grant token has expired or been revoked. Ask the host’s owner for a new one.';
		case 404: return 'The host has no record of this loan — it was ended, or it expired while the request was running.';
		case 409: return 'The loan ended while this request was still running.';
		default: break;
	}
	return status >= 500
		? `The host ran into a problem handling the request (HTTP ${status}).`
		: `The host refused the request (HTTP ${status}).`;
}

/** Wrap a failure that came from the phone's own node rather than the host. */
function nodeError(flow: Flow, message: string, err: unknown): HostNodeRequestError {
	if (flow.deps.signal?.aborted) return abortError(flow);
	return new HostNodeRequestError(flow.stage, message, { detail: errorMessage(err), cause: err });
}

// ── Small helpers ────────────────────────────────────────────────────────────

/**
 * Trim, require a scheme this app can speak, and drop a trailing slash so every
 * path below joins cleanly. Rejecting a missing scheme is worth the strictness:
 * `192.168.1.10:8088` parses as a URL with the *protocol* `192.168.1.10:`, which
 * would fail much later and much less clearly.
 */
function normalizeHostUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new HostNodeRequestError('requesting', 'Enter the host’s address, for example http://127.0.0.1:8088.');
	}
	if (!/^https?:\/\//i.test(trimmed)) {
		throw new HostNodeRequestError(
			'requesting',
			`The host address must start with http:// or https:// — “${trimmed}” does not.`,
		);
	}
	return trimmed.replace(/\/+$/, '');
}

/** Bind the peer id onto an address, so a dial has something to authenticate the far side against. */
function withPeerId(addr: string, peerId: string): string {
	return addr.includes('/p2p/') ? addr : `${addr}/p2p/${peerId}`;
}

function setStage(flow: Flow, stage: HostNodeRequestStage): void {
	flow.stage = stage;
	flow.deps.onStage?.(stage);
}

/** Sleep between polls, waking early (and failing) if the caller cancels. */
function delay(flow: Flow, ms: number): Promise<void> {
	const signal = flow.deps.signal;
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(flow));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(flow));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function throwIfAborted(flow: Flow): void {
	if (flow.deps.signal?.aborted) throw abortError(flow);
}

function abortError(flow: Flow): HostNodeRequestError {
	return new HostNodeRequestError(flow.stage, 'The request was cancelled.');
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function seconds(ms: number): number {
	return Math.round(ms / 1000);
}
