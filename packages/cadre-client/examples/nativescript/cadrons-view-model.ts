/**
 * Example (NativeScript): a person's cadrons as a view model for `cadrons-page.xml`. Copy and
 * adapt; it is not built or published. A cadre-client store is copied into an `Observable` from
 * `subscribe`; unsubscribe when the page goes (`navigatedFrom`), so the store stops reading.
 * `client` is `createCadreClient(...)` from `@serfab/cadre-client/sereus`.
 */
import { Observable } from '@nativescript/core';
import { cadreStore, cadronPresence, shortPeerId, type CadreMachine, type CadronPresence } from '@serfab/cadre-client';
import type { CadreClient } from '@serfab/cadre-client/sereus';

const DOT: Record<CadronPresence, string> = { connected: '#2c8a3f', recent: '#c98a00', quiet: '#888888', unknown: '#dddddd' };
const PRESENCE: Record<CadronPresence, string> = {
	connected: 'Connected', recent: 'Running', quiet: 'Not heard from lately', unknown: 'Not heard from yet',
};

interface CadronRow {
	peerId: string;
	title: string;
	subtitle: string;
	dot: string;
	star: string;
	thisDevice: boolean;
}

function row(m: CadreMachine): CadronRow {
	const presence = cadronPresence(m);
	return {
		peerId: m.peerId,
		title: m.thisDevice ? 'This device' : m.name || `Machine ${shortPeerId(m.peerId)}`,
		subtitle: m.thisDevice ? '' : [PRESENCE[presence], m.alwaysOn ? 'Always on' : null].filter(Boolean).join(' · '),
		dot: DOT[presence],
		star: m.preferred ? '★' : '☆',
		thisDevice: m.thisDevice,
	};
}

export class CadronsViewModel extends Observable {
	rows: CadronRow[] = [];
	message = 'Loading…';
	private readonly unsubscribe: () => void;

	constructor(private readonly client: CadreClient) {
		super();
		this.unsubscribe = cadreStore(client).subscribe(load => {
			if (load.state === 'ready') {
				this.set('rows', load.value.machines.map(row));
				this.set('message', '');
			} else {
				this.set('message', load.state === 'failed' ? load.error.message : 'Loading…');
			}
		});
	}

	/** Bound to a row's star: name this cadron first in invitations, or stop. */
	async toggleStar(peerId: string): Promise<void> {
		const prefs = await this.client.invitations.preferences();
		const preferred = prefs.preferred.includes(peerId) ? prefs.preferred.filter(id => id !== peerId) : [...prefs.preferred, peerId];
		await this.client.invitations.setPreferences({ preferred });
	}

	dispose(): void {
		this.unsubscribe();
	}
}
