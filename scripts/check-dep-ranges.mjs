#!/usr/bin/env node
/**
 * Gate: every workspace package's declared dependency range on a `resolutions`-linked
 * package must admit the version of the linked sibling workspace it actually builds
 * and tests against. Development resolves those packages to `link:../<repo>/...`
 * siblings, so nothing here ever exercises the version a registry consumer installs
 * except the declared range itself. See tickets/fix/0.2-debt-declared-dep-range-drift-gate.md
 * and docs/STATUS.md "Declared dependency range vs linked workspace".
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

// DEP_RANGE_CHECK_ROOT lets check-dep-ranges.test.mjs point the gate at a fixture
// workspace instead of this repo, without copying the script around.
const rootDir = process.env.DEP_RANGE_CHECK_ROOT
	? process.env.DEP_RANGE_CHECK_ROOT
	: join(dirname(fileURLToPath(import.meta.url)), '..');
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

// NOTE: coverage is exactly the set of `link:` resolutions. A dependency on a sibling package
// that has no `link:` resolution installs from the registry, so there is no local version to
// drift from and nothing to check — but it also means the gate is silent about it.
function linkedVersions(resolutions) {
	const versions = {};
	const skipped = [];
	for (const [name, target] of Object.entries(resolutions)) {
		if (!target.startsWith('link:')) {
			continue;
		}
		const linkPath = join(rootDir, target.slice('link:'.length));
		const manifestPath = join(linkPath, 'package.json');
		if (!existsSync(manifestPath)) {
			skipped.push({ name, linkPath });
			continue;
		}
		versions[name] = readJson(manifestPath).version;
	}
	return { versions, skipped };
}

// NOTE: only scans `packages/*`, which is exactly the root `workspaces` globs today. If a
// second workspace glob is ever added, teach this to read `workspaces` instead.
function workspacePackages(root) {
	const packagesDir = join(root, 'packages');
	if (!existsSync(packagesDir)) {
		return [];
	}
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(packagesDir, entry.name, 'package.json'))
		.filter((path) => existsSync(path));
}

// `semver.gtr`/`ltr` throw on an unparseable range or version (e.g. a `workspace:^` or
// `catalog:` protocol range, or a sibling manifest with a malformed version), so the
// unparseable cases are reported as their own failure rather than crashing the gate.
function direction(linkedVersion, range) {
	if (!semver.validRange(range)) {
		return `declared range "${range}" is not a semver range, so it cannot be checked against the linked workspace`;
	}
	if (!semver.valid(linkedVersion)) {
		return `linked workspace version "${linkedVersion}" is not a valid semver version`;
	}
	if (semver.gtr(linkedVersion, range)) {
		return 'declared range is too old — it excludes the linked workspace version already built and tested here';
	}
	if (semver.ltr(linkedVersion, range)) {
		return 'declared range is newer than the linked workspace — local development is behind what is promised';
	}
	return 'declared range does not admit the linked workspace version';
}

function main() {
	const root = readJson(join(rootDir, 'package.json'));
	const resolutions = root.resolutions ?? {};
	const { versions, skipped } = linkedVersions(resolutions);

	for (const { name, linkPath } of skipped) {
		console.log(`skip: ${name} — linked workspace not found at ${linkPath}`);
	}

	if (Object.keys(versions).length === 0) {
		console.log('check-dep-ranges: no linked sibling workspaces resolved; nothing to check.');
		return 0;
	}

	const failures = [];
	for (const manifestPath of workspacePackages(rootDir)) {
		const manifest = readJson(manifestPath);
		for (const field of DEP_FIELDS) {
			const deps = manifest[field];
			if (!deps) {
				continue;
			}
			for (const [depName, range] of Object.entries(deps)) {
				const linkedVersion = versions[depName];
				if (linkedVersion === undefined) {
					continue;
				}
				if (semver.satisfies(linkedVersion, range)) {
					continue;
				}
				failures.push({
					manifestPath,
					packageName: manifest.name,
					field,
					depName,
					range,
					linkedVersion,
					reason: direction(linkedVersion, range),
					suggestion: semver.valid(linkedVersion) ? `^${linkedVersion}` : null,
				});
			}
		}
	}

	if (failures.length === 0) {
		console.log(`check-dep-ranges: all declared ranges admit their linked workspace version (${Object.keys(versions).length} linked package(s)).`);
		return 0;
	}

	console.error('check-dep-ranges: declared range drift found:\n');
	for (const failure of failures) {
		console.error(`  ${failure.packageName} (${failure.manifestPath})`);
		console.error(`    ${failure.field}["${failure.depName}"] = "${failure.range}" — linked workspace is ${failure.linkedVersion}`);
		console.error(`    ${failure.reason}`);
		if (failure.suggestion) {
			console.error(`    suggested edit: "${failure.depName}": "${failure.suggestion}"`);
		}
		console.error('');
	}
	console.error(`${failures.length} declared range(s) do not admit their linked workspace version.`);
	return 1;
}

process.exit(main());
