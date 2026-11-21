/**
 * The strand helpers' decisions — what counts as progress, what counts as transient — over a
 * stand-in node. Running them against a real slow first sync or a real lone restart is
 * integration-test territory; what is this module's own is which errors they wait out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromiseShortfallError } from '@optimystic/db-core';
import { StrandAwaitingFirstSyncError, type CadreNode, type StrandConfig, type StrandInstance } from '../../src/index.js';
import { attachStrandWhenWritable, retryAfterRestart } from '../../src/edge-node/strands.js';

const CONFIG = { strandRow: { Id: 'strand-1' } } as StrandConfig;
const INSTANCE = { strandId: 'strand-1', status: 'active' } as StrandInstance;

function stubNode(addStrand: () => Promise<StrandInstance>) {
	const whenStrandWritable = vi.fn(async () => INSTANCE);
	const node = { addStrand: vi.fn(addStrand), whenStrandWritable } as unknown as CadreNode;
	return { node, whenStrandWritable };
}

beforeEach(() => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('attachStrandWhenWritable', () => {
	it('returns the strand addStrand attached', async () => {
		const { node, whenStrandWritable } = stubNode(async () => INSTANCE);

		await expect(attachStrandWhenWritable(node, CONFIG)).resolves.toBe(INSTANCE);
		expect(whenStrandWritable).not.toHaveBeenCalled();
	});

	it('treats a first sync that outlasted its budget as progress, and waits for writable', async () => {
		const { node, whenStrandWritable } = stubNode(async () => {
			throw new StrandAwaitingFirstSyncError('strand-1', 120_000);
		});

		await expect(attachStrandWhenWritable(node, CONFIG, { patienceMs: 5_000 })).resolves.toBe(INSTANCE);
		expect(whenStrandWritable).toHaveBeenCalledWith('strand-1', { timeoutMs: 5_000 });
	});

	it('passes any other failure straight through', async () => {
		const { node, whenStrandWritable } = stubNode(async () => {
			throw new Error('sApp refused');
		});

		await expect(attachStrandWhenWritable(node, CONFIG)).rejects.toThrow('sApp refused');
		expect(whenStrandWritable).not.toHaveBeenCalled();
	});
});

describe('retryAfterRestart', () => {
	/**
	 * A lone node's cohort not having reconnected yet: the coordinator's real shortfall class, with
	 * nobody having voted no. Claimed by TYPE, so the fixture has to be the class — a plain `Error`
	 * carrying the same sentence is no longer retried.
	 */
	const superMajority = (rejections = 0) => new PromiseShortfallError({
		approvals: 1, rejections, peerCount: 2, needed: 2, silentPeers: ['12D3KooWSilentMember'],
	});

	it('retries the transient super-majority failure until the write lands', async () => {
		const write = vi.fn()
			.mockRejectedValueOnce(superMajority())
			.mockRejectedValueOnce(superMajority())
			.mockResolvedValue('row');

		await expect(retryAfterRestart(write, { delayMs: 1 })).resolves.toBe('row');
		expect(write).toHaveBeenCalledTimes(3);
	});

	/**
	 * Every shortfall an app meets through SQL arrives under a wrapper (the optimystic plugin's
	 * rewrap, Quereus' own), and the first writes after a lone restart — what this helper exists for
	 * — are exactly those. The wrapper below interpolates the inner message as the real ones do, so
	 * what this pins is that the claim no longer DEPENDS on that: the typed link is found at depth.
	 */
	it('retries a shortfall delivered under a wrapper', async () => {
		const wrapped = () => new Error('Query failed: Failed to get super-majority', { cause: superMajority() });
		const write = vi.fn()
			.mockRejectedValueOnce(wrapped())
			.mockResolvedValue('row');

		await expect(retryAfterRestart(write, { delayMs: 1 })).resolves.toBe('row');
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('gives up after the last attempt, with that attempt\'s error', async () => {
		const write = vi.fn().mockRejectedValue(superMajority());

		await expect(retryAfterRestart(write, { attempts: 2, delayMs: 1 })).rejects.toThrow(/super-majority/);
		expect(write).toHaveBeenCalledTimes(2);
	});

	/**
	 * A member voted no, so no backoff changes the answer — the same line the control-write policy
	 * draws, and the two must not differ on it.
	 */
	it('does not retry a shortfall carrying a rejection', async () => {
		const write = vi.fn().mockRejectedValue(superMajority(1));

		await expect(retryAfterRestart(write, { delayMs: 1 })).rejects.toThrow(/super-majority/);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it('does not retry any other error', async () => {
		const write = vi.fn().mockRejectedValue(new Error('constraint failed'));

		await expect(retryAfterRestart(write, { delayMs: 1 })).rejects.toThrow('constraint failed');
		expect(write).toHaveBeenCalledTimes(1);
	});

	/**
	 * A throw that is not an `Error` can carry no typed link, and this helper sleeps 3 s between five
	 * attempts — claiming one on its text would be 12 s spent before the identical failure.
	 */
	it('does not retry a non-Error throw whose text would have matched', async () => {
		const write = vi.fn().mockRejectedValue('Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)');

		await expect(retryAfterRestart(write, { delayMs: 1 })).rejects.toBe(
			'Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)');
		expect(write).toHaveBeenCalledTimes(1);
	});
});
