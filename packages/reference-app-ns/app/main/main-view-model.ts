import { Observable } from '@nativescript/core';

import { runSoloSmoke } from '../../src/solo-smoke';

/**
 * Drives the solo runtime smoke from the UI. This is also the static import
 * edge that pulls the cadre / db-p2p / Quereus graph into the bundle, so the
 * `test:bundle` (ns prepare) gate exercises whole-graph resolution.
 */
export class MainViewModel extends Observable {
	private _status = 'Idle — tap to boot a solo CadreNode and echo a message.';
	private _busy = false;

	get status(): string {
		return this._status;
	}
	set status(value: string) {
		if (value !== this._status) {
			this._status = value;
			this.notifyPropertyChange('status', value);
		}
	}

	get busy(): boolean {
		return this._busy;
	}
	set busy(value: boolean) {
		if (value !== this._busy) {
			this._busy = value;
			this.notifyPropertyChange('busy', value);
		}
	}

	async runSmoke(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.status = 'Booting solo CadreNode…';
		try {
			const result = await runSoloSmoke('hello');
			this.status = result.echoed
				? `✓ Local echo OK — ${result.messages.length} message(s).\nPeer: ${result.peerId}\nStrand: ${result.strandId}`
				: `✗ No echo — query returned ${result.messages.length} message(s).`;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.status = `✗ Solo smoke failed: ${message}`;
			console.error('[reference-app-ns] solo smoke failed', err);
		} finally {
			this.busy = false;
		}
	}
}
