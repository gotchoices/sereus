import { describe, it, expect, vi } from 'vitest';
import type { FoundStrandResult, StrandInstance, StrandRow } from '@serfab/cadre-core';
import { createChatStrand, createClosedChatStrand } from '../src/chat-strand.js';

/**
 * Regression guard: createChatStrand and createClosedChatStrand must FOUND their
 * strand, not merely attach it — i.e. go through `CadreNode.foundStrand`, which
 * publishes the control row and calls `addStrand(..., founder: true)` in one
 * resumable call.
 *
 * Two failure modes this catches. A caller that drops the founder flag leaves a
 * newly-created strand with no Header/Member/Owner rows (the genesis bootstrap
 * never fires). A caller that hand-rolls `publishStrand` + `addStrand` cannot be
 * resumed: killed between the two writes, every later attempt on the same strand
 * id dies on `UNIQUE constraint failed: Strand.Id`. `foundStrand` is what closes
 * both, so the guard is "this call site uses it".
 *
 * The founder-flag and idempotency semantics INSIDE `foundStrand` are pinned
 * against a real control database in
 * `packages/cadre-core/test/publish-strand.spec.ts`.
 */

function makeStubNode(memberPrivateKey: string | null = null) {
	const stubInstance: StrandInstance = {
		strandId: 'stub',
		status: 'active',
		connectedPeers: 0,
		lastActivity: new Date(0),
		latencyHint: 'interactive',
	};
	const stubRow = (strandId: string, type: 'o' | 'c'): StrandRow => ({
		Id: strandId,
		MemberPrivateKey: memberPrivateKey,
		Type: type,
		FounderOwnerKey: null,
	});
	return {
		foundStrand: vi
			.fn<(config: { strandId: string; type?: 'o' | 'c' }) => Promise<FoundStrandResult>>()
			.mockImplementation(async (config) => ({
				instance: stubInstance,
				strandRow: stubRow(config.strandId, config.type ?? 'o'),
				founded: true,
			})),
		addStrand: vi.fn<() => Promise<StrandInstance>>().mockResolvedValue(stubInstance),
		peerId: { toString: () => 'p' },
	};
}

describe('chat-strand caller: creation founds rather than attaches', () => {
	it('createChatStrand founds the open strand through foundStrand', async () => {
		const node = makeStubNode();
		await createChatStrand(node as never, 'open-strand-id');
		expect(node.foundStrand).toHaveBeenCalledWith(
			expect.objectContaining({ strandId: 'open-strand-id', type: 'o' }),
		);
		// Never the raw attach path: that would skip the control-row publish.
		expect(node.addStrand).not.toHaveBeenCalled();
	});

	it('createClosedChatStrand founds the closed strand with a minted member key', async () => {
		const node = makeStubNode('stored-member-key');
		await createClosedChatStrand(node as never, 'closed-strand-id');
		expect(node.foundStrand).toHaveBeenCalledWith(
			expect.objectContaining({
				strandId: 'closed-strand-id',
				type: 'c',
				memberPrivateKey: expect.any(String),
			}),
		);
		expect(node.addStrand).not.toHaveBeenCalled();
	});

	it('createClosedChatStrand returns the RESOLVED member key, not the minted one', async () => {
		// A resumed founding adopts the stored key; handing back the freshly minted
		// one would mint invitations that cannot read the strand.
		const node = makeStubNode('stored-member-key');
		const { memberPrivateKey } = await createClosedChatStrand(node as never, 'closed-strand-id');
		const minted = node.foundStrand.mock.calls[0]![0] as { memberPrivateKey?: string };
		expect(memberPrivateKey).toBe('stored-member-key');
		expect(memberPrivateKey).not.toBe(minted.memberPrivateKey);
	});

	it('createClosedChatStrand rejects a founded row carrying no member key', async () => {
		const node = makeStubNode(null);
		await expect(createClosedChatStrand(node as never, 'closed-strand-id')).rejects.toThrow(
			/without a MemberPrivateKey/i,
		);
	});

	it('joinChatStrand attaches without founding', async () => {
		const { joinChatStrand } = await import('../src/chat-strand.js');
		const node = makeStubNode();
		const strandRow = { Id: 'join-id', MemberPrivateKey: null, Type: 'o' as const, FounderOwnerKey: null };
		await joinChatStrand(node as never, strandRow);
		expect(node.addStrand).toHaveBeenCalledWith(
			expect.not.objectContaining({ founder: true }),
		);
		expect(node.foundStrand).not.toHaveBeenCalled();
	});
});
