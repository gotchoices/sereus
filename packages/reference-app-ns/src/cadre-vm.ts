/**
 * cadre-vm.ts — NativeScript view model for the phone's edge node.
 *
 * Replaces reference-app-rn's `use-cadre.ts` + `cadre-context.tsx`: an
 * `Observable` over the phone's one edge node (`cadre-phone.ts`) so both the
 * Chat and Settings screens share one source of truth for connection status,
 * peer id, and strands. Status follows the edge node's own reports
 * (`EdgeNode.onStatus`), so a start, stop or join is shown whoever began it.
 * Exposed as a module-level singleton via `getCadreVm()`, mirroring RN's
 * `cadre-context` (one node, one VM, shared across screens).
 */

import { Observable, type EventData } from '@nativescript/core';
import { decodeCadreInvitation } from '@serfab/cadre-core';
import type {
	CadreInvitation,
	CadreNode,
	CadreNodeEvents,
	ControlNetworkSeed,
	StrandCommitHeld,
	StrandInstance,
} from '@serfab/cadre-core';
import type { EdgeNodeOptions, EdgeNodeStatus, JoinCadreResult, SavedStart } from '@serfab/cadre-core/edge-node';
import { edge, dialPeer as dialPeerImpl } from './cadre-phone';
import { createChatStrand } from './chat-strand';

export type CadreStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Display shape for the Settings "Strands" repeater. */
export interface StrandItem {
	id: string;
	title: string;
	status: string;
}

/** The node's `strand:commit-held`, re-sent by {@link CadreViewModel} for the chat screen's marks. */
export interface CommitHeldEventData extends EventData, StrandCommitHeld {}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class CadreViewModel extends Observable {
	/** Event name of {@link CommitHeldEventData}. */
	static readonly commitHeldEvent = 'commitHeld';

	private _status: CadreStatus = 'idle';
	private _peerId = '';
	private _error = '';
	private _strands = new Map<string, StrandInstance>();
	private _savedStartOptions: EdgeNodeOptions | null = null;
	private _savedStartFromLaunch = false;

	constructor() {
		super();
		this.subscribeToNodeEvents();
		// The status now, then every change: a view model built while the node runs adopts it.
		this.applyStatus(edge.status);
		edge.onStatus((status) => this.applyStatus(status));
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
	 * The options the node last started with, for the Settings form to fill from: read
	 * at launch ({@link restore}), then the running start's each time the node comes up,
	 * so after a join they name the joined party, and read again after a removal
	 * ({@link refillAfterRemoval}). Null until the launch read resolves, and when nothing
	 * is saved.
	 */
	get savedStartOptions(): EdgeNodeOptions | null {
		return this._savedStartOptions;
	}

	/**
	 * Whether {@link savedStartOptions} came from the launch read, which can resolve after
	 * the user began typing and so fills only blank fields; every later value replaces the form.
	 */
	get savedStartFromLaunch(): boolean {
		return this._savedStartFromLaunch;
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

	private setSavedStartOptions(options: EdgeNodeOptions | null, fromLaunch = false): void {
		this._savedStartOptions = options;
		this._savedStartFromLaunch = fromLaunch;
		this.notifyPropertyChange('savedStartOptions', options);
	}

	private setStrands(strands: Map<string, StrandInstance>): void {
		this._strands = strands;
		this.notifyPropertyChange('strandCount', this.strandCount);
		this.notifyPropertyChange('strandSummary', this.strandSummary);
		this.notifyPropertyChange('strandItems', this.strandItems);
	}

	// ── Following the edge node ─────────────────────────────────────────────

	/** Registered once, on the edge node, which applies them to every node a start or join builds. */
	private subscribeToNodeEvents(): void {
		const refresh = (): void => this.refreshStrands();
		edge.on('strand:started', refresh);
		edge.on('strand:stopped', refresh);
		// A `'syncing'` joiner became writable — its instance gained a database in place.
		edge.on('strand:writable', refresh);
		edge.on('strand:error', ({ strandId, error }: CadreNodeEvents['strand:error']) => {
			console.warn(`[cadre-vm] strand ${strandId} error:`, error);
			refresh();
		});
		edge.on('strand:commit-held', (held: CadreNodeEvents['strand:commit-held']) => {
			this.notify<CommitHeldEventData>({ eventName: CadreViewModel.commitHeldEvent, object: this, ...held });
		});
	}

	/**
	 * Show what the edge node reports. `stopped`, `removed` and `failed` drop the strand map:
	 * a stop closes each strand's database, so a screen still holding an instance must not
	 * read through it. `starting` and `joining` need not, since the edge node reports
	 * `stopped` before every build.
	 */
	private applyStatus(status: EdgeNodeStatus): void {
		switch (status.state) {
			case 'running':
				this.showRunning(status.node);
				return;
			case 'starting':
			case 'joining':
				this.setStatus('connecting');
				return;
			case 'stopped':
				this.showStopped('idle', '');
				return;
			case 'removed':
				this.showStopped('idle', `An owner removed this phone from cadre ${status.partyId}`);
				void this.refillAfterRemoval();
				return;
			case 'failed':
				this.showStopped('error', status.error.message);
				return;
		}
	}

	private showRunning(node: CadreNode): void {
		this.setPeerId(node.peerId?.toString() ?? '');
		this.setStrands(new Map(node.getStrands()));
		this.setError('');
		this.setStatus('connected');
		// After the status, so a listener reading `connected` sees the node up.
		if (edge.options) this.setSavedStartOptions(edge.options);
	}

	private showStopped(status: CadreStatus, error: string): void {
		this.setPeerId('');
		this.setStrands(new Map());
		this.setError(error);
		this.setStatus(status);
	}

	/**
	 * Acting on a removal, the edge node rewrote the saved start: it now names the cadre this
	 * phone founded and left, with auto-start off, or nothing. Read it again so the form offers
	 * that and not the removed party, which a Connect would start as founded, running owner
	 * genesis there; unreadable, the form is emptied for the same reason.
	 */
	private async refillAfterRemoval(): Promise<void> {
		try {
			const saved = await edge.loadSavedStart();
			this.setSavedStartOptions(saved?.options ?? null);
		} catch (err) {
			console.warn('[cadre-vm] could not read the saved start after this phone was removed:', err);
			this.setSavedStartOptions(null);
		}
	}

	/** `edge.node` is null as soon as a stop begins, so a late event from a node going down changes nothing. */
	private refreshStrands(): void {
		const node = edge.node;
		if (node?.isRunning) {
			this.setStrands(new Map(node.getStrands()));
		}
	}

	/** The running node, or a throw saying there is none — the guard every node action shares. */
	private runningNode(): CadreNode {
		const node = edge.node;
		if (!node) throw new Error('Node not started');
		return node;
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
		let saved: SavedStart | undefined;
		try {
			saved = await edge.loadSavedStart();
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
		this.setSavedStartOptions(saved.options, true);
		if (saved.autoStart && this._status === 'idle') await this.start(saved.options);
	}

	/**
	 * Start (or adopt) the phone node. Sets status to `error` on failure rather
	 * than throwing, matching the RN hook — callers read `status`/`error`. The
	 * edge node reports the start's progress itself (`applyStatus`).
	 */
	async start(opts: EdgeNodeOptions): Promise<void> {
		this.setError('');
		try {
			await edge.start(opts);
		} catch (err) {
			console.error('[cadre-vm] start failed:', err instanceof Error ? err.stack : err);
			this.showStopped('error', errMessage(err));
		}
	}

	/** Settings → Disconnect: also turns off the next launch's auto-start. */
	async stop(): Promise<void> {
		await edge.stop();
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
		const node = this.runningNode();
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
				'Cadre invitation could not be read (expected text starting with "sereus-invite:1.")',
				{ cause: err },
			);
		}
	}

	/**
	 * Join the cadre a pasted base64url invitation names: decode it, then hand it to
	 * the edge node, which moves this phone to that party, keeping its identity, and
	 * redeems the invitation at one of the members it lists, pinning its owner keys
	 * before dialing. That party starts as joined, so owner genesis never runs there:
	 * genesis before the party's control rows arrive would seat this phone as a second
	 * founder. A failed join starts the party this phone left again. The errors
	 * (`CadreInviteRejectedError`, `CadreInviteUnreachableError`,
	 * `CadreInviteReplyInvalidError`, `StrandsNeedOwnerJoinError`) pass through for the
	 * Settings screen to word.
	 */
	async joinCadre(encodedInvitation: string, relayAddrs: string[]): Promise<JoinCadreResult> {
		const invitation = this.decodeInvitationOrThrow(encodedInvitation);
		return edge.joinCadre(invitation, { relayAddrs });
	}

	async dialPeer(addr: string): Promise<void> {
		await dialPeerImpl(addr);
	}

	async createStrand(strandId: string): Promise<StrandInstance> {
		const node = this.runningNode();
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
