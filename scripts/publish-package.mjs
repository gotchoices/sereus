#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, '..');

/** A plausible npm dist-tag: not empty, not a flag, not a bare semver version. */
const TAG_SHAPE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * `--tag <name>` on this invocation's own argv beats `SEREUS_DIST_TAG` in the
 * environment, which beats nothing (npm's own `latest` default applies). Both forms
 * are needed: `yarn pub` is six `&&`-ed publishes, so an argv flag appended to the
 * `yarn pub` invocation reaches only the last one. The env var is the only form that
 * tags the whole chain: `SEREUS_DIST_TAG=alpha yarn pub`.
 *
 * NOTE: `yarn pub --tag alpha` therefore tags only `cadre-host`. Today that mis-invocation fails
 * loudly on the first package whenever it matters (a prerelease with no tag trips
 * `assertDistTagForPrerelease`); if the `pub` chain ever stops being a flat `&&` list of
 * per-package scripts, re-check that this is still true.
 */
export function resolveDistTag(argv, env) {
	let tagFromArgv;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg !== '--tag') {
			// A bare word here is almost always a forgotten `--tag` (`yarn pub:cadre-core alpha`),
			// which would otherwise publish under `latest` without a word of complaint.
			const kind = arg.startsWith('--') ? 'unknown flag' : 'unexpected argument';
			throw new Error(`${kind} "${arg}" — expected: --tag <name>`);
		}
		const value = argv[i + 1];
		if (value === undefined || value === '' || value.startsWith('--')) {
			throw new Error('--tag requires a value');
		}
		tagFromArgv = value;
		i++;
	}

	const tag = tagFromArgv ?? (env.SEREUS_DIST_TAG || undefined);
	if (tag === undefined) {
		return undefined;
	}
	assertPlausibleTag(tag);
	return tag;
}

/** Reject anything that is not a plausible npm tag name before it reaches a shell command. */
function assertPlausibleTag(tag) {
	if (!TAG_SHAPE.test(tag)) {
		throw new Error(`dist-tag "${tag}" is not a plausible npm tag name`);
	}
	if (semver.valid(tag)) {
		throw new Error(`dist-tag "${tag}" looks like a version, not a tag name — npm rejects this too`);
	}
}

/**
 * Refuse to publish a prerelease version (`0.10.0-alpha.0`) under no dist-tag at all —
 * that is what `npm install <pkg>` would return. `SEREUS_DIST_TAG=latest` is the
 * deliberate escape hatch: an explicit `latest` is a decision, an absent tag is an
 * oversight, and this is where the two are told apart.
 */
export function assertDistTagForPrerelease(manifestName, version, tag) {
	if (semver.prerelease(version) === null || tag !== undefined) {
		return;
	}
	throw new Error(
		`${manifestName}@${version} is a prerelease, but no dist-tag was given, so it\n` +
		`would be published as \`latest\` — the version \`npm install ${manifestName}\` returns.\n` +
		'  Publish it under a tag:  SEREUS_DIST_TAG=alpha yarn pub\n' +
		'  Or, if `latest` really is intended:  SEREUS_DIST_TAG=latest yarn pub',
	);
}

/** `yarn npm publish` command for the resolved tag — omits `--tag` entirely when there is none,
 * rather than passing an explicit `--tag latest`: publishing the first-ever version of a package
 * with an explicit tag behaves differently from letting npm default. */
export function publishCommand(tag) {
	return tag === undefined
		? 'yarn npm publish --access public'
		: `yarn npm publish --access public --tag ${tag}`;
}

export function readManifest(packageDir) {
	const manifestPath = join(packageDir, 'package.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (!semver.valid(manifest.version)) {
		throw new Error(`"${manifest.version}" in ${manifestPath} is not a valid semver version`);
	}
	return manifest;
}

/**
 * Decide whether the embedded release key is still the all-zeros placeholder by
 * reading PROD_KEY_BASE64 straight from source. This is the byte string the
 * build compiles verbatim into `dist`, so it is exactly what ships.
 *
 * Deliberately ignores `CADRE_HOST_UPDATE_DEV_KEY`: that override is a *runtime*
 * dev/CI affordance that never ships in the package, so it has no bearing on
 * what the published binary will trust. (Reusing the runtime
 * `isPlaceholderReleaseKey`, which honors the override, would let a dev key set
 * on the publish/CI machine silently wave the placeholder through.)
 */
function embeddedKeyIsPlaceholder(dir) {
	const srcPath = join(dir, 'src', 'update', 'release-key.ts');
	const src = readFileSync(srcPath, 'utf8');
	const match = /const PROD_KEY_BASE64 = '([^']*)';/.exec(src);
	if (!match) {
		throw new Error(`Could not locate PROD_KEY_BASE64 in ${srcPath} to verify the release key`);
	}
	const raw = Buffer.from(match[1], 'base64');
	return raw.length === 32 && raw.every((b) => b === 0);
}

/**
 * Refuse to ship a cadre-host build whose embedded release key is still the
 * all-zeros placeholder — such a binary rejects every authentic manifest as
 * signature_invalid, making the update flow dead on arrival. The escape hatch
 * CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1 is for internal/test publishes only.
 */
function assertReleaseKeyEmbedded(dir) {
	if (process.env.CADRE_HOST_ALLOW_PLACEHOLDER_KEY === '1') {
		console.warn('CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1 — skipping release-key placeholder guard.');
		return;
	}
	if (embeddedKeyIsPlaceholder(dir)) {
		throw new Error(
			'the embedded Ed25519 release key is the all-zeros placeholder.\n' +
			'  Generate a real keypair offline: node packages/cadre-host/scripts/release-keygen.mjs --write-source\n' +
			'  Commit the new PROD_KEY_BASE64, re-sign latest.json, then publish.\n' +
			'  To publish anyway (internal/test only), set CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1.',
		);
	}
}

async function main() {
	const packageName = process.argv[2];
	if (!packageName) {
		console.error('Usage: node scripts/publish-package.mjs <package-name> [--tag <dist-tag>]');
		process.exit(1);
	}

	const packageDir = join(rootDir, 'packages', packageName);
	const manifest = readManifest(packageDir);
	const tag = resolveDistTag(process.argv.slice(3), process.env);

	// Fire before `yarn clean && yarn build`: `yarn pub` is six sequential publishes,
	// so a refusal here costs seconds, while one caught after the build of package
	// four (with one..three already on npm under the resolved tag) costs a full
	// rebuild and cannot undo what already published.
	assertDistTagForPrerelease(manifest.name, manifest.version, tag);

	console.log(`Publishing ${manifest.name}@${manifest.version} under dist-tag: ${tag ?? 'latest (npm default)'}`);

	process.chdir(packageDir);

	execSync('yarn clean', { stdio: 'inherit' });
	execSync('yarn build', { stdio: 'inherit' });

	if (packageName === 'cadre-host') {
		assertReleaseKeyEmbedded(packageDir);
	}

	execSync(publishCommand(tag), { stdio: 'inherit' });
}

// Guard so `scripts/publish-package.test.mjs` can `import` the pure functions above
// without triggering a real build-and-publish as a side effect of loading the module.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	main().catch((error) => {
		console.error(`Failed to publish ${process.argv[2]}:`, error.message);
		process.exit(1);
	});
}
