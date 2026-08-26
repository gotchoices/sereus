import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'check-stale-build-guard-wiring.mjs');

// NOTE: every case spawns the gate, which boots Vitest once per fixture package — around half a
// second each. Fine at this size; share a fixture root if the suite ever grows past a minute.
function makeFixture(packages) {
	const root = mkdtempSync(join(tmpdir(), 'stale-build-guard-wiring-'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*'] }));
	mkdirSync(join(root, 'packages'), { recursive: true });
	for (const [name, files] of Object.entries(packages)) {
		const dir = join(root, 'packages', name);
		mkdirSync(dir, { recursive: true });
		for (const [relPath, content] of Object.entries(files)) {
			const filePath = join(dir, relPath);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, content);
		}
	}
	return root;
}

function run(root) {
	try {
		return spawnSync(process.execPath, [scriptPath], {
			env: { ...process.env, STALE_BUILD_GUARD_WIRING_CHECK_ROOT: root },
			encoding: 'utf-8',
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const SETUP = "import { assertFreshBuilds } from '../../../test-harness/build-freshness.js';\nexport default async function () { await assertFreshBuilds([]); }\n";
const manifest = (name) => JSON.stringify({ name, version: '0.0.0' });

test('passes when the setup module importing the harness is in globalSetup', () => {
	const result = run(makeFixture({
		wired: {
			'package.json': manifest('@fixture/wired'),
			'vitest.config.ts': "export default { test: { globalSetup: ['./test/global-setup.ts'] } };\n",
			'test/global-setup.ts': SETUP,
		},
	}));
	assert.equal(result.status, 0, result.stderr);
});

test('fails, naming the package and the file, when the globalSetup line is removed', () => {
	const result = run(makeFixture({
		unwired: {
			'package.json': manifest('@fixture/unwired'),
			// The setup file is still on disk and still imports the harness — exactly the state a
			// deleted `globalSetup` line leaves behind, which nothing else in the repo notices.
			'vitest.config.ts': "export default { test: {} };\n",
			'test/global-setup.ts': SETUP,
		},
	}));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /@fixture\/unwired/);
	assert.match(result.stderr, /test\/global-setup\.ts/);
	assert.match(result.stderr, /globalSetup/);
});

test('ignores a package that never imports the harness', () => {
	const result = run(makeFixture({
		plain: {
			'package.json': manifest('@fixture/plain'),
			'vitest.config.ts': "export default { test: {} };\n",
			'test/global-setup.ts': "export default async function () {};\n",
		},
	}));
	assert.equal(result.status, 0, result.stderr);
});

test('does not mistake prose about the harness for a use of it', () => {
	const result = run(makeFixture({
		mentions: {
			'package.json': manifest('@fixture/mentions'),
			// Several real configs explain in a comment WHY they wire the guard. A gate that
			// matched a bare substring would fail them.
			'vitest.config.ts': "// This suite runs compiled output, so build-freshness matters.\nexport default { test: {} };\n",
			'test/notes.ts': "// see test-harness/build-freshness.ts for what it compares\nexport const notes = 1;\n",
		},
	}));
	assert.equal(result.status, 0, result.stderr);
});
