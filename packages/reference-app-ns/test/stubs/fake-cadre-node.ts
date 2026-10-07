/**
 * The one fake `CadreNode` the three view-model suites drive (cadre, settings,
 * chat), plus the two module doubles that hand it to them (`src/cadre-phone`,
 * `src/chat-strand`).
 *
 * Shared rather than duplicated per suite. Each suite reaches it through a
 * `vi.hoisted(async () => import(…))` binding, which both the suite body and the
 * hoisted `vi.mock` factories can see; the two therefore share ONE instance for
 * the file's lifetime. Re-importing this module per test would not work: every
 * suite must call `vi.resetModules()` (`getCadreVm()` caches a module-level
 * singleton), and the mock factories do not re-import in step with the suite —
 * the factory keeps whichever instance it first captured, so a suite that
 * re-imported would end up configuring a different fake node than the view model
 * was handed. Hence the explicit {@link reset}, called from every load helper.
 *
 * Every node call is appended to {@link calls} so ORDER can be asserted, not
 * merely presence: the join path must decode the paste before it redeems (an
 * unreadable paste never reaches the node), a seed must decode before it is
 * applied, and a Settings handler given a blank field must make no call at all.
 * Per-spy call-order plumbing would not read as an ordering at the assertion
 * site.
 *
 * {@link FakeNode} declares `implements NodeSurface`, so a cadre-core signature
 * change breaks the BUILD here rather than leaving the suites green while the
 * app breaks on device. A `vi.mock` factory is not type-checked against the
 * module it replaces, so without this the fake could drift arbitrarily far from
 * the real class.
 */

import type { SavedStartOptions } from '../../src/start-options';
import type { Database } from '@quereus/quereus';
import { encodeCadreInvitation } from '@serfab/cadre-core';
import type {
	ApplySeedResult,
	CadreInvitation,
	CadreNode,
	ControlNetworkSeed,
	RedeemCadreInvitationResult,
	SeedTrustPolicy,
	StrandInstance,
	StrandStatus,
} from '@serfab/cadre-core';

/**
 * The slice of `CadreNode` the view models reach. Pinned as a type so the
 * fake below is checked against the real signatures.
 */
type NodeSurface = Pick<
	CadreNode,
	'isRunning' | 'peerId' | 'getStrands' | 'on' | 'off' | 'decodeSeed' | 'applySeed' | 'redeemCadreInvitation'
>;

/** Every node/module call the view models make, in order. */
export const calls: string[] = [];

/**
 * Owner keys as the app sees them: opaque base64url strings. Each decodes to 32
 * bytes, which is all `decodeCadreInvitation`'s shape check asks of a key.
 */
export const KEY_A = 'ZXhhbXBsZS1vd25lci1rZXktYWFhYWFhYWFhYWFhYWE';
export const KEY_B = 'ZXhhbXBsZS1vd25lci1rZXktYmJiYmJiYmJiYmJiYmI';
/** The invitation keypair's two halves, 32 bytes each like the owner keys. */
const INVITE_KEY = 'ZXhhbXBsZS1pbnZpdGUta2V5LWFhYWFhYWFhYWFhYWE';
const INVITE_PRIVATE_KEY = 'ZXhhbXBsZS1pbnZpdGUtc2VlZC1hYWFhYWFhYWFhYWE';

/**
 * A well-formed cadre invitation, as `CadreNode.createCadreInvitation` would
 * bundle one: every field in the stored form the real decoder's shape check
 * requires. The signature is not verified at decode time, so it is a placeholder.
 */
export function invitation(): CadreInvitation {
	return {
		v: 1,
		partyId: 'party-x',
		invitePrivateKey: INVITE_PRIVATE_KEY,
		invite: {
			key: INVITE_KEY,
			peerId: null,
			grantsOwner: false,
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
 * wrapped as the one `StrandDatabase` method they call, `getDatabase()`. A test
 * modelling a `'syncing'` joiner saves the wrapped `strand.database`, sets it to
 * `undefined`, and puts it back when the strand becomes writable.
 */
export function fakeStrand(
	status: StrandStatus = 'active',
	{ strandId = 'strand-1', database }: { strandId?: string; database?: Database } = {},
): StrandInstance {
	return {
		strandId,
		status,
		...(database ? { database: { getDatabase: () => database } } : {}),
	} as unknown as StrandInstance;
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

/** An invitation a member accepted, naming itself. */
export function admission(): RedeemCadreInvitationResult {
	return { peerId: '12D3KooWDroneDroneDroneDroneDroneDroneDroneDroneDrone', grantsOwner: false, redeemedAt: '2026-10-07T00:00:00.000Z' };
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

	decodeSeedError: Error | null = null;
	applySeedResult: ApplySeedResult = acceptance();
	/** What `redeemCadreInvitation` throws when set; else it resolves to {@link redeemResult}. */
	redeemError: Error | null = null;
	redeemResult: RedeemCadreInvitationResult = admission();

	readonly decodedSeeds: string[] = [];
	readonly applied: { seed: ControlNetworkSeed; options: { trustPolicy?: SeedTrustPolicy } | undefined }[] = [];
	/** Every bundle handed to `redeemCadreInvitation`, decoded. */
	readonly redeemed: CadreInvitation[] = [];

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

	async redeemCadreInvitation(invitation: CadreInvitation): Promise<RedeemCadreInvitationResult> {
		calls.push('redeemCadreInvitation');
		this.redeemed.push(invitation);
		if (this.redeemError) throw this.redeemError;
		return this.redeemResult;
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
	/** What the mocked `loadSavedStartOptions()` resolves to — nothing saved by default. */
	savedStartOptions: undefined as SavedStartOptions | undefined,
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
	state.savedStartOptions = undefined;
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

async function loadSavedStartOptions(): Promise<SavedStartOptions | undefined> {
	return state.savedStartOptions;
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
	return { startPhoneNode, stopPhoneNode, getPhoneNode, loadSavedStartOptions, dialPeer };
}

/** Replacement module shape for `src/chat-strand`. */
export function chatStrandMock(): Record<string, unknown> {
	return { createChatStrand };
}
