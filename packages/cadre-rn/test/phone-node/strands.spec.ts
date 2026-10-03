/**
 * The strand helpers' decisions — what counts as progress, what counts as transient — over a
 * stand-in node. Running them against a real slow first sync or a real lone restart is
 * integration-test territory; what is the kit's own is which errors they wait out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrandAwaitingFirstSyncError, type CadreNode, type StrandConfig, type StrandInstance } from '@serfab/cadre-core';
import { attachStrandWhenWritable, retryAfterRestart } from '../../src/phone-node/strands.js';

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
	const superMajority = () => new Error('Failed to get super-majority: 0/1 approvals (needed 1, 0 rejections)');

	it('retries the transient super-majority failure until the write lands', async () => {
		const write = vi.fn()
			.mockRejectedValueOnce(superMajority())
			.mockRejectedValueOnce(superMajority())
			.mockResolvedValue('row');

		await expect(retryAfterRestart(write, { delayMs: 1 })).resolves.toBe('row');
		expect(write).toHaveBeenCalledTimes(3);
	});

	it('gives up after the last attempt, with that attempt\'s error', async () => {
		const write = vi.fn().mockRejectedValue(superMajority());

		await expect(retryAfterRestart(write, { attempts: 2, delayMs: 1 })).rejects.toThrow(/super-majority/);
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('does not retry any other error', async () => {
		const write = vi.fn().mockRejectedValue(new Error('constraint failed'));

		await expect(retryAfterRestart(write, { delayMs: 1 })).rejects.toThrow('constraint failed');
		expect(write).toHaveBeenCalledTimes(1);
	});
});
