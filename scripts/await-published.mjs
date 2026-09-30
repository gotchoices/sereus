#!/usr/bin/env node
/**
 * Post-publish wait — the step of `yarn release` between `yarn pub` and `release-finish.mjs`, and
 * runnable on its own as `yarn await-published`.
 *
 * `yarn pub` returns once npm has accepted each publish, but the registry starts serving each
 * package at its own moment, and a version's record and its tarball become downloadable at
 * different moments too: after the 1.8.0 publish the version records answered while three
 * tarballs were still 404, so a fresh `cadre-cli` install failed. The push and the GitHub release
 * announce a release, so the chain waits here until every package `yarn pub` publishes can actually
 * be installed.
 *
 * A package counts as installable once one probe finds all three of:
 *   1. its abbreviated packument (the document installers read) lists the version;
 *   2. that packument's `dist-tags[<tag>]` is the version, so `npm install <name>` returns it;
 *   3. a GET of the version's tarball answers 200.
 *
 * Re-run it on its own at any time: it only reads the registry, and it reports on the versions the
 * manifests name now. This file is the fetches and the printing; the decisions are in
 * `scripts/lib/published-visibility.mjs`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
	WAIT_SECONDS_ENV,
	expectedPackages,
	progressLine,
	publishedPackageDirs,
	readPackumentAnswer,
	readTarballAnswer,
	specString,
	successLine,
	timeoutReport,
	waitForVisibility,
	waitTimeoutMs,
} from './lib/published-visibility.mjs';
import { registryUrl, repoRoot } from './lib/release-support.mjs';
import { resolveDistTag } from './publish-package.mjs';

const INTERVAL_MS = 5_000;
/** One request's bound, so a single stalled fetch cannot outlast the whole deadline. */
const FETCH_TIMEOUT_MS = 30_000;
/** An unchanged waiting line is repeated this often, so a long wait does not look hung. */
const HEARTBEAT_MS = 30_000;

// NOTE: `cache-control: no-cache` may let the wait see the registry's origin before every CDN edge
// does. If a customer install is ever seen to resolve an old version after this wait reported
// success, drop `no-cache` (so the wait sees what an ordinary client sees) or add a short settle
// delay before reporting success.
const NO_CACHE = { 'cache-control': 'no-cache' };
const PACKUMENT_HEADERS = { ...NO_CACHE, accept: 'application/vnd.npm.install-v1+json' };

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function releasePackages() {
	const dirs = publishedPackageDirs(readJson(join(repoRoot, 'package.json')).scripts ?? {});
	return expectedPackages(dirs, (dir) => readJson(join(repoRoot, 'packages', dir, 'package.json')));
}

/**
 * GET `url`, bounded by `FETCH_TIMEOUT_MS`, and hand the response to `read`. A network failure or a
 * timeout comes back as `unreachable` rather than thrown: this round could not ask, and the next
 * round asks again. Only the fetch and the body read sit inside the catch, so an answer the
 * registry did give but this script cannot read still throws and stops the wait.
 *
 * @template T
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {(response: Response) => Promise<T>} read
 * @returns {Promise<{ result: T } | { unreachable: { visible: false, reason: string } }>}
 */
async function fetchWith(url, headers, read) {
	try {
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		return { result: await read(response) };
	} catch (err) {
		const detail = err.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
		return { unreachable: { visible: false, reason: `could not reach ${url}: ${detail}` } };
	}
}

async function readBody(response) {
	return { status: response.status, body: await response.text() };
}

/** The status alone: the body is cancelled unread, so no probe downloads a tarball. */
async function readStatus(response) {
	await response.body?.cancel();
	return response.status;
}

/**
 * Whether `spec` is installable under `tag`: the packument first, and the tarball only once the
 * packument lists the version under that tag. GET rather than HEAD for the tarball, so nothing
 * depends on whether the registry's CDN answers HEAD for tarballs.
 */
async function probe(spec, tag) {
	const packument = await fetchWith(registryUrl(spec.name, env), PACKUMENT_HEADERS, readBody);
	if ('unreachable' in packument) return packument.unreachable;
	const listed = readPackumentAnswer(packument.result, spec, tag);
	if (!('tarball' in listed)) return listed;
	const tarball = await fetchWith(listed.tarball, NO_CACHE, readStatus);
	return 'unreachable' in tarball ? tarball.unreachable : readTarballAnswer(tarball.result);
}

/** Prints a waiting line when the stragglers or their reasons change, and at least every `HEARTBEAT_MS`. */
function progressPrinter() {
	let lastKey;
	let lastAt = -Infinity;
	return (progress) => {
		const key = progress.stragglers.map(({ spec, reason }) => `${specString(spec)} ${reason}`).join('\n');
		if (key === lastKey && progress.elapsedMs - lastAt < HEARTBEAT_MS) return;
		lastKey = key;
		lastAt = progress.elapsedMs;
		stdout.write(progressLine(progress));
	};
}

function printHelp() {
	stdout.write('Usage: node scripts/await-published.mjs [--tag <dist-tag>]\n\n');
	stdout.write('Waits until every package `yarn pub` publishes is installable from npm at the version in its\n');
	stdout.write('package.json: listed in the packument, carrying the dist-tag, and its tarball downloadable.\n');
	stdout.write('The dist-tag defaults to SEREUS_DIST_TAG, then `latest`. Exits non-zero, naming the packages\n');
	stdout.write(`still missing, when the deadline passes first (default 600 s; set ${WAIT_SECONDS_ENV}).\n`);
	stdout.write('Only reads the registry, so it is safe to re-run. See docs/releasing.md.\n');
}

async function main() {
	const tag = resolveDistTag(argv.slice(2), env);
	const deadline = waitTimeoutMs(env);
	// NOTE: inside `yarn release` the setup above and below runs after the publish, so a refusal here
	// (an unreadable `pub` step, a bad wait setting) stops an already-published release. If one ever
	// does, check these inputs in `release-guard.mjs` too, so they refuse before anything is published.
	const expected = releasePackages();
	stdout.write(`await-published: waiting up to ${deadline / 1000} s for ${expected.length} packages under dist-tag ${tag ?? 'latest'}: ${expected.map(specString).join(', ')}\n`);
	const stragglers = await waitForVisibility({
		expected,
		probe: (spec) => probe(spec, tag),
		timeoutMs: deadline,
		intervalMs: INTERVAL_MS,
		now: () => Date.now(),
		sleep,
		onProgress: progressPrinter(),
	});
	if (stragglers.length > 0) {
		stderr.write(timeoutReport(stragglers, expected.length, deadline, { tag }));
		return 1;
	}
	stdout.write(successLine(expected));
	return 0;
}

if (argv.includes('--help') || argv.includes('-h')) {
	printHelp();
	exit(0);
}

exit(await main().catch((error) => {
	stderr.write(`await-published: ${error.message}\n`);
	stderr.write('If this ran inside `yarn release`, npm already has the packages: do NOT re-run `yarn release`.\n');
	stderr.write('Fix the above, then run `yarn await-published` and `node scripts/release-finish.mjs`.\n');
	return 1;
}));
