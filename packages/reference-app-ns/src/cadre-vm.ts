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
import { decodeCadreInvitation } from '@serfab/cadre-core';
import type {
	CadreInvitation,
	CadreNode,
	CadreNodeEvents,
	ControlNetworkSeed,
	RedeemCadreInvitationResult,
	StrandInstance,
} from '@serfab/cadre-core';
import {
	startPhoneNode,
	stopPhoneNode,
	getPhoneNode,
	loadSavedStartOptions,
	dialPeer as dialPeerImpl,
	type PhoneNodeOptions,
	type SavedStartOptions,
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
	private _savedStartOptions: PhoneNodeOptions | null = null;

	// Stored event handlers so they can be detached on stop.
	private readonly onStrandStarted = (): void => this.refreshStrands();
	private readonly onStrandStopped = (): void => this.refreshStrands();
	/** A `'syncing'` joiner became writable — its instance gained a database in place. */
	private readonly onStrandWritable = (): void => this.refreshStrands();
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

	/**
	 * The options the node last started with, read once at launch ({@link restore})
	 * for the Settings form to prefill from. Null until that read resolves, and when
	 * nothing is saved.
	 */
	get savedStartOptions(): PhoneNodeOptions | null {
		return this._savedStartOptions;
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

	private setSavedStartOptions(options: PhoneNodeOptions): void {
		this._savedStartOptions = options;
		this.notifyPropertyChange('savedStartOptions', options);
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
		node.on('strand:writable', this.onStrandWritable);
		node.on('strand:error', this.onStrandError);
	}

	private unbindEvents(node: CadreNode): void {
		node.off('strand:started', this.onStrandStarted);
		node.off('strand:stopped', this.onStrandStopped);
		node.off('strand:writable', this.onStrandWritable);
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
	 * Resume the last session at app launch. A session that ended connected (anything
	 * but Disconnect — an OS kill included) starts again with the options it last
	 * started with, through {@link start}, exactly as a Connect tap would; either way
	 * {@link savedStartOptions} is set for the Settings form. A Connect tap that beat
	 * this read owns the node and is not second-guessed.
	 */
	async restore(): Promise<void> {
		let saved: SavedStartOptions | undefined;
		try {
			saved = await loadSavedStartOptions();
		} catch (err) {
			// NOTE: fields stay blank, so a Connect now mints a new party id and, on
			// success, overwrites the unreadable record. Acceptable because the
			// party-scoped records live in the same database and propagate a read fault,
			// which fails that start before anything is saved.
			console.warn('[cadre-vm] could not read the saved start options:', err);
			this.setError(`Could not read the saved connection settings: ${errMessage(err)}`);
			return;
		}
		if (!saved) return;
		this.setSavedStartOptions(saved.options);
		if (saved.autoStart && this._status === 'idle') await this.start(saved.options);
	}

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
	 * `CadreNode.decodeSeed` is a raw base64url → `JSON.parse` → cast, so a typo'd
	 * paste would surface as a bare `SyntaxError: Unexpected token …`. The Settings
	 * modal renders `String(err)`, and it must name the field that was wrong, so the
	 * decode is rewrapped with the original as `cause`. Only the decode is wrapped —
	 * a rejection from `applySeed` itself already carries the node's own text.
	 */
	private decodeSeedOrThrow(node: CadreNode, encoded: string): ControlNetworkSeed {
		try {
			return node.decodeSeed(encoded);
		} catch (err) {
			throw new Error(
				'Cold-start seed could not be read (expected a base64url seed)',
				{ cause: err },
			);
		}
	}

	/**
	 * Decode + apply a base64url seed; throws if the node rejects it. The node
	 * accepts a seed only when its anchor already holds the signer's key: this node
	 * founded the cadre, or an invitation it redeemed pinned that owner
	 * ({@link joinCadre}).
	 */
	async applySeed(encoded: string): Promise<void> {
		const node = this._node;
		if (!node) throw new Error('Node not started');
		const seed = this.decodeSeedOrThrow(node, encoded);
		const result = await node.applySeed(seed);
		if (!result.success) {
			throw new Error(result.error ?? 'Seed application failed');
		}
	}

	/**
	 * The same rewrap as {@link decodeSeedOrThrow}, for the invitation paste:
	 * `decodeCadreInvitation` names what was wrong with the bundle, not which field
	 * it came from.
	 */
	private decodeInvitationOrThrow(encoded: string): CadreInvitation {
		try {
			return decodeCadreInvitation(encoded);
		} catch (err) {
			throw new Error(
				'Cadre invitation could not be read (expected a base64url cadre invitation)',
				{ cause: err },
			);
		}
	}

	/**
	 * Join the cadre a pasted base64url invitation names: decode it, then redeem it
	 * at one of the members it lists (`CadreNode.redeemCadreInvitation`, which pins
	 * the invitation's owner keys before dialing). Guard order matches
	 * {@link applySeed}: 'Node not started' throws before anything is decoded. The
	 * node's own errors (`CadreInviteRejectedError`, `CadreInviteUnreachableError`,
	 * `CadreInviteReplyInvalidError`) pass through for the Settings screen to word.
	 */
	async joinCadre(encodedInvitation: string): Promise<RedeemCadreInvitationResult> {
		const node = this._node;
		if (!node) throw new Error('Node not started');
		const invitation = this.decodeInvitationOrThrow(encodedInvitation);
		return node.redeemCadreInvitation(invitation);
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

/**
 * Shared CadreViewModel — one per app, mirroring RN's `cadre-context`. Creating it
 * resumes the last session ({@link CadreViewModel.restore}); the Chat page is the
 * default page and binds it on load, so that happens at app launch.
 */
export function getCadreVm(): CadreViewModel {
	if (!vm) {
		vm = new CadreViewModel();
		void vm.restore();
	}
	return vm;
}
