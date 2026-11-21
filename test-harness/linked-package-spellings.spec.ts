/**
 * Unit tests for the two-spellings guard.
 *
 * Its failure modes pull in opposite directions, and both are expensive. Missing
 * a real disagreement hands the suite two copies of one package, where every
 * `instanceof` across them is false and the symptom looks like a bug in this
 * repository. Reporting one that is not there stops every suite on the machine
 * over an install that works. So each case below is one of the detector's real
 * branches, in one direction or the other.
 *
 * Every case builds its own temp-dir layout: a repository root bounding the
 * `node_modules` walk, a suite directory under it, and junctions onto working
 * copies beside it. Only `linked` targets are used, so nothing is looked up in
 * this checkout's own `packages/`.
 *
 * NOTE: no ancestor of `<tmp>` declares `workspaces`, so a walk from a discovered
 * context runs to the filesystem root. Harmless because the fixture uses names
 * (`@sibling/*`) no real install produces — the same bound the `build-freshness`
 * fixtures rely on.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type BuildTarget } from './build-freshness.js';
import { assertOneSpellingPerLinkedPackage, findSpellingDisagreements } from './linked-package-spellings.js';

/**
 * Three linked names, so a chain of contexts can be built without any package
 * importing itself: the suite reaches `MID`, `MID` reaches `DEEP`, and `PKG` is
 * the one whose spellings are under test.
 */
const PKG = '@sibling/pkg';
const MID = '@sibling/mid';
const DEEP = '@sibling/deep';

const TARGETS: readonly BuildTarget[] = [PKG, MID, DEEP].map((packageName) => (
	{ packageName, distEntry: 'dist/src/index.js', location: 'linked' }
));

describe('linked package spellings', () => {
	let tmp: string;
	let repo: string;
	/** The package whose suite is running — it gets its own `node_modules`, as the reference apps do. */
	let app: string;
	/** `import.meta.url` as a real setup module would pass it. */
	let setupUrl: string;

	beforeEach(() => {
		// `realpath` because macOS hands out a symlinked tmpdir, and the fixture's
		// own paths are compared against resolved ones.
		tmp = realpathSync(mkdtempSync(join(tmpdir(), 'linked-spellings-')));
		repo = join(tmp, 'repo');
		app = join(repo, 'packages', 'app');
		const suite = join(app, 'test');

		mkdirSync(suite, { recursive: true });
		writeFileSync(join(repo, 'package.json'), '{"name":"repo","workspaces":["packages/*"]}\n');
		setupUrl = pathToFileURL(join(suite, 'global-setup.ts')).href;
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	/** A working copy at `<tmp>/<name>` whose manifest declares `declares` as dependencies. */
	function workingCopy(name: string, ...declares: string[]): string {
		const root = join(tmp, name);
		mkdirSync(root, { recursive: true });
		const dependencies = Object.fromEntries(declares.map((declared) => [declared, '*']));
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name, dependencies }));
		return root;
	}

	/** What `yarn install` leaves in `holder`'s `node_modules` for a `link:` resolution. */
	function link(holder: string, packageName: string, target: string): string {
		const junction = join(holder, 'node_modules', packageName);
		mkdirSync(dirname(junction), { recursive: true });
		symlinkSync(target, junction, 'junction');
		return junction;
	}

	/** What `yarn install` leaves for an ordinary registry dependency: a real directory. */
	function installCopy(holder: string, packageName: string): void {
		mkdirSync(join(holder, 'node_modules', packageName), { recursive: true });
	}

	/** The message of the refusal, so several parts of it can be asserted separately. */
	function refusal(): string {
		try {
			assertOneSpellingPerLinkedPackage(TARGETS, setupUrl);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error('expected a refusal, but nothing was thrown');
	}

	it('reports a package two junctions resolve to different paths, and names both in the refusal', () => {
		const copyA = workingCopy('copy-a');
		const copyB = workingCopy('copy-b');
		const mid = workingCopy('mid', PKG);
		const appJunction = link(app, PKG, copyA);
		link(app, MID, mid);
		const midJunction = link(mid, PKG, copyB);

		const [disagreement, ...rest] = findSpellingDisagreements(TARGETS, setupUrl);

		expect(rest).toEqual([]);
		expect(disagreement.packageName).toBe(PKG);
		expect(disagreement.spellings.map((spelling) => spelling.resolved)).toEqual([copyA, copyB]);
		expect(disagreement.spellings.map((spelling) => [...spelling.via])).toEqual([[appJunction], [midJunction]]);

		// A reader who has never met this failure has to be able to act on the
		// message alone: which paths disagree, which links hold them, and — because
		// `mid` is outside the repository root — that the sibling is not to be touched.
		const message = refusal();
		expect(message).toContain(copyA);
		expect(message).toContain(copyB);
		expect(message).toContain(appJunction);
		expect(message).toContain(midJunction);
		expect(message).toContain('do not write in the sibling');
		expect(message).toContain('`yarn install` is not the fix');
	});

	it('does not report a package every junction spells the same way', () => {
		// The uniformly-odd case: a spelling may disagree with the disk, and as long
		// as every junction agrees with every other one, only one copy is loaded.
		const copy = workingCopy('copy');
		const mid = workingCopy('mid', PKG);
		link(app, PKG, copy);
		link(app, MID, mid);
		link(mid, PKG, copy);

		expect(findSpellingDisagreements(TARGETS, setupUrl)).toEqual([]);
	});

	it('does not report a registry-installed copy beside a linked one', () => {
		const copy = workingCopy('copy');
		const mid = workingCopy('mid', PKG);
		link(app, PKG, copy);
		link(app, MID, mid);
		installCopy(mid, PKG);

		expect(findSpellingDisagreements(TARGETS, setupUrl)).toEqual([]);
	});

	it('does not report a package reachable only under a name its holder never imports', () => {
		// The real case: from inside the Quereus checkout, `@quereus/quereus`
		// resolves to that checkout's own spelling — but nothing there imports it by
		// name, so no load ever keys on that string.
		const copyA = workingCopy('copy-a');
		const copyB = workingCopy('copy-b');
		const mid = workingCopy('mid');
		link(app, PKG, copyA);
		link(app, MID, mid);
		link(mid, PKG, copyB);

		expect(findSpellingDisagreements(TARGETS, setupUrl)).toEqual([]);
	});

	it('follows nested node_modules past the first linked package it finds', () => {
		const copyA = workingCopy('copy-a');
		const copyB = workingCopy('copy-b');
		const deep = workingCopy('deep', PKG);
		const mid = workingCopy('mid', DEEP);
		link(app, PKG, copyA);
		link(app, MID, mid);
		link(mid, DEEP, deep);
		const deepJunction = link(deep, PKG, copyB);

		const [disagreement, ...rest] = findSpellingDisagreements(TARGETS, setupUrl);

		expect(rest).toEqual([]);
		expect(disagreement.spellings.map((spelling) => spelling.resolved)).toEqual([copyA, copyB]);
		expect(disagreement.spellings[1].via).toEqual([deepJunction]);
	});

	/**
	 * The bug's reproduction, at the lowest layer that has it, and the only case
	 * that exercises the difference between `realpathSync` and
	 * `realpathSync.native`. Windows only because it needs a filesystem that
	 * accepts two cases for one directory.
	 */
	it.runIf(process.platform === 'win32')('reports two junctions onto one directory whose spellings differ only in case', () => {
		const copy = workingCopy('casecopy');
		const mid = workingCopy('mid', PKG);
		link(app, PKG, copy);
		link(app, MID, mid);
		link(mid, PKG, join(tmp, 'CASECOPY'));

		const [disagreement, ...rest] = findSpellingDisagreements(TARGETS, setupUrl);

		expect(rest).toEqual([]);
		const [first, second] = disagreement.spellings;
		expect(first.resolved).not.toBe(second.resolved);
		expect(first.resolved.toLowerCase()).toBe(second.resolved.toLowerCase());
		// One directory, so both spellings correct to the same thing on disk — which
		// is what makes this invisible to anything but a string comparison.
		const onDisk = realpathSync.native(copy);
		expect([first.onDisk, second.onDisk]).toEqual([onDisk, onDisk]);
	});
});
