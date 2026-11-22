#!/usr/bin/env node
/**
 * Gate: the Markdown documentation stays navigable and readable.
 *
 * Three checks over every Markdown file git knows about (tracked, or untracked and not ignored)
 * outside `tickets/` and `tess/`, and apart from the generated release notes:
 *
 * 1. Links resolve. A relative link, or a `github.com/gotchoices/sereus/blob|tree/master/` link,
 *    must name a file that exists, and a `#fragment` on a Markdown target must name a heading (or
 *    an explicit `<a id>`) in that file. Published package READMEs link to `docs/` by GitHub URL
 *    because relative links are dead on npm, which is why those URLs are checked as local paths.
 *    A link into a path declared as a submodule in `.gitmodules` is refused even when the file is
 *    there: a submodule's directory is empty in a fresh worktree, and GitHub serves nothing under
 *    the parent repository's path for it, so such a link is dead for every reader but this one.
 *
 * 2. Size budgets hold. A document, a paragraph or list item, and a table cell each have a word
 *    limit (`BUDGET` below). A document over its limit is split by topic; a paragraph over its
 *    limit becomes several, or a headed section. Fenced code is not counted. The limits exist
 *    because a document read at the start of every task is paid for on every task, and because an
 *    item that carries ten claims hides nine of them.
 *
 * 3. Directory indexes are complete. A document listed in `INDEXES` promises one entry per file in
 *    a directory; every file there must be named in the document and every name in the document
 *    must be a file there. The topology coverage map is one: an agent reads it to decide whether
 *    a network shape is already tested, so a missing row reads as a missing test.
 *
 * What this gate cannot catch: a link that resolves to the wrong section, a claim that no longer
 * matches the code, or a document that is under budget and still badly organised.
 *
 * Usage: `node scripts/check-docs.mjs [--budgets-only] [file ...]`. With file arguments only those
 * files are checked (paths relative to the repo root); `--budgets-only` skips the link check, for
 * a document whose link targets are still being written.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// CHECK_DOCS_ROOT lets the companion test point the gate at a fixture repo.
const rootDir = process.env.CHECK_DOCS_ROOT
	? resolve(process.env.CHECK_DOCS_ROOT)
	: join(dirname(fileURLToPath(import.meta.url)), '..');

/** Word limits. A document's limit covers prose, list items and tables, not fenced code. */
export const BUDGET = { document: 6000, block: 120, cell: 50 };

/** Documents that index a directory: `pattern` selects the file names both sides must agree on. */
const INDEXES = [
	{
		document: 'docs/contributing/topology-coverage.md',
		directory: 'packages/integration-tests/src/scenarios',
		pattern: /[a-z0-9-]+\.integration\.ts/g,
	},
];

const EXCLUDED_ROOTS = ['tickets/', 'tess/'];
/** Written by the release scripts for the next GitHub release, not read as documentation. */
const EXCLUDED_FILES = new Set(['.release-notes.pending.md']);
const REPO_URL = /^https:\/\/github\.com\/gotchoices\/sereus\/(?:blob|tree)\/master\//;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const EXPLICIT_ANCHOR = /<a\s+(?:id|name)="([^"]+)"/g;

function toPosix(path) {
	return path.split(sep).join('/');
}

function listMarkdownFiles() {
	const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.md'], {
		cwd: rootDir,
		encoding: 'utf8',
	});
	return out
		.split('\n')
		.filter(Boolean)
		.filter(path => !EXCLUDED_ROOTS.some(root => path.startsWith(root)) && !EXCLUDED_FILES.has(path))
		.filter(path => existsSync(join(rootDir, path)));
}

function countWords(text) {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** GitHub's heading-to-fragment rule: lowercase, drop punctuation, spaces to hyphens. */
export function headingSlug(heading) {
	return heading
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*]/g, '')
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s/g, '-');
}

/** Lines outside fenced code, each with its 1-based line number. */
function proseLines(text) {
	const lines = [];
	let fenced = false;
	text.split(/\r?\n/).forEach((line, index) => {
		if (FENCE.test(line)) {
			fenced = !fenced;
			return;
		}
		if (!fenced) lines.push({ line, number: index + 1 });
	});
	return lines;
}

const anchorCache = new Map();
let submodulePathsCache;

/**
 * The submodules declared in `.gitmodules`, read through git's own config parser rather than by
 * hand-parsing the INI. A repository without a `.gitmodules` declares none.
 */
function submodules() {
	if (submodulePathsCache) return submodulePathsCache;
	submodulePathsCache = [];
	if (!existsSync(join(rootDir, '.gitmodules'))) return submodulePathsCache;
	let out;
	try {
		out = execFileSync('git', ['config', '--file', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`], {
			cwd: rootDir,
			encoding: 'utf8',
		});
	} catch (error) {
		// Status 1 is `git config`'s "no key matched": a `.gitmodules` that declares no path. Any
		// other status is a real git failure and is not ours to swallow.
		if (error.status !== 1) throw error;
		return submodulePathsCache;
	}
	for (const line of out.split('\n').filter(Boolean)) {
		const [key, path] = line.split(' ');
		submodulePathsCache.push({ name: key.slice('submodule.'.length, -'.path'.length), path });
	}
	return submodulePathsCache;
}

/** The submodule a resolved link target is at or inside, or `undefined` for a target outside one. */
function submoduleOf(target) {
	const path = toPosix(relative(rootDir, target));
	return submodules().find(submodule => path === submodule.path || path.startsWith(`${submodule.path}/`));
}

function anchorsOf(absPath) {
	if (anchorCache.has(absPath)) return anchorCache.get(absPath);
	const anchors = new Set();
	const seen = new Map();
	for (const { line } of proseLines(readFileSync(absPath, 'utf8'))) {
		const heading = HEADING.exec(line);
		if (heading) {
			const slug = headingSlug(heading[1]);
			const repeats = seen.get(slug) ?? 0;
			seen.set(slug, repeats + 1);
			anchors.add(repeats ? `${slug}-${repeats}` : slug);
		}
		for (const explicit of line.matchAll(EXPLICIT_ANCHOR)) anchors.add(explicit[1]);
	}
	anchorCache.set(absPath, anchors);
	return anchors;
}

/** Resolves a link to an absolute local path, or `undefined` for a link this gate does not check. */
function localTarget(href, fromAbsPath) {
	if (REPO_URL.test(href)) return join(rootDir, decodeURIComponent(href.replace(REPO_URL, '')));
	if (EXTERNAL.test(href)) return undefined;
	if (href === '') return fromAbsPath;
	return resolve(dirname(fromAbsPath), decodeURIComponent(href));
}

function checkLinks(path, lines) {
	const absPath = join(rootDir, path);
	const problems = [];
	for (const { line, number } of lines) {
		for (const match of line.matchAll(LINK)) {
			const [href, fragment] = match[1].split('#');
			const target = localTarget(href, absPath);
			if (target === undefined) continue;
			const submodule = submoduleOf(target);
			if (submodule) {
				problems.push(
					`${path}:${number}: link into the "${submodule.name}" submodule: ${match[1]}. A submodule path is empty in a fresh worktree and 404s on GitHub; link its repository URL instead.`,
				);
			} else if (!existsSync(target)) {
				problems.push(`${path}:${number}: link target does not exist: ${match[1]}`);
			} else if (fragment && target.endsWith('.md') && statSync(target).isFile() && !anchorsOf(target).has(fragment)) {
				problems.push(`${path}:${number}: no heading for #${fragment} in ${toPosix(relative(rootDir, target))}`);
			}
		}
	}
	return problems;
}

function tableCells(line) {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split(/(?<!\\)\|/);
}

/** Groups prose lines into paragraphs and list items; headings and table rows are not blocks. */
function proseBlocks(lines) {
	const blocks = [];
	let current;
	const close = () => {
		if (current) blocks.push(current);
		current = undefined;
	};
	for (const { line, number } of lines) {
		if (!line.trim() || HEADING.test(line) || line.trimStart().startsWith('|')) {
			close();
		} else if (LIST_ITEM.test(line) || !current) {
			close();
			current = { number, text: line };
		} else {
			current.text += ` ${line}`;
		}
	}
	close();
	return blocks;
}

function checkBudgets(path, lines) {
	const problems = [];
	const total = lines.reduce((sum, { line }) => sum + countWords(line), 0);
	if (total > BUDGET.document) {
		problems.push(`${path}: ${total} words; a document is limited to ${BUDGET.document}. Split it by topic.`);
	}
	for (const { number, text } of proseBlocks(lines)) {
		const words = countWords(text);
		if (words > BUDGET.block) {
			problems.push(`${path}:${number}: ${words}-word paragraph or list item; the limit is ${BUDGET.block}.`);
		}
	}
	for (const { line, number } of lines) {
		if (!line.trimStart().startsWith('|')) continue;
		const longest = Math.max(...tableCells(line).map(countWords));
		if (longest > BUDGET.cell) {
			problems.push(`${path}:${number}: ${longest}-word table cell; the limit is ${BUDGET.cell}.`);
		}
	}
	return problems;
}

function checkIndex({ document, directory, pattern }) {
	const documentPath = join(rootDir, document);
	const directoryPath = join(rootDir, directory);
	if (!existsSync(documentPath) || !existsSync(directoryPath)) return [];
	const named = new Set(readFileSync(documentPath, 'utf8').match(pattern) ?? []);
	const present = new Set(readdirSync(directoryPath).filter(name => name.match(pattern)?.[0] === name));
	const problems = [];
	for (const name of present) {
		if (!named.has(name)) problems.push(`${document}: no entry for ${directory}/${name}`);
	}
	for (const name of named) {
		if (!present.has(name)) problems.push(`${document}: names ${name}, which is not in ${directory}`);
	}
	return problems;
}

function main() {
	const args = process.argv.slice(2);
	const budgetsOnly = args.includes('--budgets-only');
	const named = args.filter(arg => !arg.startsWith('--')).map(arg => toPosix(relative(rootDir, resolve(rootDir, arg))));
	const files = named.length ? named : listMarkdownFiles();
	const problems = [];
	for (const path of files) {
		const absPath = join(rootDir, path);
		if (!existsSync(absPath)) {
			problems.push(`${path}: no such file`);
			continue;
		}
		const lines = proseLines(readFileSync(absPath, 'utf8'));
		problems.push(...checkBudgets(path, lines));
		if (!budgetsOnly) problems.push(...checkLinks(path, lines));
	}
	for (const index of INDEXES) {
		if (!budgetsOnly && files.includes(index.document)) problems.push(...checkIndex(index));
	}
	if (problems.length) {
		console.error(problems.join('\n'));
		console.error(`\ncheck-docs: ${problems.length} problem(s) in ${files.length} file(s). Rules: docs/contributing/gates.md → "Documentation".`);
		process.exit(1);
	}
	console.log(`check-docs: ${files.length} Markdown file(s) OK.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
