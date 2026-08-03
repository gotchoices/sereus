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
 */

import type { SeedTrustPolicy } from '@serfab/cadre-core';

/** Every node/module call the view models make, in order. */
export const calls: string[] = [];

/** Owner keys as the app sees them: opaque base64url strings carried by an invite. */
export const KEY_A = 'ZXhhbXBsZS1vd25lci1rZXktYWFhYWFhYWFhYWFhYWFh';
export const KEY_B = 'ZXhhbXBsZS1vd25lci1rZXktYmJiYmJiYmJiYmJiYmJi';

/** Opaque return values — the view models forward these, they never read into them. */
export const sentinels = {
	decodedSeed: { tag: 'decoded-seed' },
	strandInstance: { status: 'active', tag: 'strand-instance' },
};

/**
 * The `CadreNode` surface `cadre-vm.ts` actually reaches. Handed to the view
 * model through the mocked `cadre-phone` module, so it arrives exactly as a real
 * node would.
 */
export class FakeNode {
	isRunning = true;
	peerId: { toString(): string } | undefined = { toString: () => 'peer-abc' };
	strands = new Map<string, { status: string }>();

	/** Handlers registered via `on`, per event. `off` deletes by identity. */
	readonly bound = new Map<string, Set<unknown>>();

	/** What `decodeInvite` hands back when it does not throw. */
	invite: unknown = { partyId: 'party-x', ownerAddrs: [], createdAt: 0 };
	decodeInviteError: Error | null = null;
	applySeedResult: unknown = { success: true, peersAdded: 2, ownerDialsAttempted: 0, ownerDialsFailed: 0 };

	readonly decodedInvites: string[] = [];
	readonly decodedSeeds: string[] = [];
	readonly trusted: { keys: string[]; source: string }[] = [];
	readonly applied: { seed: unknown; options: { trustPolicy?: SeedTrustPolicy } | undefined }[] = [];

	getStrands(): Map<string, { status: string }> {
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

	decodeInvite(encoded: string): unknown {
		calls.push('decodeInvite');
		this.decodedInvites.push(encoded);
		if (this.decodeInviteError) throw this.decodeInviteError;
		return this.invite;
	}

	decodeSeed(encoded: string): unknown {
		calls.push('decodeSeed');
		this.decodedSeeds.push(encoded);
		return sentinels.decodedSeed;
	}

	async trustOwnerKeys(keys: Iterable<string>, source: string): Promise<void> {
		calls.push('trustOwnerKeys');
		this.trusted.push({ keys: [...keys], source });
	}

	async applySeed(seed: unknown, options?: { trustPolicy?: SeedTrustPolicy }): Promise<unknown> {
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
	startOpts: [] as unknown[],
};

/** Back to a fresh, empty world — one fake node, nothing running, nothing recorded. */
export function reset(): void {
	calls.length = 0;
	state.node = new FakeNode();
	state.phoneNode = null;
	state.startError = null;
	state.dialError = null;
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

async function createChatStrand(node: unknown, strandId: string): Promise<unknown> {
	calls.push('createChatStrand');
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
