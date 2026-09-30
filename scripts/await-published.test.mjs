/**
 * Unit tests for the post-publish wait's decisions (`scripts/lib/published-visibility.mjs`): which
 * packages `yarn pub` publishes, what each registry answer means, when to stop asking, and what the
 * timeout report tells the operator. The wait itself — `scripts/await-published.mjs`, which fetches
 * and sets the exit code — is not imported here, and no test touches the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	NOT_YET_VISIBLE,
	publishedPackageDirs,
	readPackumentAnswer,
	readTarballAnswer,
	timeoutReport,
	waitForVisibility,
	waitTimeoutMs,
} from './lib/published-visibility.mjs';
import { repoRoot } from './lib/release-support.mjs';

const CORE = { name: '@serfab/cadre-core', version: '1.8.0' };
const TARBALL = 'https://registry.npmjs.org/@serfab/cadre-core/-/cadre-core-1.8.0.tgz';

/** An abbreviated packument listing `versions`, each with a tarball, under `distTags`. */
function packument(versions, distTags) {
	const entries = versions.map((version) => [version, { version, dist: { tarball: TARBALL.replace('1.8.0', version) } }]);
	return { status: 200, body: JSON.stringify({ name: CORE.name, 'dist-tags': distTags, versions: Object.fromEntries(entries) }) };
}

test('publishedPackageDirs: follows the `pub` chain into each `pub:*` script, in order', () => {
	const scripts = {
		pub: 'yarn pub:a && yarn pub:b',
		'pub:a': 'node scripts/publish-package.mjs a',
		'pub:b': 'node scripts/publish-package.mjs b',
		'pub:unchained': 'node scripts/publish-package.mjs c',
	};
	assert.deepEqual(publishedPackageDirs(scripts), ['a', 'b']);
});

test('publishedPackageDirs: a step it cannot read throws and names it, rather than waiting for less', () => {
	assert.throws(
		() => publishedPackageDirs({ pub: 'yarn build && yarn pub:a', 'pub:a': 'node scripts/publish-package.mjs a' }),
		/'pub' runs `yarn build`, which is neither/,
	);
});

test('publishedPackageDirs: this repository\'s own `pub` chain is readable, so the wait cannot refuse it after a publish', () => {
	const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
	assert.doesNotThrow(() => publishedPackageDirs(scripts));
});

test('readPackumentAnswer: the version listed under the release\'s own dist-tag yields its tarball', () => {
	// Published under `alpha`: `latest` still pointing elsewhere is correct, and must not hold the wait.
	const answer = readPackumentAnswer(packument(['1.7.0', '1.8.0'], { latest: '1.7.0', alpha: '1.8.0' }), CORE, 'alpha');
	assert.deepEqual(answer, { tarball: TARBALL });
});

test('readPackumentAnswer: a 404 is not yet, not an error — a package\'s first-ever version reads this way', () => {
	assert.deepEqual(readPackumentAnswer({ status: 404, body: '{"error":"Not found"}' }, CORE, undefined), { visible: false, reason: NOT_YET_VISIBLE });
});

test('readPackumentAnswer: a packument without the version is not yet', () => {
	assert.deepEqual(readPackumentAnswer(packument(['1.7.0'], { latest: '1.7.0' }), CORE, undefined), { visible: false, reason: NOT_YET_VISIBLE });
});

test('readPackumentAnswer: the version listed but the dist-tag still elsewhere is not yet, and says which', () => {
	const answer = readPackumentAnswer(packument(['1.7.0', '1.8.0'], { latest: '1.7.0' }), CORE, undefined);
	assert.deepEqual(answer, { visible: false, reason: 'dist-tag latest still points at 1.7.0' });
});

test('readPackumentAnswer: any other status keeps the wait going, with the status as the reason', () => {
	assert.deepEqual(readPackumentAnswer({ status: 503, body: '' }, CORE, undefined), { visible: false, reason: 'registry answered HTTP 503' });
});

test('readPackumentAnswer: a 200 that is not a packument throws rather than being read past', () => {
	assert.throws(() => readPackumentAnswer({ status: 200, body: '<html>proxy</html>' }, CORE, undefined), /is not JSON/);
});

test('readTarballAnswer: only a 200 makes the package installable', () => {
	assert.deepEqual(readTarballAnswer(200), { visible: true });
	assert.deepEqual(readTarballAnswer(404), { visible: false, reason: 'tarball not downloadable yet' });
});

/**
 * A wait over a fake clock: `sleep` advances it, and `probe` answers from `script` — for each package,
 * one answer per round in which it is asked, repeating the last.
 */
async function scriptedWait(script, { timeoutMs = 60_000, intervalMs = 5_000 } = {}) {
	let clock = 0;
	const asked = [];
	const stragglers = await waitForVisibility({
		expected: Object.keys(script).map((name) => ({ name, version: '1.8.0' })),
		probe: async (spec) => {
			const answers = script[spec.name];
			const askedBefore = asked.filter((entry) => entry.name === spec.name).length;
			asked.push({ name: spec.name, at: clock });
			return answers[Math.min(askedBefore, answers.length - 1)];
		},
		timeoutMs,
		intervalMs,
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
	});
	return { stragglers, asked, clock };
}

const SEEN = { visible: true };
const NOT_YET = { visible: false, reason: NOT_YET_VISIBLE };
const NO_TARBALL = { visible: false, reason: 'tarball not downloadable yet' };

test('waitForVisibility: a package seen once is not asked about again', async () => {
	const { stragglers, asked, clock } = await scriptedWait({ a: [NOT_YET, NOT_YET, SEEN], b: [NOT_YET, SEEN], c: [SEEN] });
	assert.deepEqual(stragglers, []);
	assert.equal(clock, 10_000);
	assert.deepEqual(asked.map(({ name }) => name).sort(), ['a', 'a', 'a', 'b', 'b', 'c']);
});

test('waitForVisibility: packages still missing at the deadline come back with their latest reason', async () => {
	const { stragglers, asked } = await scriptedWait({ a: [SEEN], b: [NOT_YET, NO_TARBALL] }, { timeoutMs: 12_000 });
	assert.deepEqual(stragglers, [{ spec: { name: 'b', version: '1.8.0' }, reason: NO_TARBALL.reason }]);
	// The last sleep is cut short so the final round runs at the deadline, not past it.
	assert.deepEqual(asked.filter(({ name }) => name === 'b').map(({ at }) => at), [0, 5_000, 10_000, 12_000]);
});

test('waitForVisibility: a package that appears on the round at the deadline counts as seen', async () => {
	const { stragglers } = await scriptedWait({ a: [NOT_YET, NOT_YET, NOT_YET, SEEN] }, { timeoutMs: 12_000 });
	assert.deepEqual(stragglers, []);
});

test('timeoutReport: names each straggler, says the publish is done, and lists the rest of the release in order', () => {
	const report = timeoutReport(
		[
			{ spec: CORE, reason: 'tarball not downloadable yet' },
			{ spec: { name: '@serfab/cadre-host', version: '1.8.0' }, reason: NOT_YET_VISIBLE },
		],
		7,
		600_000,
		{ tag: undefined },
	);
	assert.match(report, /^2 of 7 packages still not installable from npm after 600 s:/);
	assert.match(report, /@serfab\/cadre-core@1\.8\.0 — tarball not downloadable yet/);
	assert.match(report, /@serfab\/cadre-host@1\.8\.0 — not on the registry yet/);
	assert.match(report, /npm already accepted the publish/);
	assert.match(report, /Do NOT re-run `yarn release`/);
	assert.ok(report.indexOf('  yarn await-published') < report.indexOf('  node scripts/release-finish.mjs'));
	assert.doesNotMatch(report, /SEREUS_DIST_TAG/);
});

test('timeoutReport: a release under a dist-tag is told to keep that tag set for the remaining commands', () => {
	const report = timeoutReport([{ spec: CORE, reason: NOT_YET_VISIBLE }], 7, 600_000, { tag: 'alpha' });
	assert.match(report, /Keep SEREUS_DIST_TAG=alpha set/);
});

test('waitTimeoutMs: defaults to ten minutes, and refuses anything but a positive number of seconds', () => {
	assert.equal(waitTimeoutMs({}), 600_000);
	assert.equal(waitTimeoutMs({ SEREUS_PUBLISH_WAIT_SECONDS: '90' }), 90_000);
	for (const raw of ['0', '-5', 'abc']) {
		assert.throws(() => waitTimeoutMs({ SEREUS_PUBLISH_WAIT_SECONDS: raw }), /must be a positive number of seconds/);
	}
});
