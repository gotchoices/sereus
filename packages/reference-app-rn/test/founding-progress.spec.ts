import { describe, expect, it } from 'vitest';
import {
	FOUNDING_SLOW_HINT_MS,
	foundingDetail,
	isSlowFounding,
	pendingLabel,
	traceFounding,
	type FoundingLogger,
} from '../src/founding-progress.js';

/**
 * The Settings screen's founding feedback, without React Native. The log lines are
 * what a device report carries — a `[settings] create strand <id> pressed` line is how
 * a trace tells a tap that reached the handler from one that never did — so their
 * shape and order are pinned here.
 */

const LABEL = '[settings] create strand abcd1234';

interface LoggedLine {
	level: 'info' | 'warn';
	message: string;
	error?: unknown;
}

function recordingLogger(): { lines: LoggedLine[]; logger: FoundingLogger } {
	const lines: LoggedLine[] = [];
	return {
		lines,
		logger: {
			info: (message) => { lines.push({ level: 'info', message }); },
			warn: (message, error) => { lines.push({ level: 'warn', message, error }); },
		},
	};
}

/** A clock returning `readings` in turn, then repeating the last one. */
function steppingClock(...readings: number[]): () => number {
	let next = 0;
	return () => readings[Math.min(next++, readings.length - 1)]!;
}

describe('traceFounding', () => {
	it('logs "pressed" before the founding action runs', async () => {
		const { lines, logger } = recordingLogger();
		let linesWhenActionRan: LoggedLine[] = [];

		await traceFounding(LABEL, async () => { linesWhenActionRan = [...lines]; }, logger, steppingClock(0, 5));

		expect(linesWhenActionRan).toEqual([{ level: 'info', message: `${LABEL} pressed` }]);
	});

	it('returns the value with the elapsed time and logs the success', async () => {
		const { lines, logger } = recordingLogger();

		const outcome = await traceFounding(LABEL, async () => 'invite', logger, steppingClock(1_000, 2_400));

		expect(outcome).toEqual({ ok: true, value: 'invite', elapsedMs: 1_400 });
		expect(lines).toEqual([
			{ level: 'info', message: `${LABEL} pressed` },
			{ level: 'info', message: `${LABEL} succeeded in 1400 ms` },
		]);
	});

	it('returns a rejection as a failed outcome and logs it as a warning with the error', async () => {
		const { lines, logger } = recordingLogger();
		const error = new Error('no owner signing key available');

		const outcome = await traceFounding(LABEL, async () => { throw error; }, logger, steppingClock(0, 3_200));

		expect(outcome).toEqual({ ok: false, error, elapsedMs: 3_200 });
		expect(lines[lines.length - 1]).toEqual({ level: 'warn', message: `${LABEL} failed after 3200 ms:`, error });
	});

	it('treats an action that throws synchronously like one that rejects', async () => {
		const { logger } = recordingLogger();
		const error = new Error('Node not started');

		const outcome = await traceFounding(LABEL, () => { throw error; }, logger, steppingClock(0, 0));

		expect(outcome).toEqual({ ok: false, error, elapsedMs: 0 });
	});
});

describe('founding progress text', () => {
	it('labels the pressed button with whole elapsed seconds', () => {
		expect(pendingLabel(0)).toBe('Creating… 0 s');
		expect(pendingLabel(12_999)).toBe('Creating… 12 s');
	});

	it('shows the slow-founding hint from the threshold on, not before', () => {
		expect(FOUNDING_SLOW_HINT_MS).toBe(30_000);
		expect(isSlowFounding(FOUNDING_SLOW_HINT_MS - 1)).toBe(false);
		expect(isSlowFounding(FOUNDING_SLOW_HINT_MS)).toBe(true);
	});

	it('reports the elapsed time with the result, to a tenth of a second', () => {
		expect(foundingDetail({ ok: true, value: 'x', elapsedMs: 1_449 })).toBe('Created in 1.4 s');
		expect(foundingDetail({ ok: false, error: new Error('x'), elapsedMs: 3_200 })).toBe('Failed after 3.2 s');
	});
});
