/**
 * Decisions shared by the four steps of a release — `release-preflight.mjs`, `release-guard.mjs`,
 * `publish-package.mjs` and `release-finish.mjs`. They live here rather than in any one of those
 * scripts because the whole point of the chain is that the steps cannot disagree: if the preflight
 * decides the pending notes are empty, the finish step must agree about which file it reads, and if
 * the guard decides a version is already on npm, the publish must skip exactly that version.
 *
 * Everything here is either a pure function of its inputs or a thin wrapper around one, so
 * `scripts/release-support.test.mjs` can exercise the decisions without a network or a git tree.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file rather than from the process's working directory. */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The notes a release ships as its GitHub release body. Repo-relative; both scripts use this name. */
export const PENDING_NOTES_FILE = '.release-notes.pending.md';

/** What the pending-notes file is reset to once a release has consumed it. */
export const EMPTY_NOTES_HEADER = '# Release notes — pending\n';

/**
 * `SEREUS_GH_RELEASE=0` is the single escape hatch for everything GitHub-release-shaped: the
 * preflight's `gh auth` and pending-notes refusals, the finish step's `gh release create`, and the
 * notes reset that follows it. One hatch rather than one per check, so "skip the GitHub release" is
 * a single decision the operator makes once and the whole chain reads the same way.
 */
export function ghReleaseEnabled(environment) {
	const raw = environment['SEREUS_GH_RELEASE'];
	return !(raw === '0' || raw === 'false');
}

/**
 * Whether the pending-notes file says anything at all beyond its heading.
 *
 * Decided by structure, not by length: a byte-count threshold is defeated by a trailing newline or
 * a heading that happens to be long, and the question being asked is "did someone write notes",
 * which is exactly "is there a non-blank line after the first heading".
 */
export function notesHaveContent(text) {
	if (typeof text !== 'string') {
		return false;
	}
	const lines = text.split(/\r?\n/);
	let index = 0;
	while (index < lines.length && lines[index].trim() === '') {
		index++;
	}
	// Skip the leading heading if there is one; notes with no heading at all are still notes.
	if (index < lines.length && lines[index].trimStart().startsWith('#')) {
		index++;
	}
	return lines.slice(index).some((line) => line.trim() !== '');
}

/**
 * Whether the pending-notes file is already back to its empty header, so a second `--notes-only`
 * run reports "nothing to do" instead of trying to commit an unchanged file and failing.
 *
 * Line endings are normalized first: this repo runs with `core.autocrlf=true` and no
 * `.gitattributes`, so a fresh checkout hands back CRLF for a file git stores with LF, and a
 * byte-for-byte comparison would call an already-reset file "changed".
 */
export function notesAreReset(text) {
	return typeof text === 'string' && text.replace(/\r\n/g, '\n') === EMPTY_NOTES_HEADER;
}

/** The registry a publish will reach, so the "already published?" probe asks the same one. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * The packument URL for a package name. Scoped names carry a `/` that has to be percent-encoded,
 * or the registry reads it as a path segment and answers 404 for a package that exists.
 */
export function registryUrl(name, environment = process.env) {
	const configured = environment['SEREUS_NPM_REGISTRY'] || environment['npm_config_registry'];
	const base = (configured && configured.trim() !== '' ? configured.trim() : DEFAULT_REGISTRY).replace(/\/+$/, '');
	return `${base}/${name.replace('/', '%2f')}`;
}

/**
 * Decide, from a completed packument fetch, whether `version` is already on the registry.
 *
 * A 404 is a real answer — the package has never been published, so this version is not on it.
 * Every other non-200 is an *unknown* answer and throws. "Could not reach the registry" and "this
 * version does not exist" are different facts, and conflating them is how an outage turns into an
 * attempted republish (or, worse, into a publish that is silently skipped).
 */
export function interpretPackument({ status, body }, name, version) {
	if (status === 404) {
		return false;
	}
	if (status !== 200) {
		throw new Error(
			`registry lookup for ${name} answered HTTP ${status}, so whether ${name}@${version} is ` +
			'already published is unknown. Refusing to guess — re-run once the registry answers.',
		);
	}
	let packument;
	try {
		packument = JSON.parse(body);
	} catch (cause) {
		throw new Error(`registry returned a body for ${name} that is not JSON: ${cause.message}`, { cause });
	}
	const versions = packument?.versions;
	if (versions === null || typeof versions !== 'object') {
		throw new Error(`registry response for ${name} has no \`versions\` map, so it cannot be read`);
	}
	return Object.prototype.hasOwnProperty.call(versions, version);
}

/**
 * Whether `name@version` is already on the registry.
 *
 * Deliberately an HTTPS fetch rather than shelling out to `npm view`: node refuses to spawn the
 * `npm.cmd` shim without a shell on Windows (this repo's primary shell), and routing a package name
 * through a shell to work around that is exactly what the rest of this chain avoids.
 */
export async function registryHasVersion(name, version, { fetchImpl = fetch, environment = process.env } = {}) {
	const url = registryUrl(name, environment);
	let response;
	try {
		response = await fetchImpl(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
	} catch (cause) {
		throw new Error(
			`could not reach the npm registry at ${url} to check whether ${name}@${version} is already ` +
			`published: ${cause.message}\n` +
			'  That is not the same answer as "not published", so nothing is being skipped or republished.',
			{ cause },
		);
	}
	return interpretPackument({ status: response.status, body: await response.text() }, name, version);
}
