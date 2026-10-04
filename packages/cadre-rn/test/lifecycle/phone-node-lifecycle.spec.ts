/**
 * `phoneNodeLifecycle` — the runner's node hooks over a `PhoneNode`. The cold start is the
 * rule that matters: a node the user stopped must stay stopped when the app returns to the
 * foreground.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CadreNode } from '@serfab/cadre-core';
import { phoneNodeLifecycle } from '../../src/lifecycle/index.js';
import type { PhoneNode, SavedStart } from '../../src/phone-node/index.js';

const OPTIONS = { partyId: 'party-1', bootstrapAddrs: [], relayAddrs: [] };

function stubPhone(saved: SavedStart | undefined) {
	const start = vi.fn(async () => ({}) as CadreNode);
	const phone = { loadSavedStart: vi.fn(async () => saved), start } as unknown as PhoneNode;
	return { phone, start };
}

describe('phoneNodeLifecycle', () => {
	it('cold-starts from the saved start while autoStart is set', async () => {
		const { phone, start } = stubPhone({ options: OPTIONS, autoStart: true });

		await phoneNodeLifecycle(phone).ensureNode?.();

		expect(start).toHaveBeenCalledWith(OPTIONS);
	});

	it('leaves a node the user stopped stopped, and a phone never started alone', async () => {
		const stopped = stubPhone({ options: OPTIONS, autoStart: false });
		const never = stubPhone(undefined);

		await phoneNodeLifecycle(stopped.phone).ensureNode?.();
		await phoneNodeLifecycle(never.phone).ensureNode?.();

		expect(stopped.start).not.toHaveBeenCalled();
		expect(never.start).not.toHaveBeenCalled();
	});
});
