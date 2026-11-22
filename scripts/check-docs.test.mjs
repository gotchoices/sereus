import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET, headingSlug } from './check-docs.mjs';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'check-docs.mjs');

function words(count) {
	return Array.from({ length: count }, () => 'word').join(' ');
}

/** Runs the gate over a throwaway git repo holding `files`, then removes the repo. */
function run(files, args = []) {
	const root = mkdtempSync(join(tmpdir(), 'check-docs-'));
	try {
		spawnSync('git', ['init', '--quiet'], { cwd: root });
		for (const [relPath, content] of Object.entries(files)) {
			const filePath = join(root, relPath);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, content);
		}
		return spawnSync(process.execPath, [scriptPath, ...args], {
			env: { ...process.env, CHECK_DOCS_ROOT: root },
			encoding: 'utf-8',
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('heading slugs follow the GitHub rule', () => {
	assert.equal(headingSlug('Dial budgets are counted in round trips, not milliseconds'), 'dial-budgets-are-counted-in-round-trips-not-milliseconds');
	assert.equal(headingSlug('Same-named tables in `Strand` and `App`'), 'same-named-tables-in-strand-and-app');
});

test('resolving links and in-budget text pass', () => {
	const result = run({
		'README.md': '# Root\n\nSee [the guide](docs/guide.md#second-part) and [the repo copy](https://github.com/gotchoices/sereus/blob/master/docs/guide.md).\n',
		'docs/guide.md': '# Guide\n\n## Second part\n\nBack to [the root](../README.md).\n',
	});
	assert.equal(result.status, 0, result.stderr);
});

test('a missing file and a missing heading are both reported', () => {
	const result = run({
		'README.md': '# Root\n\n[gone](docs/gone.md) and [no such section](docs/guide.md#absent).\n',
		'docs/guide.md': '# Guide\n',
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /link target does not exist: docs\/gone\.md/);
	assert.match(result.stderr, /no heading for #absent in docs\/guide\.md/);
});

test('fenced code is neither link-checked nor counted', () => {
	const result = run({
		'README.md': `# Root\n\n\`\`\`md\n[gone](docs/gone.md) ${words(BUDGET.block + 1)}\n\`\`\`\n`,
	});
	assert.equal(result.status, 0, result.stderr);
});

test('an oversized paragraph, list item, table cell and document are each reported', () => {
	const result = run({
		'paragraph.md': `# P\n\n${words(BUDGET.block + 1)}\n`,
		'item.md': `# I\n\n- short\n- ${words(BUDGET.block + 1)}\n`,
		'cell.md': `# C\n\n| a | b |\n|---|---|\n| x | ${words(BUDGET.cell + 1)} |\n`,
		'document.md': `# D\n\n${Array.from({ length: BUDGET.document / 100 + 1 }, () => words(100)).join('\n\n')}\n`,
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /paragraph\.md:3: \d+-word paragraph or list item/);
	assert.match(result.stderr, /item\.md:4: \d+-word paragraph or list item/);
	assert.match(result.stderr, /cell\.md:5: \d+-word table cell/);
	assert.match(result.stderr, /document\.md: \d+ words; a document is limited to/);
});

test('tickets and tess are outside the gate, and --budgets-only skips links', () => {
	const broken = '# T\n\n[gone](gone.md)\n';
	assert.equal(run({ 'tickets/backlog/t.md': broken, 'tess/README.md': broken }).status, 0);
	assert.equal(run({ 'docs/a.md': broken }, ['--budgets-only']).status, 0);
	assert.equal(run({ 'docs/a.md': broken }).status, 1);
});

test('a directory index must name every file in its directory, and only those', () => {
	const scenarios = 'packages/integration-tests/src/scenarios';
	const index = 'docs/contributing/topology-coverage.md';
	const files = { [`${scenarios}/a.integration.ts`]: '', [`${scenarios}/b.integration.ts`]: '', [`${scenarios}/helper.ts`]: '' };
	const complete = run({ ...files, [index]: '# Map\n\n| `a.integration.ts` |\n| `b.integration.ts` |\n' });
	assert.equal(complete.status, 0, complete.stderr);
	const stale = run({ ...files, [index]: '# Map\n\n| `a.integration.ts` |\n| `gone.integration.ts` |\n' });
	assert.equal(stale.status, 1);
	assert.match(stale.stderr, /no entry for .*b\.integration\.ts/);
	assert.match(stale.stderr, /names gone\.integration\.ts, which is not in/);
});

test('a link into a submodule is refused even with the target present on disk', () => {
	// The main checkout has the submodule populated, which is how these links shipped: `existsSync`
	// is satisfied there, while a fresh worktree gets an empty directory and GitHub serves nothing.
	const result = run({
		'.gitmodules': '[submodule "rules"]\n\tpath = vendor/rules\n\turl = https://example.invalid/rules.git\n',
		'vendor/rules/guide.md': '# Guide\n',
		'README.md': '# Root\n\n[the guide](vendor/rules/guide.md)\n\n[the submodule](vendor/rules/)\n',
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /README\.md:3: link into the "rules" submodule: vendor\/rules\/guide\.md/);
	assert.match(result.stderr, /README\.md:5: link into the "rules" submodule: vendor\/rules\//);
});
