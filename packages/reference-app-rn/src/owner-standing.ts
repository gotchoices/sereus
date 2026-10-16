/**
 * owner-standing.ts — whether this app may act as an owner of its cadre, for the Settings
 * sections that offer owner-only actions (removing machines, renting a node, adding and removing
 * owner keys).
 */

import { useEffect, useState } from 'react';
import { useCadre } from './cadre-context';

/** Whether this app is an owner of the cadre: `checking` until read, `unreadable` when the read failed. */
export type Standing = 'checking' | 'owner' | 'member' | 'unreadable';

/**
 * What a member, and an app whose standing could not be read, sees in place of the owner's
 * controls; `can` is the action in the infinitive ("remove machines", "rent a node").
 */
export function standingLine(standing: 'member' | 'unreadable', can: string): string {
	return standing === 'member'
		? `Only an owner of this cadre can ${can}. This app is a member.`
		: `Could not check whether this app is an owner of this cadre, so it cannot ${can} from here until the check is read again.`;
}

/**
 * This app's standing, read again whenever a join or a stop replaces the node, when the key it
 * signs with changes (an owner key imported under Owner keys), and on each `refreshKey` change.
 */
export function useOwnerStanding(refreshKey: string | number = 0): Standing {
	const cadre = useCadre();
	const [standing, setStanding] = useState<Standing>('checking');
	useEffect(() => {
		let stale = false;
		cadre.isOwnerDevice().then(
			(owner) => {
				if (!stale) setStanding(owner ? 'owner' : 'member');
			},
			(err: unknown) => {
				console.warn('[settings] could not read this cadre\'s owner keys:', err);
				if (!stale) setStanding('unreadable');
			},
		);
		return () => {
			stale = true;
		};
	}, [cadre.node, cadre.ownerPublicKey, refreshKey]);
	return standing;
}
