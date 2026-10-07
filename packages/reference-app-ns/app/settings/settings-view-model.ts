/**
 * settings-view-model.ts — page view model for the Settings screen.
 *
 * Holds page-local UI state (input fields, status modal) and delegates all node
 * lifecycle to the shared `CadreViewModel` singleton (exposed as `cadre`, bound
 * from the XML as `{{ cadre.* }}`). Mirrors reference-app-rn's `app/settings.tsx`.
 */

import { Observable, type EventData, type PropertyChangeData } from '@nativescript/core';
import type { RedeemCadreInvitationResult } from '@serfab/cadre-core';
import { getCadreVm, type CadreViewModel } from '../../src/cadre-vm';
import { describeJoinFailure } from '../../src/join-failure';
import type { PhoneNodeOptions } from '../../src/start-options';

/** RFC-4122-ish v4 UUID (Math.random — good enough for the demo, matches RN). */
function uuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** The bootstrap field's comma-separated list, trimmed, blanks dropped. */
function splitAddrs(field: string): string[] {
	return field.split(',').map((addr) => addr.trim()).filter((addr) => addr.length > 0);
}

/** The "Joined cadre" modal body: who admitted this phone, and with what standing. */
function joinedCadreMessage(result: RedeemCadreInvitationResult): string {
	const member = result.peerId ?? 'a member';
	const standing = result.grantsOwner ? 'This device is now an owner.' : 'This device is a member, not an owner.';
	return `Admitted by ${member}. ${standing}`;
}

export class SettingsViewModel extends Observable {
	/** Shared cadre VM — bound as `{{ cadre.* }}`. */
	readonly cadre: CadreViewModel;

	private _partyId = '';
	private _bootstrapAddr = '';
	private _seedInput = '';
	private _cadreInvitationInput = '';
	private _peerAddr = '';
	private _modalVisible = false;
	private _modalTitle = '';
	private _modalMessage = '';

	constructor() {
		super();
		this.cadre = getCadreVm();
		this.prefillFromSavedStartOptions();
	}

	/**
	 * Show the options the node last started with. They are read once at launch, and
	 * this page can be built before that read resolves — then they are applied when it
	 * does, once, and only into fields the user has not typed into meanwhile.
	 */
	private prefillFromSavedStartOptions(): void {
		const saved = this.cadre.savedStartOptions;
		if (saved) {
			this.prefill(saved);
			return;
		}
		const onChange = (args: EventData): void => {
			if ((args as PropertyChangeData).propertyName !== 'savedStartOptions') return;
			this.cadre.off('propertyChange', onChange);
			const arrived = this.cadre.savedStartOptions;
			if (arrived) this.prefill(arrived);
		};
		this.cadre.on('propertyChange', onChange);
	}

	private prefill(saved: PhoneNodeOptions): void {
		if (!this._partyId) this.partyId = saved.partyId;
		if (!this._bootstrapAddr) this.bootstrapAddr = saved.bootstrapAddrs.join(', ');
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

	/** `isEnabled` for the Join cadre button — mirrors RN's `disabled={!cadreInvitationInput.trim()}`. */
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
		await this.cadre.start({ partyId, bootstrapAddrs: splitAddrs(this._bootstrapAddr) });
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
	 * Redeem a pasted cadre invitation. The field is cleared on success only: a
	 * failed join keeps the paste, so the retry the modal may suggest costs no
	 * re-paste. The failure modal speaks in plain words (`describeJoinFailure`),
	 * not the error's own text.
	 */
	async onJoinCadre(): Promise<void> {
		const encoded = this._cadreInvitationInput.trim();
		if (!encoded) return;
		try {
			const result = await this.cadre.joinCadre(encoded);
			this.cadreInvitationInput = '';
			this.showAlert('Joined cadre', joinedCadreMessage(result));
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
