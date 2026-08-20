/**
 * Drift guard for the README's `## CLI reference` section.
 *
 * The section is hand-maintained prose, one `### ` heading per command, and
 * nothing used to check it against the commander program in `../host.ts` — so
 * the whole `cadre-host push` group shipped undocumented. This test compares
 * the two in both directions.
 *
 * Scope is deliberately narrow: **presence of a heading only**. A heading's
 * command path must name a real command, and every leaf command must have a
 * heading. The flag list inside a heading is *not* validated — doing so would
 * turn a wording tweak into a red build for no correctness gain.
 *
 * NOTE: a heading advertising a flag the CLI no longer accepts therefore slips
 * through; if that drift is ever observed in practice, compare the bracketed
 * tokens against `cmd.options` rather than widening the parse.
 *
 * NOTE: every `### ` heading inside the section must be a command reference —
 * the malformed-heading assertion is a hard failure, not a skip. Explanatory
 * prose belongs in the section preamble or under a different `## ` section.
 *
 * Importing `../host.js` is inert: its module scope only builds the commander
 * tree and reads `package.json` for `.version()`. Nothing spawns, binds, or
 * exits until an action fires, and `parseAsync()` is gated behind an
 * entry-point check. The counter-guard for that gate is
 * `src/__tests__/cli.smoke.test.ts`, which spawns `dist/bin/host.js --help` as
 * a child process — run `yarn workspace @serfab/cadre-host build:server`
 * before the suite so it checks the current source.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';

import { program } from '../host.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..', '..');
const readmePath = resolve(packageRoot, 'README.md');
const packageJsonPath = resolve(packageRoot, 'package.json');

/** Commander's implicit `help [command]` is never documented in the README. */
const IMPLICIT_HELP = 'help';

interface CommandNode {
  /** Space-joined path below `cadre-host`, e.g. `push fcm`, `nat ddns set`. */
  path: string;
  /** True when the command is a *visible leaf* — no subcommands, not hidden. */
  requiresHeading: boolean;
}

/**
 * Walk the commander tree, collecting every command's path.
 *
 * `visible` tracks whether the command is reachable in `--help` output:
 * a `.hidden()` command (or anything under one) is *allowed* a README heading
 * but never *required* to have one, so hiding a command doesn't force a doc
 * edit in the same commit.
 */
function collectCommands(cmd: Command, prefix: string[] = [], visible = true): CommandNode[] {
  const visibleChildren = new Set(cmd.createHelp().visibleCommands(cmd));
  const out: CommandNode[] = [];
  for (const child of cmd.commands) {
    if (child.name() === IMPLICIT_HELP) continue;
    const path = [...prefix, child.name()];
    const childVisible = visible && visibleChildren.has(child);
    const subcommands = child.commands.filter((c) => c.name() !== IMPLICIT_HELP);
    out.push({ path: path.join(' '), requiresHeading: subcommands.length === 0 && childVisible });
    out.push(...collectCommands(child, path, childVisible));
  }
  return out;
}

interface ReadmeHeading {
  /** The raw `### ` line, for failure messages. */
  line: string;
  /** Space-joined command path below `cadre-host`, or null when unparseable. */
  path: string | null;
}

/**
 * Slice the README between `## CLI reference` and the next `## ` heading, and
 * return every `### ` heading found there.
 *
 * Throws when the section is missing rather than returning an empty list — an
 * absent or renamed section must fail loudly, not pass vacuously.
 */
function readCliReferenceHeadings(): ReadmeHeading[] {
  // Split on /\r?\n/ — this repo is developed on Windows and a bare \n split
  // leaves a \r glued to the end of every heading.
  const lines = readFileSync(readmePath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '## CLI reference');
  if (start === -1) {
    throw new Error(`No "## CLI reference" heading in ${readmePath} — was the section renamed or removed?`);
  }
  // The section ends at the next `## ` heading. Anchor on `^## ` rather than a
  // literal title: the following heading contains backticks today.
  const rest = lines.slice(start + 1);
  const relativeEnd = rest.findIndex((l) => /^## /.test(l));
  const section = relativeEnd === -1 ? rest : rest.slice(0, relativeEnd);

  return section.filter((l) => l.startsWith('### ')).map((line) => ({ line, path: parseHeading(line) }));
}

/**
 * Extract the command path from a heading of the shape
 * ``### `cadre-host <path...> [flags]` ``.
 *
 * Returns null when the heading doesn't match — malformed headings are
 * reported as a failure, never silently skipped, because silent skipping is
 * exactly how the section rots.
 */
function parseHeading(line: string): string | null {
  const code = /^###\s+`([^`]+)`\s*$/.exec(line)?.[1];
  if (!code) return null;
  const tokens = code.trim().split(/\s+/);
  if (tokens[0] !== 'cadre-host') return null;
  const path: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith('<') || token.startsWith('[') || token.startsWith('-')) break;
    path.push(token);
  }
  return path.length > 0 ? path.join(' ') : null;
}

describe('README CLI reference matches the commander tree', () => {
  const commands = collectCommands(program);
  const headings = readCliReferenceHeadings();
  const documented = new Set(headings.map((h) => h.path).filter((p): p is string => p !== null));

  it('has a heading for every leaf command', () => {
    const missing = commands
      .filter((c) => c.requiresHeading && !documented.has(c.path))
      .map((c) => `cadre-host ${c.path}`);
    expect(
      missing,
      `Commands with no "### " heading under "## CLI reference" in ${readmePath}:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no heading for a command that does not exist', () => {
    const known = new Set(commands.map((c) => c.path));
    const ghosts = [...documented].filter((p) => !known.has(p)).map((p) => `cadre-host ${p}`);
    expect(
      ghosts,
      `Headings under "## CLI reference" in ${readmePath} naming commands the CLI does not accept:\n  ${ghosts.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no malformed headings in the section', () => {
    const malformed = headings.filter((h) => h.path === null).map((h) => h.line);
    expect(
      malformed,
      'Headings under "## CLI reference" must have the shape "### `cadre-host <path...> [flags]`":\n  ' +
        malformed.join('\n  '),
    ).toEqual([]);
  });
});

describe('CLI version', () => {
  it('reports the version from package.json', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
    expect(program.version()).toBe(pkg.version);
  });
});
