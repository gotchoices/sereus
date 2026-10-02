/**
 * The entry point: check a whole config tree and either return it typed or throw one `Error`
 * listing every problem — an operator fixing a hand-edited file should not have to restart once
 * per typo. Each line names the offending key and its source: the config file, or the
 * environment variable whose write covers that key.
 */

import { type Checker, ValidationContext, isPathPrefix, isPlainObject } from './checkers.js';

export interface ValidateOptions {
  /** Named in every problem the environment did not cause. */
  configPath: string;
  /**
   * Dotted path the environment wrote → the variable that wrote it (`applyEnvOverrides` builds
   * it). A problem at a key is attributed to the variable whose written path is the longest
   * prefix of that key, and to `configPath` when none is.
   */
  provenance?: ReadonlyMap<string, string>;
  /** Variables that could supply a missing key, for "is required" messages. */
  suppliersOf?: (keyPath: string) => readonly string[];
  /**
   * Key paths whose whole subtree holds hand-written secrets (cadre-provider's `push` and
   * `billing`): a rejected value at or under one is described by kind only, never echoed.
   */
  concealUnder?: readonly string[];
}

/**
 * Check `tree` with `root`. An empty file (`undefined`/`null`) is an empty mapping; any other
 * non-mapping top level is one problem. Throws one `Error` whose message lists every problem,
 * one per line, each prefixed `Environment variable X:` or `Config <path>:`.
 */
export function validateTree<T>(tree: unknown, root: Checker<T>, options: ValidateOptions): T {
  const ctx = new ValidationContext(options.suppliersOf, options.concealUnder);
  const checked = checkRoot(tree, root, ctx);
  if (checked === undefined || ctx.problems.length > 0) {
    const provenance = options.provenance ?? new Map<string, string>();
    const lines = ctx.problems.map((p) => `${sourceOf(p.keyPath, provenance, options.configPath)}: ${p.text}`);
    throw new Error(lines.join('\n'));
  }
  return checked;
}

function checkRoot<T>(tree: unknown, root: Checker<T>, ctx: ValidationContext): T | undefined {
  // An empty file parses to undefined/null: an empty mapping, for the environment to fill.
  const value = tree ?? {};
  if (!isPlainObject(value)) {
    return ctx.fail('', `the top level must be a mapping of keys, got ${ctx.describe('', value)}`);
  }
  return root(value, '', ctx);
}

/** The variable that wrote the longest prefix of `keyPath`, else the file. */
function sourceOf(keyPath: string, provenance: ReadonlyMap<string, string>, configPath: string): string {
  let longest = -1;
  let envVar: string | undefined;
  for (const [written, variable] of provenance) {
    if (isPathPrefix(written, keyPath) && written.length > longest) {
      longest = written.length;
      envVar = variable;
    }
  }
  return envVar !== undefined ? `Environment variable ${envVar}` : `Config ${configPath}`;
}
