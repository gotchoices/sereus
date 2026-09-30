/**
 * The pure half of the post-publish wait (`scripts/await-published.mjs`): which packages `yarn pub`
 * publishes, what the registry's answers say about each, how long to keep asking, and what to print.
 *
 * Nothing here fetches, reads a file or exits. The entry script does that, and is the place to read
 * about why the wait exists. The two are separate files so `scripts/await-published.test.mjs` can
 * import these decisions without running the wait. Ported from optimystic's
 * `scripts/published-visibility.mjs` and Fret's `scripts/published-visibility.js`; unlike both, it
 * reads the registry over HTTPS rather than through `npm view`, for the reason `registryHasVersion`
 * in `release-support.mjs` gives, and it counts a package as there only once its tarball downloads.
 */
import { readPackumentJson } from './release-support.mjs';

/**
 * @typedef {object} PackageSpec  One package a release publishes, at the version it publishes.
 * @property {string} name     e.g. `@serfab/cadre-core`
 * @property {string} version  e.g. `1.8.0`
 *
 * @typedef {{ visible: true } | { visible: false, reason: string }} Answer
 *
 * @typedef {object} Straggler  A package not yet installable at its version.
 * @property {PackageSpec} spec
 * @property {string} reason  Why it counts as not installable, from the most recent answer.
 *
 * @typedef {object} Progress
 * @property {Straggler[]} stragglers
 * @property {number} total      How many packages the wait is for.
 * @property {number} elapsedMs
 */

/** The reason given for a package the registry simply does not list at its version yet. */
export const NOT_YET_VISIBLE = 'not on the registry yet';

/** An npm package name, optionally scoped. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/** Semver: the shape a version must have to be something `yarn pub` published. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `name@version`, the form every report prints. */
export function specString({ name, version }) {
	return `${name}@${version}`;
}

// -- Which packages ------------------------------------------------------------------------------

/** One `pub` step that publishes: `node scripts/publish-package.mjs <dir>`, `<dir>` relative to `packages/`. */
const PUBLISH_STEP_RE = /^node scripts\/publish-package\.mjs ([\w.-]+(?:\/[\w.-]+)*)$/;

/** One `pub` step that runs another script: `yarn pub:<name>`. */
const YARN_STEP_RE = /^yarn (pub:[\w:-]+)$/;

/**
 * The package directories `yarn pub` publishes, in its order, read from the root `package.json`
 * scripts rather than restated here, so the wait covers exactly what `pub` publishes.
 *
 * This reads the `pub` chain, not every `pub:*` script (which is what `publishableWorkspaces` in
 * `published-smoke-support.mjs` reads): a `pub:*` script outside the chain is never published by
 * `yarn release`, so waiting for it would always time out.
 *
 * `pub` is a `&&` chain whose every step is either `yarn pub:<name>` (followed into that script) or
 * `node scripts/publish-package.mjs <dir>`. Anything else throws: a step this cannot read might
 * publish a package the wait would then never ask about.
 *
 * @param {Record<string, unknown>} scripts  The root manifest's `scripts`.
 * @returns {string[]}
 */
export function publishedPackageDirs(scripts) {
	const dirs = publishStepDirs(scripts, 'pub', []);
	if (dirs.length === 0) throw new Error(`package.json: 'pub' publishes no package`);
	return dirs;
}

/**
 * @param {Record<string, unknown>} scripts
 * @param {string} scriptName
 * @param {string[]} via  The scripts that led here, to report and to refuse a cycle.
 * @returns {string[]}
 */
function publishStepDirs(scripts, scriptName, via) {
	if (via.includes(scriptName)) throw new Error(`package.json: '${scriptName}' runs itself (${[...via, scriptName].join(' → ')})`);
	const command = scripts[scriptName];
	if (typeof command !== 'string') {
		throw new Error(`package.json: ${via.length > 0 ? `'${via.at(-1)}' runs '${scriptName}', which is not a script` : `no '${scriptName}' script`}`);
	}
	return command.split('&&').map((step) => step.trim()).flatMap((step) => stepDirs(scripts, step, [...via, scriptName]));
}

/**
 * @param {Record<string, unknown>} scripts
 * @param {string} step
 * @param {string[]} via
 * @returns {string[]}
 */
function stepDirs(scripts, step, via) {
	const publish = PUBLISH_STEP_RE.exec(step);
	if (publish) return [publish[1]];
	const yarn = YARN_STEP_RE.exec(step);
	if (yarn) return publishStepDirs(scripts, yarn[1], via);
	throw new Error(`package.json: '${via.at(-1)}' runs \`${step}\`, which is neither \`yarn pub:<name>\` nor \`node scripts/publish-package.mjs <dir>\` — cannot tell what it publishes`);
}

/**
 * Each published directory's package, at the version its own manifest names — the version
 * `yarn npm publish` reads, so after `yarn bump` it is the version the release just published.
 *
 * @param {string[]} dirs  Relative to `packages/`.
 * @param {(dir: string) => { name?: unknown, version?: unknown }} manifestAt  The parsed `package.json` in `packages/<dir>`.
 * @returns {PackageSpec[]}
 */
export function expectedPackages(dirs, manifestAt) {
	return dirs.map((dir) => {
		const { name, version } = manifestAt(dir);
		if (typeof name !== 'string' || !PACKAGE_NAME_RE.test(name)) {
			throw new Error(`packages/${dir}/package.json names no publishable package (found ${JSON.stringify(name)})`);
		}
		if (typeof version !== 'string' || !VERSION_RE.test(version)) {
			throw new Error(`packages/${dir}/package.json names no publishable version (found ${JSON.stringify(version)})`);
		}
		return { name, version };
	});
}

// -- Reading the registry's answers --------------------------------------------------------------

/**
 * Read one fetch of a package's abbreviated packument — the document installers resolve ranges
 * against — and decide whether the package is installable yet, as far as that document can say.
 *
 * - 404 means not yet: the registry says the same for a package's first-ever version as for a
 *   missing version of an existing package.
 * - Any other non-200 means not visible this round, with the status as the reason. Unlike
 *   `interpretPackument`, which refuses to guess, the wait's job is to keep asking.
 * - 200 without the version means not yet: a `^` range would resolve to an older version.
 * - 200 with the version but `dist-tags[tag]` elsewhere means not yet: `npm install <name>` with no
 *   range would still return the other version.
 * - 200 with the version and the tag gives the tarball URL, which the entry then downloads.
 *
 * A 200 whose body is not JSON, or has no `versions` map, throws (see `readPackumentJson`).
 *
 * @param {{ status: number, body: string }} response
 * @param {PackageSpec} spec
 * @param {string | undefined} tag  The dist-tag the release published under; `undefined` is `latest`.
 * @returns {{ visible: false, reason: string } | { tarball: string }}
 */
export function readPackumentAnswer({ status, body }, spec, tag) {
	if (status === 404) return { visible: false, reason: NOT_YET_VISIBLE };
	if (status !== 200) return { visible: false, reason: `registry answered HTTP ${status}` };
	const packument = readPackumentJson(body, spec.name);
	if (!Object.hasOwn(packument.versions, spec.version)) return { visible: false, reason: NOT_YET_VISIBLE };
	const tagName = tag ?? 'latest';
	const tagged = packument['dist-tags']?.[tagName];
	if (tagged !== spec.version) {
		return { visible: false, reason: tagged === undefined ? `dist-tag ${tagName} is not set` : `dist-tag ${tagName} still points at ${tagged}` };
	}
	const tarball = packument.versions[spec.version]?.dist?.tarball;
	if (!isHttpUrl(tarball)) {
		return { visible: false, reason: `versions["${spec.version}"].dist.tarball is not an http(s) URL (found ${JSON.stringify(tarball)})` };
	}
	return { tarball };
}

/** @param {unknown} value */
function isHttpUrl(value) {
	if (typeof value !== 'string' || !URL.canParse(value)) return false;
	const { protocol } = new URL(value);
	return protocol === 'http:' || protocol === 'https:';
}

/**
 * Read the status of a GET of a version's tarball: 200 is the last thing an install needs.
 *
 * @param {number} status
 * @returns {Answer}
 */
export function readTarballAnswer(status) {
	if (status === 200) return { visible: true };
	return { visible: false, reason: status === 404 ? 'tarball not downloadable yet' : `tarball answered HTTP ${status}` };
}

// -- Waiting -------------------------------------------------------------------------------------

/** The environment variable that overrides how long the wait lasts, in seconds. */
export const WAIT_SECONDS_ENV = 'SEREUS_PUBLISH_WAIT_SECONDS';

const DEFAULT_WAIT_SECONDS = 600;

/**
 * How long to wait, from `SEREUS_PUBLISH_WAIT_SECONDS` or the default. Anything but a positive
 * finite number of seconds throws, rather than turning into a wait of no time or of forever.
 *
 * @param {Record<string, string | undefined>} environment
 */
export function waitTimeoutMs(environment) {
	const raw = environment[WAIT_SECONDS_ENV];
	if (raw === undefined || raw === '') return DEFAULT_WAIT_SECONDS * 1000;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${WAIT_SECONDS_ENV} must be a positive number of seconds, not ${JSON.stringify(raw)}`);
	return value * 1000;
}

/**
 * Ask about every package, then again every `intervalMs` about the ones not yet seen, until all have
 * been seen or `timeoutMs` has passed. A package seen once is not asked about again. The last round
 * runs at the deadline, so a package that lands just before it still counts.
 *
 * @param {object} options
 * @param {PackageSpec[]} options.expected
 * @param {(spec: PackageSpec) => Promise<Answer>} options.probe  One registry question.
 * @param {number} options.timeoutMs
 * @param {number} options.intervalMs
 * @param {() => number} options.now  A millisecond clock.
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {(progress: Progress) => void} [options.onProgress]  Called after each round that leaves stragglers, except the last.
 * @returns {Promise<Straggler[]>}  The packages still not installable at the deadline; empty when every one was seen.
 */
export async function waitForVisibility({ expected, probe, timeoutMs, intervalMs, now, sleep, onProgress }) {
	const start = now();
	let pending = expected;
	for (;;) {
		const stragglers = await askRound(pending, probe);
		const elapsedMs = now() - start;
		if (stragglers.length === 0 || elapsedMs >= timeoutMs) return stragglers;
		onProgress?.({ stragglers, total: expected.length, elapsedMs });
		pending = stragglers.map(({ spec }) => spec);
		await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
	}
}

/**
 * Ask about every package in `pending` at once; the ones not yet installable, with the reason.
 *
 * @param {PackageSpec[]} pending
 * @param {(spec: PackageSpec) => Promise<Answer>} probe
 * @returns {Promise<Straggler[]>}
 */
async function askRound(pending, probe) {
	const answers = await Promise.all(pending.map(async (spec) => ({ spec, answer: await probe(spec) })));
	return answers.flatMap(({ spec, answer }) => answer.visible ? [] : [{ spec, reason: answer.reason }]);
}

// -- Reporting -----------------------------------------------------------------------------------

/** @param {number} ms */
function seconds(ms) {
	return `${Math.round(ms / 1000)} s`;
}

/**
 * The single line that says every package is installable.
 *
 * @param {PackageSpec[]} expected
 */
export function successLine(expected) {
	const versions = [...new Set(expected.map(({ version }) => version))].join(', ');
	return `all ${expected.length} packages published and installable from npm at ${versions}\n`;
}

/**
 * One line of waiting: which packages, and why, when the reason is anything but not-there-yet.
 *
 * @param {Progress} progress
 */
export function progressLine({ stragglers, total, elapsedMs }) {
	const names = stragglers.map(({ spec, reason }) => reason === NOT_YET_VISIBLE ? specString(spec) : `${specString(spec)} (${reason})`);
	return `waiting for ${stragglers.length} of ${total} packages to be installable from npm (${seconds(elapsedMs)}): ${names.join(', ')}\n`;
}

/**
 * The report when the deadline passed with packages still not installable. It runs after `yarn pub`
 * and before `release-finish.mjs`, so it says what is already done, what is not, and exactly what
 * is left — never "start over", because re-running `yarn release` would bump a second version.
 *
 * @param {Straggler[]} stragglers
 * @param {number} total
 * @param {number} timeoutMs
 * @param {{ tag?: string }} options  The dist-tag the release published under, if any.
 */
export function timeoutReport(stragglers, total, timeoutMs, { tag }) {
	const lines = [
		`${stragglers.length} of ${total} packages still not installable from npm after ${seconds(timeoutMs)}:`,
		...stragglers.map(({ spec, reason }) => `  ${specString(spec)} — ${reason}`),
		'',
		'npm already accepted the publish, so this is an unfinished release, not a failed one.',
		'Do NOT re-run `yarn release`: it would bump a second version on top of this one.',
		'Nothing has been pushed and no GitHub release has been created.',
		'',
		'Remaining commands, in order:',
		'',
		'  yarn await-published',
		'  node scripts/release-finish.mjs',
		'',
		'If a package above was never published at all (it is still missing long after this deadline),',
		'run `yarn pub` before those two: it skips what is already on npm.',
	];
	if (tag !== undefined) {
		lines.push(
			'',
			`Keep SEREUS_DIST_TAG=${tag} set for each of these commands. The wait checks that dist-tag, and`,
			'release-finish reads it from the environment: without it, the release is treated as `latest`',
			'and can claim GitHub\'s "Latest" badge.',
		);
	}
	lines.push('');
	return lines.join('\n');
}
