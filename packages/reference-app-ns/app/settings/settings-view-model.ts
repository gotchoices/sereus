/**
 * settings-view-model.ts — page view model for the Settings screen.
 *
 * Holds page-local UI state (input fields, status modal) and delegates all node
 * lifecycle to the shared `CadreViewModel` singleton (exposed as `cadre`, bound
 * from the XML as `{{ cadre.* }}`). Mirrors reference-app-rn's `app/settings.tsx`.
 */

import { Observable, type EventData, type PropertyChangeData } from '@nativescript/core';
import type { RedeemCadreInvitationResult } from '@serfab/cadre-core';
import type { EdgeNodeOptions, OwnerGenesisResult } from '@serfab/cadre-core/edge-node';
import { getCadreVm, type CadreViewModel } from '../../src/cadre-vm';
import { describeJoinFailure } from '../../src/join-failure';

/** RFC-4122-ish v4 UUID (Math.random — good enough for the demo, matches RN). */
function uuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** A comma-separated address field (Bootstrap, Relays) as a list, trimmed, blanks dropped. */
function splitAddrs(field: string): string[] {
	return field.split(',').map((addr) => addr.trim()).filter((addr) => addr.length > 0);
}

/**
 * The "Joined cadre" modal body: who admitted this phone, and its standing in the cadre, read
 * off the edge node's owner step after the join (`CadreViewModel.owner`), not the invitation:
 * an invitation grants no ownership, and the phone's own key may already be an owner there.
 */
function joinedCadreMessage(result: RedeemCadreInvitationResult, owner: OwnerGenesisResult | null): string {
	const member = result.peerId ?? 'a member';
	const standing = owner === 'enrolled' ? 'This device is now an owner.' : 'This device is a member, not an owner.';
	return `Admitted by ${member}. ${standing}`;
}

export class SettingsViewModel extends Observable {
	/** Shared cadre VM — bound as `{{ cadre.* }}`. */
	readonly cadre: CadreViewModel;

	private _partyId = '';
	private _bootstrapAddr = '';
	private _relayAddr = '';
	private _seedInput = '';
	private _cadreInvitationInput = '';
	private _peerAddr = '';
	private _modalVisible = false;
	private _modalTitle = '';
	private _modalMessage = '';

	constructor() {
		super();
		this.cadre = getCadreVm();
		this.followSavedStartOptions();
	}

	/**
	 * Show the options the node last started with. They are read once at launch, and
	 * this page can be built before that read resolves; then they fill only the fields
	 * the user has not typed into meanwhile. Every later value replaces the fields: each
	 * time the node comes up they are the running start's (after a join they must name
	 * the joined party, or the next Connect would leave it), and after a removal they are
	 * what the saved start now names, or nothing (never the removed party). Both arrive
	 * while the form was hidden, so neither overwrites an edit.
	 */
	private followSavedStartOptions(): void {
		this.prefill(this.cadre.savedStartOptions, false);
		this.cadre.on('propertyChange', (args: EventData) => {
			if ((args as PropertyChangeData).propertyName !== 'savedStartOptions') return;
			this.prefill(this.cadre.savedStartOptions, !this.cadre.savedStartFromLaunch);
		});
	}

	private prefill(saved: EdgeNodeOptions | null, replace: boolean): void {
		if (replace || !this._partyId) this.partyId = saved?.partyId ?? '';
		if (replace || !this._bootstrapAddr) this.bootstrapAddr = saved?.bootstrapAddrs.join(', ') ?? '';
		if (replace || !this._relayAddr) this.relayAddr = saved?.relayAddrs.join(', ') ?? '';
	}

	// ── Two-way bound inputs ────────────────────────────────────────────────

	get partyId(): string {
		return this._partyId;
	}
	set partyId(value: string) {
		if (value === this._partyId) return;
		this._partyId = value;
		this.notifyPropertyChange('partyId', value);
	}

	get bootstrapAddr(): string {
		return this._bootstrapAddr;
	}
	set bootstrapAddr(value: string) {
		if (value === this._bootstrapAddr) return;
		this._bootstrapAddr = value;
		this.notifyPropertyChange('bootstrapAddr', value);
	}

	/** Circuit-relay multiaddrs the phone reserves on, comma-separated: what makes it reachable, and so invitable. */
	get relayAddr(): string {
		return this._relayAddr;
	}
	set relayAddr(value: string) {
		if (value === this._relayAddr) return;
		this._relayAddr = value;
		this.notifyPropertyChange('relayAddr', value);
	}

	get seedInput(): string {
		return this._seedInput;
	}
	set seedInput(value: string) {
		if (value === this._seedInput) return;
		this._seedInput = value;
		this.notifyPropertyChange('seedInput', value);
		this.notifyPropertyChange('canApplySeed', this.canApplySeed);
	}

	get cadreInvitationInput(): string {
		return this._cadreInvitationInput;
	}
	set cadreInvitationInput(value: string) {
		if (value === this._cadreInvitationInput) return;
		this._cadreInvitationInput = value;
		this.notifyPropertyChange('cadreInvitationInput', value);
		this.notifyPropertyChange('canJoinCadre', this.canJoinCadre);
	}

	get peerAddr(): string {
		return this._peerAddr;
	}
	set peerAddr(value: string) {
		if (value === this._peerAddr) return;
		this._peerAddr = value;
		this.notifyPropertyChange('peerAddr', value);
		this.notifyPropertyChange('canDialPeer', this.canDialPeer);
	}

	/** `isEnabled` for the Apply Seed button — mirrors RN's `disabled={!seedInput.trim()}`. */
	get canApplySeed(): boolean {
		return this._seedInput.trim().length > 0;
	}

	/** `isEnabled` for the Join cadre button — mirrors RN's `disabled={!invitationText.trim()}`. */
	get canJoinCadre(): boolean {
		return this._cadreInvitationInput.trim().length > 0;
	}

	/** `isEnabled` for the Dial Peer button — mirrors RN's `disabled={!peerAddr.trim()}`. */
	get canDialPeer(): boolean {
		return this._peerAddr.trim().length > 0;
	}

	// ── Modal ───────────────────────────────────────────────────────────────

	get modalVisibility(): 'visible' | 'collapse' {
		return this._modalVisible ? 'visible' : 'collapse';
	}

	get modalTitle(): string {
		return this._modalTitle;
	}

	get modalMessage(): string {
		return this._modalMessage;
	}

	private showAlert(title: string, message: string): void {
		this._modalTitle = title;
		this._modalMessage = message;
		this._modalVisible = true;
		this.notifyPropertyChange('modalTitle', title);
		this.notifyPropertyChange('modalMessage', message);
		this.notifyPropertyChange('modalVisibility', this.modalVisibility);
	}

	onModalOk(): void {
		this._modalVisible = false;
		this.notifyPropertyChange('modalVisibility', this.modalVisibility);
	}

	// ── Actions ─────────────────────────────────────────────────────────────

	async onConnect(): Promise<void> {
		const partyId = this._partyId.trim() || uuid();
		this.partyId = partyId;
		// Comma-separated, so a remembered list of several round-trips.
		await this.cadre.start({
			partyId,
			bootstrapAddrs: splitAddrs(this._bootstrapAddr),
			relayAddrs: splitAddrs(this._relayAddr),
		});
		if (this.cadre.status === 'error') {
			this.showAlert('Connection failed', this.cadre.error);
		}
	}

	async onDisconnect(): Promise<void> {
		await this.cadre.stop();
	}

	/**
	 * Apply a cold-start seed. The node accepts it only when its anchor already
	 * holds the signer's key (the hint beside the field says so); the modal on
	 * refusal carries the node's own reason. The field is cleared on success only.
	 */
	async onApplySeed(): Promise<void> {
		const seed = this._seedInput.trim();
		if (!seed) return;
		try {
			await this.cadre.applySeed(seed);
			this.seedInput = '';
			this.showAlert('Seed applied', 'Peer cache updated');
		} catch (err) {
			this.showAlert('Seed failed', String(err));
		}
	}

	/**
	 * Join the cadre a pasted invitation names, reserving on the Relays field's relays
	 * there. The field is cleared on success only: a failed join keeps the paste, so
	 * the retry the modal may suggest costs no re-paste. The failure modal speaks in
	 * plain words (`describeJoinFailure`), not the error's own text.
	 */
	async onJoinCadre(): Promise<void> {
		const encoded = this._cadreInvitationInput.trim();
		if (!encoded) return;
		try {
			const result = await this.cadre.joinCadre(encoded, splitAddrs(this._relayAddr));
			this.cadreInvitationInput = '';
			this.showAlert('Joined cadre', joinedCadreMessage(result, this.cadre.owner));
		} catch (err) {
			this.showAlert('Join failed', describeJoinFailure(err));
		}
	}

	async onDialPeer(): Promise<void> {
		const addr = this._peerAddr.trim();
		if (!addr) return;
		try {
			await this.cadre.dialPeer(addr);
			this.peerAddr = '';
			this.showAlert('Peer connected', 'Dialed successfully');
		} catch (err) {
			this.showAlert('Dial failed', String(err));
		}
	}

	async onCreateStrand(): Promise<void> {
		try {
			const id = uuid();
			await this.cadre.createStrand(id);
			this.showAlert('Strand created', `ID: ${id.slice(0, 8)}…`);
		} catch (err) {
			this.showAlert('Strand creation failed', String(err));
		}
	}
}
