/**
 * cadre-vm.ts — NativeScript view model for CadreNode lifecycle.
 *
 * Replaces reference-app-rn's `use-cadre.ts` + `cadre-context.tsx`: an
 * `Observable` wrapping the singleton phone node (`cadre-phone.ts`) so both the
 * Chat and Settings screens share one source of truth for connection status,
 * peer id, and strands. Exposed as a module-level singleton via `getCadreVm()`,
 * mirroring RN's `cadre-context` (one node, one VM, shared across screens).
 */

import { Observable } from '@nativescript/core';
import { pinnedKeyTrustPolicy } from '@serfab/cadre-core';
import type { CadreNode, StrandInstance, CadreNodeEvents } from '@serfab/cadre-core';
import {
	startPhoneNode,
	stopPhoneNode,
	getPhoneNode,
	dialPeer as dialPeerImpl,
	type PhoneNodeOptions,
} from './cadre-phone';
import { createChatStrand } from './chat-strand';

export type CadreStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Display shape for the Settings "Strands" repeater. */
export interface StrandItem {
	id: string;
	title: string;
	status: string;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class CadreViewModel extends Observable {
	private _status: CadreStatus = 'idle';
	private _node: CadreNode | null = null;
	private _peerId = '';
	private _error = '';
	private _strands = new Map<string, StrandInstance>();

	// Stored event handlers so they can be detached on stop.
	private readonly onStrandStarted = (): void => this.refreshStrands();
	private readonly onStrandStopped = (): void => this.refreshStrands();
	private readonly onStrandError = ({ strandId, error }: CadreNodeEvents['strand:error']): void => {
		console.warn(`[cadre-vm] strand ${strandId} error:`, error);
		this.refreshStrands();
	};

	constructor() {
		super();
		// Adopt an already-running node (e.g. after a screen rebuild).
		const existing = getPhoneNode();
		if (existing?.isRunning) {
			this._node = existing;
			this._status = 'connected';
			this._peerId = existing.peerId?.toString() ?? '';
			this._strands = new Map(existing.getStrands());
			this.bindEvents(existing);
		}
	}

	// ── Raw observable props ────────────────────────────────────────────────

	get status(): CadreStatus {
		return this._status;
	}

	get peerId(): string {
		return this._peerId;
	}

	get error(): string {
		return this._error;
	}

	// ── Derived display props (notified alongside their sources) ─────────────

	get connected(): boolean {
		return this._status === 'connected';
	}

	get connecting(): boolean {
		return this._status === 'connecting';
	}

	/** `isEnabled` for the Connect button — blocked only while a dial is in flight. */
	get notConnecting(): boolean {
		return this._status !== 'connecting';
	}

	get connectedVisibility(): 'visible' | 'collapse' {
		return this.connected ? 'visible' : 'collapse';
	}

	get disconnectedVisibility(): 'visible' | 'collapse' {
		return this.connected ? 'collapse' : 'visible';
	}

	get peerIdDisplay(): string {
		return this._peerId || '—';
	}

	get strandCount(): number {
		return this._strands.size;
	}

	get strandSummary(): string {
		return `${this._strands.size} strand(s)`;
	}

	get strandItems(): StrandItem[] {
		return [...this._strands.entries()].map(([id, s]) => ({
			id,
			title: id.slice(0, 8),
			status: s.status,
		}));
	}

	// ── State mutators (single point that fans notifications out) ────────────

	private setStatus(status: CadreStatus): void {
		if (status === this._status) return;
		this._status = status;
		this.notifyPropertyChange('status', status);
		this.notifyPropertyChange('connected', this.connected);
		this.notifyPropertyChange('connecting', this.connecting);
		this.notifyPropertyChange('notConnecting', this.notConnecting);
		this.notifyPropertyChange('connectedVisibility', this.connectedVisibility);
		this.notifyPropertyChange('disconnectedVisibility', this.disconnectedVisibility);
	}

	private setPeerId(peerId: string): void {
		if (peerId === this._peerId) return;
		this._peerId = peerId;
		this.notifyPropertyChange('peerId', peerId);
		this.notifyPropertyChange('peerIdDisplay', this.peerIdDisplay);
	}

	private setError(error: string): void {
		if (error === this._error) return;
		this._error = error;
		this.notifyPropertyChange('error', error);
	}

	private setStrands(strands: Map<string, StrandInstance>): void {
		this._strands = strands;
		this.notifyPropertyChange('strandCount', this.strandCount);
		this.notifyPropertyChange('strandSummary', this.strandSummary);
		this.notifyPropertyChange('strandItems', this.strandItems);
	}

	// ── Event wiring ────────────────────────────────────────────────────────

	private bindEvents(node: CadreNode): void {
		node.on('strand:started', this.onStrandStarted);
		node.on('strand:stopped', this.onStrandStopped);
		node.on('strand:error', this.onStrandError);
	}

	private unbindEvents(node: CadreNode): void {
		node.off('strand:started', this.onStrandStarted);
		node.off('strand:stopped', this.onStrandStopped);
		node.off('strand:error', this.onStrandError);
	}

	private refreshStrands(): void {
		if (this._node?.isRunning) {
			this.setStrands(new Map(this._node.getStrands()));
		}
	}

	// ── Accessors for the Chat VM ───────────────────────────────────────────

	/** First active strand, or null — the Chat screen attaches to this one. */
	getFirstStrand(): StrandInstance | null {
		return this._strands.values().next().value ?? null;
	}

	getPeerId(): string | null {
		return this._peerId || null;
	}

	// ── Actions ─────────────────────────────────────────────────────────────

	/**
	 * Start (or adopt) the phone node. Sets status to `error` on failure rather
	 * than throwing, matching the RN hook — callers read `status`/`error`.
	 */
	async start(opts: PhoneNodeOptions): Promise<void> {
		try {
			this.setStatus('connecting');
			this.setError('');
			const node = await startPhoneNode(opts);
			this._node = node;
			this.bindEvents(node);
			this.setPeerId(node.peerId?.toString() ?? '');
			this.setStrands(new Map(node.getStrands()));
			this.setStatus('connected');
		} catch (err) {
			console.error('[cadre-vm] start failed:', err instanceof Error ? err.stack : err);
			this.setError(errMessage(err));
			this.setStatus('error');
		}
	}

	async stop(): Promise<void> {
		if (this._node) {
			this.unbindEvents(this._node);
		}
		await stopPhoneNode();
		this._node = null;
		this.setPeerId('');
		this.setStrands(new Map());
		this.setError('');
		this.setStatus('idle');
	}

	/**
	 * Decode a pasted base64url `CadreInvite` and return the owner keys it pins
	 * (empty when an older invite carries none). Guard order matches `applySeed`:
	 * 'Node not started' throws before the node is touched.
	 *
	 * `CadreNode.decodeInvite` is a raw base64url → `JSON.parse` → cast with no
	 * shape check, so a typo'd paste would otherwise surface as a bare
	 * `SyntaxError: Unexpected token …`. Rewrap it with app-level copy naming what
	 * was expected; the original rides along as `cause`.
	 *
	 * NOTE: a hand-crafted invite whose `ownerKeys` is a non-array (e.g. a number)
	 * yields a falsy `.length`, so no pin is attempted and the seed is then
	 * rejected by the default anchored policy — safe, but the error names the
	 * anchor rather than the bad invite. If that ever confuses a real user, the fix
	 * is shape validation inside `CadreNode.decodeInvite` (one site, both apps),
	 * not a second guard here.
	 */
	ownerKeysFromInvite(encodedInvite: string): string[] {
		const node = this._node;
		if (!node) throw new Error('Node not started');
		try {
			return node.decodeInvite(encodedInvite).ownerKeys ?? [];
		} catch (err) {
			throw new Error(
				'Enrollment invite could not be read (expected a base64url CadreInvite)',
				{ cause: err },
			);
		}
	}

	/**
	 * Decode + apply a base64url seed, optionally pinning owner keys taken from a
	 * pasted `CadreInvite`; throws if the node rejects it.
	 */
	async applySeed(encoded: string, pinnedOwnerKeys?: string[]): Promise<void> {
		const node = this._node;
		if (!node) throw new Error('Node not started');
		const seed = node.decodeSeed(encoded);
		const trustPolicy = pinnedOwnerKeys?.length ? pinnedKeyTrustPolicy(pinnedOwnerKeys) : undefined;
		if (pinnedOwnerKeys?.length) {
			// Enrollment seam: the invite's owner keys are out-of-band trust — anchor
			// them in the node-local trusted-owner store BEFORE the seed is applied,
			// so the anchor already holds them when seed trust consults it. The
			// ordering is load-bearing; do not fold these two calls together.
			//
			// The pin STICKS even when the seed that motivated it is then rejected:
			// pasting the invite is itself the out-of-band trust act, while the seed
			// is a separate artifact that may be stale, for another party, or
			// corrupt. Rolling the anchor back on a seed failure would make the user
			// re-paste the invite on every retry.
			await node.trustOwnerKeys(pinnedOwnerKeys, 'invite');
		}
		const result = await node.applySeed(seed, trustPolicy ? { trustPolicy } : undefined);
		if (!result.success) {
			throw new Error(result.error ?? 'Seed application failed');
		}
	}

	async dialPeer(addr: string): Promise<void> {
		await dialPeerImpl(addr);
	}

	async createStrand(strandId: string): Promise<StrandInstance> {
		const node = this._node;
		if (!node) throw new Error('Node not started');
		const instance = await createChatStrand(node, strandId);
		this.refreshStrands();
		return instance;
	}
}

// ── Singleton ────────────────────────────────────────────────────────────────

let vm: CadreViewModel | null = null;

/** Shared CadreViewModel — one per app, mirroring RN's `cadre-context`. */
export function getCadreVm(): CadreViewModel {
	if (!vm) {
		vm = new CadreViewModel();
	}
	return vm;
}
