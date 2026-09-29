/**
 * Writing environment variables over a parsed config tree, before the tree is checked.
 *
 * The caller owns the variable names and what each one writes (an {@link EnvOverride} per
 * variable); this module owns how a write lands: which values count as set, how a dotted path is
 * written without touching the caller's objects, and the record of which variable wrote which
 * path, so `validateTree` can blame the variable rather than the file.
 */

import { describeValue, isPlainObject } from './checkers.js';

export interface EnvOverride {
  /** Dotted config path the variable writes, over whatever the config file says there. */
  readonly path: string;
  /** Text → value written at `path`; throws naming `name` when the text cannot be read. */
  readonly parse: (text: string, name: string) => unknown;
}

/** What {@link applyEnvOverrides} produces: the merged tree and a record of what the environment wrote. */
export interface OverrideResult {
  /** The file's tree with every set variable written over it. Unchecked. */
  tree: unknown;
  /**
   * Dotted config path → the variable that wrote it (cadre-cli: `network.listenAddrs → CADRE_LISTEN_ADDRS`,
   * `push → CADRE_PUSH`), so the validator attributes a problem under that path to the
   * variable rather than to the file. A skipped (empty) variable records nothing.
   */
  provenance: ReadonlyMap<string, string>;
}

/**
 * The variable's value, or `undefined` when it is not specified. An empty or whitespace-only
 * value counts as not specified: a docker-compose default like cadre-cli's `${CADRE_ENABLE_RELAY:-}` must
 * leave the config file's value (or the profile default) alone, and a variable set that way is
 * not checked by name either.
 */
export function specifiedEnv(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * Write every specified variable in `overrides` over `raw`, in the table's order. `raw` itself
 * is not modified. `onApply` sees each variable about to be written, for logging; the text may
 * be a secret.
 */
export function applyEnvOverrides(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, EnvOverride>>,
  onApply?: (variable: string, text: string) => void,
): OverrideResult {
  const provenance = new Map<string, string>();

  // An empty file parses to undefined/null: an empty mapping the environment may fill. Any
  // other non-mapping root is left for the validator to reject by name — nothing can be
  // written over it.
  const base = raw ?? {};
  if (!isPlainObject(base)) return { tree: raw, provenance };
  const result: Record<string, unknown> = { ...base };

  for (const [variable, { path, parse }] of Object.entries(overrides)) {
    const text = specifiedEnv(env[variable]);
    if (text === undefined) continue;

    onApply?.(variable, text);
    setNestedValue(result, path, parse(text, variable), variable);
    provenance.set(path, variable);
  }

  return { tree: result, provenance };
}

/**
 * Write `value` at a dotted path, copying each intermediate object on the way
 * down. {@link applyEnvOverrides} only shallow-copies its input, so
 * writing straight through would mutate the caller's own nested objects (e.g. a
 * shared `network` block) rather than only the returned config.
 */
function setNestedValue(obj: Record<string, unknown>, pathStr: string, value: unknown, envVar: string): void {
  const parts = pathStr.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const branch = cloneBranch(current[parts[i]], parts.slice(0, i + 1).join('.'), envVar);
    current[parts[i]] = branch;
    current = branch;
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Shallow-copy an intermediate config object. Absent or `null` (YAML `storage:` with no
 * children) starts a fresh block. Anything else in the way — `storage: file` where a block
 * belongs — is a file error the variable must not paper over by replacing it with `{}`.
 */
function cloneBranch(existing: unknown, keyPath: string, envVar: string): Record<string, unknown> {
  if (existing === undefined || existing === null) return {};
  if (isPlainObject(existing)) return { ...existing };
  // NOTE: this echoes the scalar in the way, before validation and so before `concealUnder`
  // applies. A secret can reach it only when the file puts one where a block belongs AND a
  // variable writes under that block (cadre-provider: `billing: sk_live_…` plus
  // STRIPE_SECRET_KEY). If that ever shows up in a real report, take a conceal list here too.
  throw new Error(
    `Cannot apply ${envVar}: config key ${keyPath} is ${describeValue(existing)} where a mapping of keys was expected`,
  );
}

// ---------------------------------------------------------------------------
// Value parsers for `EnvOverride.parse`; `text` is never empty (see specifiedEnv)
// ---------------------------------------------------------------------------

/**
 * A comma-separated list, each entry trimmed, empty entries dropped.
 *
 * NOTE: a separators-only value (e.g. `,`) survives the empty check but yields [], clobbering
 * the file's list. If that shape ever shows up in a real launcher, treat an all-empty split as
 * unspecified here too.
 */
export function parseListEnv(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

const BOOLEAN_SPELLINGS = new Map<string, boolean>([
  ['true', true],
  ['1', true],
  ['false', false],
  ['0', false],
]);

export function parseBooleanEnv(text: string, name: string): boolean {
  const parsed = BOOLEAN_SPELLINGS.get(text.trim().toLowerCase());
  if (parsed === undefined) {
    throw new Error(`Invalid ${name} ${JSON.stringify(text)}: expected true, false, 1 or 0`);
  }
  return parsed;
}

export function parseNumberEnv(text: string, name: string): number {
  const parsed = Number(text.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name} ${JSON.stringify(text)}: expected a number`);
  }
  return parsed;
}
