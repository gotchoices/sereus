import { afterEach, describe, expect, it } from 'vitest';
import { CoordinatorRepo } from '@optimystic/db-p2p';
import { formatConsultSnapshot, formatPerBlock, installConsultCounter } from './cohort-consult-counter.js';

/**
 * `cohort-consult-counter.ts` on its own, with no node. Both `CoordinatorRepo` methods it
 * wraps are first replaced by stubs, so a call passes through the counter into a stub that
 * records it. `control-founding-consult-budget.spec.ts` exercises the counter against a real
 * node; this covers what that spec never reaches: out-of-order restore, a method missing at
 * install, and label bookkeeping across a reset.
 */

type MethodName = 'fetchBlockFromCluster' | 'commit';
type Method = (this: object, ...args: unknown[]) => Promise<unknown>;

/** The prototype slots the counter patches; `fetchBlockFromCluster` is TypeScript-private. */
const proto = CoordinatorRepo.prototype as unknown as Record<MethodName, Method | undefined>;
const originals = { fetchBlockFromCluster: proto.fetchBlockFromCluster, commit: proto.commit };

interface StubCall {
	method: MethodName;
	repo: object;
	args: unknown[];
}

/** Replace both methods with stubs that record each call and resolve to `<method> result`. */
function installStubs(): StubCall[] {
	const calls: StubCall[] = [];
	for (const method of ['fetchBlockFromCluster', 'commit'] as const) {
		proto[method] = async function (this: object, ...args: unknown[]) {
			calls.push({ method, repo: this, args });
			return `${method} result`;
		};
	}
	return calls;
}

/** Whatever is on the prototype now, called as `repo` would call it. */
function invoke(method: MethodName, repo: object, ...args: unknown[]): Promise<unknown> {
	const fn = proto[method];
	if (!fn) throw new Error(`CoordinatorRepo.prototype.${method} is not installed`);
	return fn.call(repo, ...args);
}

function currentMethods(): Record<MethodName, Method | undefined> {
	return { fetchBlockFromCluster: proto.fetchBlockFromCluster, commit: proto.commit };
}

afterEach(() => {
	proto.fetchBlockFromCluster = originals.fetchBlockFromCluster;
	proto.commit = originals.commit;
});

describe('cohort consult counter', () => {
	it('counts consults per block and commits, and delegates with the same receiver, arguments and result', async () => {
		const calls = installStubs();
		const counter = installConsultCounter();
		const repo = {};
		expect(await invoke('fetchBlockFromCluster', repo, 'a', 'context', 3)).toBe('fetchBlockFromCluster result');
		await invoke('fetchBlockFromCluster', repo, 'b');
		await invoke('fetchBlockFromCluster', repo, 'b');
		expect(await invoke('commit', repo, { request: 1 })).toBe('commit result');
		counter.restore();

		expect(calls.map(({ method, args }) => ({ method, args }))).toEqual([
			{ method: 'fetchBlockFromCluster', args: ['a', 'context', 3] },
			{ method: 'fetchBlockFromCluster', args: ['b'] },
			{ method: 'fetchBlockFromCluster', args: ['b'] },
			{ method: 'commit', args: [{ request: 1 }] }
		]);
		expect(calls.every((call) => call.repo === repo)).toBe(true);
		const snapshot = counter.snapshot();
		expect(snapshot).toMatchObject({ consults: 3, distinctBlocks: 2, commits: 1 });
		expect(formatConsultSnapshot('scope', 'phase', snapshot)).toBe('[scope] phase: consults=3 distinctBlocks=2 commits=1 — b×2, a×1');
	});

	it('orders equally busy blocks by id, and names an empty snapshot', async () => {
		installStubs();
		const counter = installConsultCounter();
		expect(formatPerBlock(counter.snapshot())).toBe('(no consults)');
		await invoke('fetchBlockFromCluster', {}, 'b');
		await invoke('fetchBlockFromCluster', {}, 'a');
		counter.restore();
		expect(formatPerBlock(counter.snapshot())).toBe('a×1, b×1');
	});

	it('narrows a snapshot by label, labels only unlabelled repos, and keeps labels across a reset', async () => {
		installStubs();
		const counter = installConsultCounter();
		const control = {};
		const strand = {};
		const unlabelled = {};
		await invoke('fetchBlockFromCluster', control, 'x');
		expect(counter.labelUnlabeled('control')).toBe(1);
		await invoke('fetchBlockFromCluster', strand, 'y');
		await invoke('commit', strand);
		expect(counter.labelUnlabeled('strand')).toBe(1);
		expect(counter.labelUnlabeled('stray')).toBe(0);
		await invoke('fetchBlockFromCluster', unlabelled, 'z');

		expect(counter.snapshot('control')).toMatchObject({ consults: 1, distinctBlocks: 1, commits: 0 });
		expect(counter.snapshot('strand')).toMatchObject({ consults: 1, distinctBlocks: 1, commits: 1 });
		expect(counter.snapshot()).toMatchObject({ consults: 3, distinctBlocks: 3, commits: 1 });

		counter.reset();
		expect(counter.snapshot()).toMatchObject({ consults: 0, distinctBlocks: 0, commits: 0 });
		await invoke('fetchBlockFromCluster', strand, 'y');
		expect(counter.snapshot('strand').consults).toBe(1);
		expect(counter.snapshot('control').consults).toBe(0);
		// Only the repo that was never labelled is picked up; the reset kept the other two labels.
		expect(counter.labelUnlabeled('stray')).toBe(1);
		counter.restore();
	});

	it('restores the methods underneath it, and a second restore is a no-op', async () => {
		const calls = installStubs();
		const underneath = currentMethods();
		const counter = installConsultCounter();
		expect(proto.commit).not.toBe(underneath.commit);

		counter.restore();
		expect(currentMethods()).toEqual(underneath);
		counter.restore();
		expect(currentMethods()).toEqual(underneath);

		await invoke('commit', {});
		expect(calls).toHaveLength(1);
		expect(counter.snapshot().commits).toBe(0);
	});

	it('refuses to restore while a later patch sits on top, stays installed, and restores once that patch is gone', async () => {
		installStubs();
		const underneath = currentMethods();
		const outer = installConsultCounter();
		const inner = installConsultCounter();

		expect(() => outer.restore()).toThrow(/a later patch is still installed over this one/);
		await invoke('fetchBlockFromCluster', {}, 'z');
		expect(outer.snapshot().consults).toBe(1);
		expect(inner.snapshot().consults).toBe(1);

		inner.restore();
		outer.restore();
		expect(proto.fetchBlockFromCluster).toBe(underneath.fetchBlockFromCluster);
		expect(proto.commit).toBe(underneath.commit);
	});

	it.each(['fetchBlockFromCluster', 'commit'] as const)('refuses to install, and patches nothing, when %s is not a function', (method) => {
		installStubs();
		proto[method] = undefined;
		const before = currentMethods();
		expect(() => installConsultCounter()).toThrow(`CoordinatorRepo.prototype.${method} is not a function`);
		expect(currentMethods()).toEqual(before);
	});
});
