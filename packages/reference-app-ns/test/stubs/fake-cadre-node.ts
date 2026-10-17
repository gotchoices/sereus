/**
 * The one fake edge node, and the fake `CadreNode` it runs, that the three
 * view-model suites drive (cadre, settings, chat), plus the two module doubles
 * that hand them over (`src/cadre-phone`, `src/chat-strand`).
 *
 * Shared rather than duplicated per suite. Each suite reaches it through a
 * `vi.hoisted(async () => import(…))` binding, which both the suite body and the
 * hoisted `vi.mock` factories can see; the two therefore share ONE instance for
 * the file's lifetime. Re-importing this module per test would not work: every
 * suite must call `vi.resetModules()` (`getCadreVm()` caches a module-level
 * singleton), and the mock factories do not re-import in step with the suite —
 * the factory keeps whichever instance it first captured, so a suite that
 * re-imported would end up configuring a different fake than the view model
 * was handed. Hence the explicit {@link reset}, called from every load helper.
 *
 * Every edge-node and node call is appended to {@link calls} so ORDER can be
 * asserted, not merely presence: a seed must decode before it is applied, an
 * unreadable invitation paste never reaches the edge node, and a Settings handler
 * given a blank field must make no call at all.
 *
 * {@link FakeNode} and {@link FakeEdgeNode} declare `implements` against the real
 * types, so a cadre-core signature change breaks the BUILD here rather than
 * leaving the suites green while the app breaks on device. A `vi.mock` factory is
 * not type-checked against the module it replaces, so without this the fakes
 * could drift arbitrarily far from the real classes.
 */

import type { Database } from '@quereus/quereus';
import { encodeCadreInvitation } from '@serfab/cadre-core';
import type {
	ApplySeedResult,
	CadreInvitation,
	CadreNode,
	CadreNodeEvents,
	ControlNetworkSeed,
	SeedTrustPolicy,
	StrandInstance,
	StrandStatus,
} from '@serfab/cadre-core';
import type {
	EdgeNode,
	EdgeNodeOptions,
	EdgeNodeStatus,
	JoinCadreOptions,
	JoinCadreResult,
	OwnerGenesisResult,
	SavedStart,
} from '@serfab/cadre-core/edge-node';

/**
 * The slice of `CadreNode` the view models reach. Pinned as a type so the
 * fake below is checked against the real signatures.
 */
type NodeSurface = Pick<CadreNode, 'isRunning' | 'peerId' | 'getStrands' | 'on' | 'off' | 'decodeSeed' | 'applySeed'>;

/** The slice of `EdgeNode` the view models reach. */
type EdgeSurface = Pick<
	EdgeNode,
	'status' | 'node' | 'options' | 'start' | 'stop' | 'loadSavedStart' | 'onStatus' | 'on' | 'joinCadre'
>;

/** Every edge-node, node and module call the view models make, in order. */
export const calls: string[] = [];

/**
 * Owner keys as the app sees them: opaque base64url strings. Each decodes to 32
 * bytes, which is all `decodeCadreInvitation`'s shape check asks of a key.
 */
const KEY_A = 'ZXhhbXBsZS1vd25lci1rZXktYWFhYWFhYWFhYWFhYWE';
/** The invitation keypair's two halves, 32 bytes each like the owner keys. */
const INVITE_KEY = 'ZXhhbXBsZS1pbnZpdGUta2V5LWFhYWFhYWFhYWFhYWE';
const INVITE_PRIVATE_KEY = 'ZXhhbXBsZS1pbnZpdGUtc2VlZC1hYWFhYWFhYWFhYWE';

/** The party {@link invitation} names, other than the one a running fake node starts in. */
export const INVITED_PARTY = 'party-invited';

/**
 * A well-formed cadre invitation, as `CadreNode.createCadreInvitation` would
 * bundle one: every field in the stored form the real decoder's shape check
 * requires. The signature is not verified at decode time, so it is a placeholder.
 */
export function invitation(): CadreInvitation {
	return {
		v: 1,
		partyId: INVITED_PARTY,
		invitePrivateKey: INVITE_PRIVATE_KEY,
		invite: {
			key: INVITE_KEY,
			peerId: null,
			expiresAt: '2026-10-08 00:00:00',
			totalUses: 1,
			stampId: 'stamp-1',
			issuerKey: KEY_A,
			issuerSig: 'issuer-signature',
		},
		ownerKeys: [KEY_A],
		members: ['/ip4/127.0.0.1/tcp/4002/ws/p2p/12D3KooWDroneDroneDroneDroneDroneDroneDroneDroneDrone'],
	};
}

/** {@link invitation} as the real encoder renders it — what a user would paste. */
export const ENCODED_INVITATION = encodeCadreInvitation(invitation());

/**
 * A strand the view models read `.strandId`, `.status` and `.database` off. The
 * real interface carries a dozen runtime-only fields (libp2p node, activity
 * counters, the full `StrandDatabase`); building them would say nothing about the
 * view models, so the cast is deliberate and lives at this ONE site.
 *
 * `database` is the Quereus `Database` the chat operations run against; it is
 * wrapped as the two `StrandDatabase` methods they call: `getDatabase()`, and
 * `commitDurability()`, which reports no commit, so no send is marked as not yet
 * delivered. A test modelling a `'syncing'` joiner saves the wrapped
 * `strand.database`, sets it to `undefined`, and puts it back when the strand
 * becomes writable.
 */
export function fakeStrand(
	status: StrandStatus = 'active',
	{ strandId = 'strand-1', database }: { strandId?: string; database?: Database } = {},
): StrandInstance {
	return {
		strandId,
		status,
		...(database ? { database: { getDatabase: () => database, commitDurability: () => undefined } } : {}),
	} as unknown as StrandInstance;
}

/** Opaque return values — the view models forward these, they never read into them. */
export const sentinels = {
	decodedSeed: { tag: 'decoded-seed' } as unknown as ControlNetworkSeed,
	strandInstance: fakeStrand(),
};

/** A seed the node accepted. */
export function acceptance(): ApplySeedResult {
	return { success: true, peersAdded: 2, preferredDialsAttempted: 0, preferredDialsFailed: 0 };
}

/** A seed the node refused, with the reason it would give (or none at all). */
export function refusal(error?: string): ApplySeedResult {
	return { success: false, peersAdded: 0, preferredDialsAttempted: 0, preferredDialsFailed: 0, ...(error ? { error } : {}) };
}

/** A machine invitation a member accepted, naming itself; it admits the phone as a member. */
function admission(): JoinCadreResult {
	return { peerId: '12D3KooWDroneDroneDroneDroneDroneDroneDroneDroneDrone', redeemedAt: '2026-10-07T00:00:00.000Z', asOwner: false };
}

/**
 * The `CadreNode` surface `cadre-vm.ts` actually reaches. Handed to the view
 * model through the fake edge node, so it arrives exactly as a real node would.
 */
export class FakeNode implements NodeSurface {
	isRunning = true;
	/** Only `.toString()` is ever read; the real `PeerId` is a libp2p value type. */
	peerId = { toString: () => 'peer-abc' } as unknown as CadreNode['peerId'];
	strands = new Map<string, StrandInstance>();

	/** Handlers registered via `on`, per event. `off` deletes by identity. */
	readonly bound = new Map<string, Set<unknown>>();

	decodeSeedError: Error | null = null;
	applySeedResult: ApplySeedResult = acceptance();

	readonly decodedSeeds: string[] = [];
	readonly applied: { seed: ControlNetworkSeed; options: { trustPolicy?: SeedTrustPolicy } | undefined }[] = [];

	getStrands(): Map<string, StrandInstance> {
		calls.push('getStrands');
		return this.strands;
	}

	on(event: string, handler: unknown): void {
		calls.push(`on:${event}`);
		let set = this.bound.get(event);
		if (!set) {
			set = new Set();
			this.bound.set(event, set);
		}
		set.add(handler);
	}

	off(event: string, handler: unknown): void {
		calls.push(`off:${event}`);
		this.bound.get(event)?.delete(handler);
	}

	/** Fire an event at whatever is currently bound — models the real emitter. */
	emit(event: string, payload: unknown): void {
		for (const handler of this.bound.get(event) ?? []) {
			(handler as (p: unknown) => void)(payload);
		}
	}

	boundHandlerCount(): number {
		return [...this.bound.values()].reduce((n, set) => n + set.size, 0);
	}

	decodeSeed(encoded: string): ControlNetworkSeed {
		calls.push('decodeSeed');
		this.decodedSeeds.push(encoded);
		if (this.decodeSeedError) throw this.decodeSeedError;
		return sentinels.decodedSeed;
	}

	async applySeed(seed: ControlNetworkSeed, options?: { trustPolicy?: SeedTrustPolicy }): Promise<ApplySeedResult> {
		calls.push('applySeed');
		this.applied.push({ seed, options });
		return this.applySeedResult;
	}
}

/** The fake node as the edge node hands it out. The one cast between the two, at this ONE site. */
function asCadreNode(node: FakeNode): CadreNode {
	return node as unknown as CadreNode;
}

/** The options {@link presentRunningNode} reports the node started with. */
const RUNNING_OPTIONS: EdgeNodeOptions = { partyId: 'party-x', bootstrapAddrs: [], relayAddrs: [] };

/** A node event subscription, re-applied to the node each time it comes up, as the real edge node does. */
interface Subscription {
	event: string;
	handler: unknown;
}

/**
 * The phone's edge node as `cadre-vm.ts` reaches it: status reports, a start and
 * stop over {@link state}'s one node, the saved start, and a join that brings the
 * node up in the invitation's party.
 */
export class FakeEdgeNode implements EdgeSurface {
	status: EdgeNodeStatus = { state: 'stopped' };
	options: EdgeNodeOptions | null = null;
	private readonly listeners = new Set<(status: EdgeNodeStatus) => void>();
	private readonly subscriptions = new Set<Subscription>();

	get node(): CadreNode | null {
		return this.status.state === 'running' ? asCadreNode(state.node) : null;
	}

	async start(options: EdgeNodeOptions): Promise<CadreNode> {
		calls.push('start');
		state.startOpts.push(options);
		if (this.status.state === 'running') return asCadreNode(state.node);
		this.report({ state: 'starting' });
		if (state.startError) {
			this.report({ state: 'failed', error: state.startError });
			throw state.startError;
		}
		this.run(options);
		return asCadreNode(state.node);
	}

	async stop(): Promise<void> {
		calls.push('stop');
		this.takeDown();
		this.report({ state: 'stopped' });
	}

	async loadSavedStart(): Promise<SavedStart | undefined> {
		return state.savedStart;
	}

	onStatus(listener: (status: EdgeNodeStatus) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	on<K extends keyof CadreNodeEvents>(event: K, handler: (data: CadreNodeEvents[K]) => void): () => void {
		const subscription: Subscription = { event, handler };
		this.subscriptions.add(subscription);
		if (this.status.state === 'running') state.node.on(event, handler);
		return () => {
			this.subscriptions.delete(subscription);
			state.node.off(event, handler);
		};
	}

	/** Admitted: running in the invitation's party with the relays asked for, as a member. Refused: back in the party it left, throwing. */
	async joinCadre(invitation: CadreInvitation, options: JoinCadreOptions = {}): Promise<JoinCadreResult> {
		calls.push('joinCadre');
		state.joined.push({ invitation, options });
		if (state.joinError) throw state.joinError;
		this.takeDown();
		this.run({ partyId: invitation.partyId, bootstrapAddrs: [], relayAddrs: options.relayAddrs ?? [], origin: 'joined' }, 'member');
		return state.joinResult;
	}

	/** Bring {@link state}'s node up with `options`, every subscription attached, and report it running with its owner step settled as `owner`. */
	run(options: EdgeNodeOptions, owner: OwnerGenesisResult = 'enrolled'): void {
		for (const { event, handler } of this.subscriptions) state.node.on(event, handler);
		this.options = options;
		this.report({ state: 'running', node: asCadreNode(state.node), owner });
	}

	/** Detach every subscription from the node going down, as the real edge node's stop does. */
	private takeDown(): void {
		if (this.status.state === 'running') {
			for (const { event, handler } of this.subscriptions) state.node.off(event, handler);
		}
		this.options = null;
	}

	/** Report `status` to every listener; a test calls it for a report no view-model action caused. */
	report(status: EdgeNodeStatus): void {
		this.status = status;
		for (const listener of this.listeners) listener(status);
	}

	clear(): void {
		this.status = { state: 'stopped' };
		this.options = null;
		this.listeners.clear();
		this.subscriptions.clear();
	}
}

/** The one fake edge node, handed to every view model through the mocked `cadre-phone`. */
export const edge = new FakeEdgeNode();

export const state = {
	/** The single fake node a suite drives; one per {@link reset}. */
	node: new FakeNode(),
	startError: null as Error | null,
	dialError: null as Error | null,
	createStrandError: null as Error | null,
	/** What `edge.joinCadre` throws when set; else it resolves to {@link joinResult}. */
	joinError: null as Error | null,
	joinResult: admission(),
	startOpts: [] as EdgeNodeOptions[],
	/** Every invitation handed to `edge.joinCadre`, decoded, with its options. */
	joined: [] as { invitation: CadreInvitation; options: JoinCadreOptions }[],
	/** What `edge.loadSavedStart()` resolves to — nothing saved by default. */
	savedStart: undefined as SavedStart | undefined,
};

/** Back to a fresh, empty world — one fake node, nothing running, nothing recorded. */
export function reset(): void {
	calls.length = 0;
	edge.clear();
	state.node = new FakeNode();
	state.startError = null;
	state.dialError = null;
	state.createStrandError = null;
	state.joinError = null;
	state.joinResult = admission();
	state.startOpts = [];
	state.joined = [];
	state.savedStart = undefined;
}

/** Report {@link state}'s node running, so a freshly-constructed view model adopts it. */
export function presentRunningNode(): FakeNode {
	edge.run(RUNNING_OPTIONS);
	return state.node;
}

/** Drop everything recorded so far — used to skip past a view model's adopt path. */
export function clearCalls(): void {
	calls.length = 0;
}

// ── The two module doubles ────────────────────────────────────────────────────

async function dialPeer(addr: string): Promise<void> {
	calls.push(`dialPeer:${addr}`);
	if (state.dialError) throw state.dialError;
}

async function createChatStrand(node: unknown, strandId: string): Promise<StrandInstance> {
	calls.push('createChatStrand');
	if (state.createStrandError) throw state.createStrandError;
	// The real helper adds the strand to the node — which is what the view model's
	// following `refreshStrands()` is expected to pick up.
	(node as FakeNode).strands.set(strandId, sentinels.strandInstance);
	return sentinels.strandInstance;
}

/** Replacement module shape for `src/cadre-phone`. */
export function phoneNodeMock(): Record<string, unknown> {
	return { edge, dialPeer };
}

/** Replacement module shape for `src/chat-strand`. */
export function chatStrandMock(): Record<string, unknown> {
	return { createChatStrand };
}
