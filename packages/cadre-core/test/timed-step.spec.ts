import { describe, it, expect } from 'vitest';
import { timedStep } from '../src/timed-step.js';
import { captureDebugLog } from './capture-debug-log.js';

/**
 * `timedStep` brackets one awaited step with `sereus:cadre:timing` lines. A device trace is
 * read by pairing them (a start with no end names the step that hung), so the start line,
 * both kinds of end line, and the value or error passed through are pinned here.
 */

const TIMING = 'sereus:cadre:timing';

describe('timedStep', () => {
	it('logs the start before the step runs, then its duration, and returns its value', async () => {
		let loggedBeforeStep: string[] = [];
		let result: number | undefined;

		const lines = await captureDebugLog(TIMING, async (captured) => {
			result = await timedStep('foundStrand', 'abc', 'publishStrand', async () => {
				loggedBeforeStep = [...captured];
				return 42;
			});
		});

		expect(result).toBe(42);
		expect(loggedBeforeStep).toEqual([expect.stringContaining('[foundStrand:abc] publishStrand: start')]);
		expect(lines).toEqual([
			expect.stringContaining('[foundStrand:abc] publishStrand: start'),
			expect.stringMatching(/\[foundStrand:abc\] publishStrand: \d+ms/),
		]);
	});

	it('logs a failed end and rethrows the step error unchanged', async () => {
		const error = new Error('publish refused');

		const lines = await captureDebugLog(TIMING, async () => {
			await expect(timedStep('foundStrand', 'abc', 'publishStrand', async () => { throw error; })).rejects.toBe(error);
		});

		expect(lines).toEqual([
			expect.stringContaining('[foundStrand:abc] publishStrand: start'),
			expect.stringMatching(/\[foundStrand:abc\] publishStrand: failed after \d+ms/),
		]);
	});
});
