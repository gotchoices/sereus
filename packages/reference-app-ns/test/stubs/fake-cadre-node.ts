/**
 * The one fake `CadreNode` both view-model suites drive, plus the two module
 * doubles that hand it to them (`src/cadre-phone`, `src/chat-strand`).
 *
 * Shared rather than duplicated per suite. Each suite reaches it through a
 * `vi.hoisted(async () => import(…))` binding, which both the suite body and the
 * hoisted `vi.mock` factories can see; the two therefore share ONE instance for
 * the file's lifetime. Re-importing this module per test would not work: both
 * suites must call `vi.resetModules()` (`getCadreVm()` caches a module-level
 * singleton), and the mock factories do not re-import in step with the suite —
 * the factory keeps whichever instance it first captured, so a suite that
 * re-imported would end up configuring a different fake node than the view model
 * was handed. Hence the explicit {@link reset}, called from every load helper.
 *
 * Every node call is appended to {@link calls} so ORDER can be asserted, not
 * merely presence — the enrollment seam under test is an ordering
 * (`trustOwnerKeys` strictly before `applySeed`), and per-spy call-order
 * plumbing would not read as an ordering at the assertion site.
 *
 * {@link FakeNode} declares `implements NodeSurface`, so a cadre-core signature
 * change breaks the BUILD here rather than leaving both suites green while the
 * app breaks on device. A `vi.mock` factory is not type-checked against the
 * module it replaces, so without this the fake could drift arbitrarily far from
 * the real class.
 */

import type {
	ApplySeedResult,
	CadreInvite,
	CadreNode,
	ControlNetworkSeed,
	SeedTrustPolicy,
	StrandInstance,
	StrandStatus,
	TrustSource,
} from '@serfab/cadre-core';

/**
 * The slice of `CadreNode` the two view models reach. Pinned as a type so the
 * fake below is checked against the real signatures — including argument ORDER,
 * which is what a `trustOwnerKeys(source, keys)` refactor would change.
 */
type NodeSurface = Pick<
	CadreNode,
	'isRunning' | 'peerId' | 'getStrands' | 'on' | 'off' | 'decodeInvite' | 'decodeSeed' | 'trustOwnerKeys' | 'applySeed'
>;

/** Every node/module call the view models make, in order. */
export const calls: string[] = [];

/** Owner keys as the app sees them: opaque base64url strings carried by an invite. */
export const KEY_A = 'ZXhhbXBsZS1vd25lci1rZXktYWFhYWFhYWFhYWFhYWFh';
export const KEY_B = 'ZXhhbXBsZS1vd25lci1rZXktYmJiYmJiYmJiYmJiYmJi';

/**
 * A strand the view models only ever read `.status` off. The real interface
 * carries a dozen runtime-only fields (libp2p node, Quereus database, activity
 * counters); building them would say nothing about the view models, so the cast
 * is deliberate and lives at this ONE site.
 */
export function fakeStrand(status: StrandStatus = 'active'): StrandInstance {
	return { status } as unknown as StrandInstance;
}

/** Opaque return values — the view models forward these, they never read into them. */
export const sentinels = {
	decodedSeed: { tag: 'decoded-seed' } as unknown as ControlNetworkSeed,
	strandInstance: fakeStrand(),
};

/** A seed the node accepted. */
export function acceptance(): ApplySeedResult {
	return { success: true, peersAdded: 2, ownerDialsAttempted: 0, ownerDialsFailed: 0 };
}

/** A seed the node refused, with the reason it would give (or none at all). */
export function refusal(error?: string): ApplySeedResult {
	return { success: false, peersAdded: 0, ownerDialsAttempted: 0, ownerDialsFailed: 0, ...(error ? { error } : {}) };
}

/**
 * The `CadreNode` surface `cadre-vm.ts` actually reaches. Handed to the view
 * model through the mocked `cadre-phone` module, so it arrives exactly as a real
 * node would.
 */
export class FakeNode implements NodeSurface {
	isRunning = true;
	/** Only `.toString()` is ever read; the real `PeerId` is a libp2p value type. */
	peerId = { toString: () => 'peer-abc' } as unknown as CadreNode['peerId'];
	strands = new Map<string, StrandInstance>();

	/** Handlers registered via `on`, per event. `off` deletes by identity. */
	readonly bound = new Map<string, Set<unknown>>();

	/** What `decodeInvite` hands back when it does not throw. */
	invite: CadreInvite = { partyId: 'party-x', ownerAddrs: [], createdAt: 0 };
	decodeInviteError: Error | null = null;
	decodeSeedError: Error | null = null;
	applySeedResult: ApplySeedResult = acceptance();

	readonly decodedInvites: string[] = [];
	readonly decodedSeeds: string[] = [];
	readonly trusted: { keys: string[]; source: Exclude<TrustSource, 'genesis'> }[] = [];
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
		// By identity: a view model that handed a freshly-created closure here would
		// leave the original bound, and `boundHandlerCount()` would still see it.
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

	decodeInvite(encoded: string): CadreInvite {
		calls.push('decodeInvite');
		this.decodedInvites.push(encoded);
		if (this.decodeInviteError) throw this.decodeInviteError;
		return this.invite;
	}

	decodeSeed(encoded: string): ControlNetworkSeed {
		calls.push('decodeSeed');
		this.decodedSeeds.push(encoded);
		if (this.decodeSeedError) throw this.decodeSeedError;
		return sentinels.decodedSeed;
	}

	/**
	 * Parameters taken from the real signature rather than restated, because
	 * `implements` alone would NOT catch a swap to `trustOwnerKeys(source, keys)`:
	 * method parameters are checked bivariantly, and a `TrustSource` string is
	 * itself an `Iterable<string>`, so both orders type-check. Binding through the
	 * real tuple makes the swap land in {@link trusted} instead, where the two
	 * field types do not interchange.
	 */
	async trustOwnerKeys(...[keys, source]: Parameters<CadreNode['trustOwnerKeys']>): Promise<void> {
		calls.push('trustOwnerKeys');
		this.trusted.push({ keys: [...keys], source });
	}

	async applySeed(seed: ControlNetworkSeed, options?: { trustPolicy?: SeedTrustPolicy }): Promise<ApplySeedResult> {
		calls.push('applySeed');
		this.applied.push({ seed, options });
		return this.applySeedResult;
	}
}

export const state = {
	/** The single fake node a suite drives; one per fresh import of this module. */
	node: new FakeNode(),
	/** What the mocked `getPhoneNode()` returns — null until a test adopts or starts. */
	phoneNode: null as FakeNode | null,
	startError: null as Error | null,
	dialError: null as Error | null,
	createStrandError: null as Error | null,
	startOpts: [] as unknown[],
};

/** Back to a fresh, empty world — one fake node, nothing running, nothing recorded. */
export function reset(): void {
	calls.length = 0;
	state.node = new FakeNode();
	state.phoneNode = null;
	state.startError = null;
	state.dialError = null;
	state.createStrandError = null;
	state.startOpts = [];
}

/** Make {@link state}'s node the one a freshly-constructed view model adopts. */
export function presentRunningNode(): FakeNode {
	state.phoneNode = state.node;
	return state.node;
}

/** Drop everything recorded so far — used to skip past a view model's adopt path. */
export function clearCalls(): void {
	calls.length = 0;
}

// ── The two module doubles ────────────────────────────────────────────────────

async function startPhoneNode(opts: unknown): Promise<FakeNode> {
	calls.push('startPhoneNode');
	state.startOpts.push(opts);
	if (state.startError) throw state.startError;
	state.phoneNode = state.node;
	return state.node;
}

async function stopPhoneNode(): Promise<void> {
	calls.push('stopPhoneNode');
	state.phoneNode = null;
}

function getPhoneNode(): FakeNode | null {
	return state.phoneNode;
}

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
	return { startPhoneNode, stopPhoneNode, getPhoneNode, dialPeer };
}

/** Replacement module shape for `src/chat-strand`. */
export function chatStrandMock(): Record<string, unknown> {
	return { createChatStrand };
}
