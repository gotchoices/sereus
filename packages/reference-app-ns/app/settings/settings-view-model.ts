/**
 * settings-view-model.ts — page view model for the Settings screen.
 *
 * Holds page-local UI state (input fields, status modal) and delegates all node
 * lifecycle to the shared `CadreViewModel` singleton (exposed as `cadre`, bound
 * from the XML as `{{ cadre.* }}`). Mirrors reference-app-rn's `app/settings.tsx`.
 */

import { Observable } from '@nativescript/core';
import { getCadreVm, type CadreViewModel } from '../../src/cadre-vm';

/** RFC-4122-ish v4 UUID (Math.random — good enough for the demo, matches RN). */
function uuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

export class SettingsViewModel extends Observable {
	/** Shared cadre VM — bound as `{{ cadre.* }}`. */
	readonly cadre: CadreViewModel;

	private _partyId = '';
	private _bootstrapAddr = '';
	private _seedInput = '';
	private _enrollInviteInput = '';
	private _peerAddr = '';
	private _modalVisible = false;
	private _modalTitle = '';
	private _modalMessage = '';

	constructor() {
		super();
		this.cadre = getCadreVm();
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

	/**
	 * Optional enrollment invite pasted alongside the seed. Deliberately NOT part
	 * of `canApplySeed` — the seed alone gates the button, matching RN's
	 * `disabled={!seedInput.trim()}`.
	 */
	get enrollInviteInput(): string {
		return this._enrollInviteInput;
	}
	set enrollInviteInput(value: string) {
		if (value === this._enrollInviteInput) return;
		this._enrollInviteInput = value;
		this.notifyPropertyChange('enrollInviteInput', value);
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
		const addrs = this._bootstrapAddr.trim() ? [this._bootstrapAddr.trim()] : [];
		await this.cadre.start({ partyId, bootstrapAddrs: addrs });
		if (this.cadre.status === 'error') {
			this.showAlert('Connection failed', this.cadre.error);
		}
	}

	async onDisconnect(): Promise<void> {
		await this.cadre.stop();
	}

	/**
	 * Apply a cold-start seed, optionally anchoring trust on the owner keys carried
	 * by a pasted `CadreInvite`. A cold node has nothing in its trusted-owner
	 * anchor, so the default `anchoredTrustPolicy` rejects a seed signed by another
	 * cadre; pinning the invite's keys lets that first seed through. A blank or
	 * older invite yields no pins — the modal says so rather than implying a pin
	 * succeeded. Both fields are cleared on success only, so a mistyped seed does
	 * not cost the user the pasted invite.
	 */
	async onApplySeed(): Promise<void> {
		const seed = this._seedInput.trim();
		if (!seed) return;
		try {
			const enrollInvite = this._enrollInviteInput.trim();
			const pins = enrollInvite ? this.cadre.ownerKeysFromInvite(enrollInvite) : undefined;
			await this.cadre.applySeed(seed, pins);
			this.seedInput = '';
			this.enrollInviteInput = '';
			this.showAlert(
				'Seed applied',
				pins?.length
					? `Pinned ${pins.length} owner key(s); peer cache updated`
					: 'Peer cache updated (no owner keys pinned)',
			);
		} catch (err) {
			this.showAlert('Seed failed', String(err));
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
