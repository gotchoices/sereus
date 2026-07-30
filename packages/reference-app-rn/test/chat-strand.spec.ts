import { describe, it, expect, vi } from 'vitest';
import type { StrandInstance } from '@serfab/cadre-core';
import { createChatStrand, createClosedChatStrand } from '../src/chat-strand.js';

/**
 * Regression guard: createChatStrand and createClosedChatStrand must pass
 * `founder: true` to `addStrand`. This catches callers silently dropping the
 * flag, which would leave newly-created strands with no Header/Member/Owner
 * rows (the genesis bootstrap never fires).
 */

function makeStubNode() {
	const stubInstance: StrandInstance = {
		strandId: 'stub',
		status: 'active',
		mode: 'networked',
		connectedPeers: 0,
		lastActivity: new Date(0),
		latencyHint: 'interactive',
	};
	return {
		publishStrand: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		addStrand: vi.fn<() => Promise<StrandInstance>>().mockResolvedValue(stubInstance),
		peerId: { toString: () => 'p' },
	};
}

describe('chat-strand caller: founder flag is passed on create', () => {
	it('createChatStrand passes founder:true to addStrand', async () => {
		const node = makeStubNode();
		await createChatStrand(node as never, 'open-strand-id');
		expect(node.addStrand).toHaveBeenCalledWith(
			expect.objectContaining({ founder: true }),
		);
	});

	it('createClosedChatStrand passes founder:true to addStrand', async () => {
		const node = makeStubNode();
		await createClosedChatStrand(node as never, 'closed-strand-id');
		expect(node.addStrand).toHaveBeenCalledWith(
			expect.objectContaining({ founder: true }),
		);
	});

	it('joinChatStrand does NOT pass founder:true', async () => {
		const { joinChatStrand } = await import('../src/chat-strand.js');
		const node = makeStubNode();
		const strandRow = { Id: 'join-id', MemberPrivateKey: null, Type: 'o' as const };
		await joinChatStrand(node as never, strandRow);
		expect(node.addStrand).toHaveBeenCalledWith(
			expect.not.objectContaining({ founder: true }),
		);
	});
});
