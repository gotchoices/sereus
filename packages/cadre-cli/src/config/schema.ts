/**
 * Strict validation of the node configuration tree.
 *
 * `validateConfig` runs once, on the file's tree with the environment already written over
 * it, and either returns a complete `CliConfig` or throws one `Error` listing every problem
 * — an operator fixing a hand-edited file should not have to restart once per typo. Each
 * line names the offending key and its source: the config file, or the `CADRE_*` variable
 * whose write covers that key.
 *
 * The validator owns *shape*: which keys exist, their types, closed value sets, integer-ness,
 * non-emptiness of identifiers and paths. Range checks that already fail loudly downstream
 * stay there and are not repeated here (multiaddr syntax and transport support, the
 * `*Ms` network values being above zero, push credential completeness).
 *
 * There is no schema library and no generic schema interpreter. Each object level is a
 * `FieldTable<T>` — one small checker per key — typed against the TypeScript type it
 * validates, so the compiler, not a test, catches a key added to the type without a checker
 * or a checker for a key the type lacks. The accepted-key set at runtime is the table's own
 * keys, which is also what the unknown-key error and its typo suggestion are drawn from.
 */

import type { ApnsCredentials, FcmCredentials, LatencyHint, NodeProfile, PushCredentials } from '@serfab/cadre-core';
import type { CliConfig, StrandFilterConfig } from './types.js';
import { ENV_MAPPINGS } from './env.js';
import { nearestKey } from './nearest-key.js';
import { parseStrandFilter } from './strand-filter.js';

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

/** One rejected key: where it sits, for attribution, and the operator-facing line. */
export interface Problem {
  /** Dotted path of the offending key (`network.listenAddr`, `push.fcm.privateKey`; `''` is the root). */
  keyPath: string;
  /** The complete message, already naming the key. */
  text: string;
}

/** Collects every problem a validation pass finds, so one start reports them all. */
export class ValidationContext {
  readonly problems: Problem[] = [];

  /** Record a problem and hand back the "failed" result a checker returns. */
  fail(keyPath: string, text: string): undefined {
    this.problems.push({ keyPath, text });
    return undefined;
  }

  /** Record a required key that is absent, naming the variable(s) that could supply it. */
  missing(keyPath: string, condition?: string): undefined {
    const variables = envVarsFor(keyPath);
    const hint = variables.length > 0 ? ` (or set ${variables.join(' and ')})` : '';
    return this.fail(keyPath, `${keyPath} is required${condition ? ` ${condition}` : ''}${hint}`);
  }
}

/** Reverse lookup in {@link ENV_MAPPINGS}: the variables that write `keyPath` or a key beneath it. */
function envVarsFor(keyPath: string): string[] {
  return Object.entries(ENV_MAPPINGS)
    .filter(([, { path }]) => path === keyPath || path.startsWith(`${keyPath}.`))
    .map(([envVar]) => envVar);
}

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

/**
 * Checks one value at `keyPath`. Returns the accepted, typed value, or `undefined` after
 * recording why on `ctx`. `undefined` is never a valid config value, so it is free to mean
 * "failed".
 */
export interface Checker<T> {
  (value: unknown, keyPath: string, ctx: ValidationContext): T | undefined;
  /**
   * Set on checkers built by {@link objectOf}: a `null` at this key means the block is absent.
   * YAML `network:` with every child commented out parses to `null`, and the Docker entrypoint
   * writes exactly that when no address variable is set. A `null` leaf, by contrast, is
   * ill-typed.
   */
  readonly nullIsAbsent?: true;
}

/**
 * One checker per key of `T` — the compile-time drift guard. A key added to `T` without a
 * checker fails to compile here; a checker for a key `T` lacks is an excess property.
 */
export type FieldTable<T> = { [K in keyof T]-?: Checker<NonNullable<T[K]>> };

export interface ObjectOptions<T> {
  /** Keys that must be present (and, for object-typed keys, not `null`). */
  required?: readonly (keyof T & string)[];
  /** Keys no longer accepted, each with the message that says what replaced it. */
  retired?: ReadonlyMap<string, string>;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** What kind of thing a value is, for a message that must not echo its contents. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date';
  if (typeof value === 'object') return 'a mapping';
  return `a ${typeof value}`;
}

/** A string echoed in a message is cut here: enough to recognise a typo, not a pasted file. */
const MAX_ECHOED_CHARS = 120;

/**
 * How a rejected value is shown: scalars in full (long strings cut), containers by kind only.
 *
 * NOTE: a secret pasted where a scalar belongs (`push.fcm: "-----BEGIN PRIVATE KEY..."`) would be
 * echoed by the "must be a mapping" message. The `privateKey` fields themselves go through
 * {@link secretString}, which never shows the value. If push blocks are ever hand-written rather
 * than orchestrator-generated, switch the whole `push` subtree to kind-only descriptions.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > MAX_ECHOED_CHARS
      ? `${JSON.stringify(value.slice(0, MAX_ECHOED_CHARS))}… (${value.length} characters)`
      : JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return kindOf(value);
}

export const stringValue: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string'
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a string, got ${describeValue(value)}`);

export const nonEmptyString: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a non-empty string, got ${describeValue(value)}`);

/** A string whose value is a secret: the message says only what kind of thing arrived instead. */
export const secretString: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string'
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a string, got ${kindOf(value)}`);

export const booleanValue: Checker<boolean> = (value, keyPath, ctx) =>
  typeof value === 'boolean'
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a boolean (true or false), got ${describeValue(value)}`);

function numberWhere(accepts: (n: number) => boolean, expected: string): Checker<number> {
  return (value, keyPath, ctx) =>
    typeof value === 'number' && Number.isFinite(value) && accepts(value)
      ? value
      : ctx.fail(keyPath, `${keyPath} must be ${expected}, got ${describeValue(value)}`);
}

export const finiteNumber = numberWhere(() => true, 'a number');
export const positiveNumber = numberWhere((n) => n > 0, 'a number above zero');
export const nonNegativeNumber = numberWhere((n) => n >= 0, 'a number of zero or more');
export const nonNegativeInteger = numberWhere(
  (n) => Number.isSafeInteger(n) && n >= 0,
  'a whole number of zero or more',
);

/**
 * One of a closed set of strings. The set is written as an object with every member as a
 * key, so it is checked against the union type: `oneOf<NodeProfile>({ transaction: true,
 * storage: true })` stops compiling when cadre-core adds a profile or drops one.
 */
export function oneOf<T extends string>(members: Record<T, true>): Checker<T> {
  const values = Object.keys(members) as T[];
  const list = values.map((v) => `'${v}'`).join(', ');
  return (value, keyPath, ctx) =>
    typeof value === 'string' && (values as string[]).includes(value)
      ? (value as T)
      : ctx.fail(keyPath, `${keyPath} must be one of ${list}, got ${describeValue(value)}`);
}

export function arrayOf<T>(item: Checker<T>): Checker<T[]> {
  return (value, keyPath, ctx) => {
    if (!Array.isArray(value)) {
      return ctx.fail(keyPath, `${keyPath} must be a list, got ${describeValue(value)}`);
    }
    const before = ctx.problems.length;
    const out = value.map((entry, i) => item(entry, `${keyPath}[${i}]`, ctx));
    return ctx.problems.length === before ? (out as T[]) : undefined;
  };
}

/**
 * A mapping whose every key is checked by `fields`. Keys outside the table are rejected —
 * with the retired-key message when one applies, else with the nearest accepted key as a
 * suggestion. Absent keys are skipped unless `required`; a `null` under an object-typed key
 * counts as absent (see {@link Checker.nullIsAbsent}).
 */
export function objectOf<T extends object>(fields: FieldTable<T>, opts: ObjectOptions<T> = {}): Checker<T> {
  const table = fields as Record<string, Checker<unknown>>;
  const accepted = Object.keys(table);
  const required = new Set<string>(opts.required ?? []);
  const retired = opts.retired ?? new Map<string, string>();

  const checker = (value: unknown, keyPath: string, ctx: ValidationContext): T | undefined => {
    if (!isPlainObject(value)) {
      return ctx.fail(keyPath, `${keyPath} must be a mapping of keys, got ${describeValue(value)}`);
    }
    const before = ctx.problems.length;
    for (const key of Object.keys(value)) {
      if (!accepted.includes(key)) rejectKey(joinPath(keyPath, key), key, accepted, retired, ctx);
    }
    const out: Record<string, unknown> = {};
    for (const key of accepted) {
      const child = value[key];
      const childPath = joinPath(keyPath, key);
      const field = table[key];
      if (child === undefined || (child === null && field.nullIsAbsent)) {
        if (required.has(key)) reportMissing(field, childPath, ctx);
        continue;
      }
      const checked = field(child, childPath, ctx);
      if (checked !== undefined) out[key] = checked;
    }
    return ctx.problems.length === before ? (out as T) : undefined;
  };
  return Object.assign(checker, { nullIsAbsent: true as const });
}

/** Run `check` over a value `base` accepted — for a rule that spans more than one key. */
export function refine<T>(
  base: Checker<T>,
  check: (value: T, keyPath: string, ctx: ValidationContext) => T | undefined,
): Checker<T> {
  const checker = (value: unknown, keyPath: string, ctx: ValidationContext): T | undefined => {
    const accepted = base(value, keyPath, ctx);
    return accepted === undefined ? undefined : check(accepted, keyPath, ctx);
  };
  return base.nullIsAbsent ? Object.assign(checker, { nullIsAbsent: true as const }) : checker;
}

function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

function rejectKey(
  keyPath: string,
  key: string,
  accepted: readonly string[],
  retired: ReadonlyMap<string, string>,
  ctx: ValidationContext,
): void {
  const replacement = retired.get(key);
  if (replacement !== undefined) {
    ctx.fail(keyPath, `${keyPath} is no longer supported — ${replacement}`);
    return;
  }
  const nearest = nearestKey(key, accepted);
  ctx.fail(keyPath, `unknown key ${keyPath}${nearest ? ` (did you mean '${nearest}'?)` : ''}`);
}

/**
 * A required block that is absent is reported through its own required children when it has
 * any — `controlNetwork.partyId is required (or set CADRE_PARTY_ID)` tells the operator more
 * than `controlNetwork is required` — and as itself otherwise.
 */
function reportMissing(field: Checker<unknown>, keyPath: string, ctx: ValidationContext): void {
  if (field.nullIsAbsent) {
    const before = ctx.problems.length;
    field({}, keyPath, ctx);
    if (ctx.problems.length > before) return;
  }
  ctx.missing(keyPath);
}

// ---------------------------------------------------------------------------
// Field tables — one per block of CliConfig, plus cadre-core's push credential types
// ---------------------------------------------------------------------------

type Block<K extends keyof CliConfig> = NonNullable<CliConfig[K]>;

/**
 * A named-but-valueless `keyFile` is the trap: `identity:\n  keyFile:` parses to `{ keyFile: null }`
 * and would otherwise resolve to *no identity*, so the node generates a fresh keypair and comes
 * up as a stranger to its own cadre. Same for `''`, whitespace, or a non-string. The operator
 * plainly meant to configure an identity; say so instead of re-keying the node.
 */
const identityKeyFile: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : ctx.fail(
      keyPath,
      `${keyPath} must be a path to a libp2p protobuf private key file, got ${describeValue(value)}. ` +
      `Remove the identity block entirely to run without a stable peer id; leaving it empty would ` +
      `silently start the node under a NEW one.`,
    );

// NOTE: transitional — this map exists only to give old configs a pointed error instead of a
// generic "unknown key". Safe to delete once no config in circulation names either key; the
// field table is the permanent guard and must stay.
const RETIRED_IDENTITY_KEYS = new Map<string, string>([
  ['protobufKeyFile', "renamed to 'keyFile' — same libp2p protobuf format, no file change needed"],
  ['privateKeyHex', "removed — write the key to a file ('cadre enroll create') and set 'keyFile'"],
]);

const identity = objectOf<Block<'identity'>>(
  { keyFile: identityKeyFile },
  { retired: RETIRED_IDENTITY_KEYS },
);

const controlNetwork = objectOf<Block<'controlNetwork'>>(
  {
    partyId: nonEmptyString,
    // May be empty: cadre-host's owner node, the founding node of its own cadre, writes `[]`.
    bootstrapNodes: arrayOf(nonEmptyString),
  },
  { required: ['partyId', 'bootstrapNodes'] },
);

/** Whatever {@link parseStrandFilter} accepts; its message already names the key. */
const strandFilter: Checker<StrandFilterConfig> = (value, keyPath, ctx) => {
  try {
    parseStrandFilter(value);
    return value as StrandFilterConfig;
  } catch (err) {
    return ctx.fail(keyPath, err instanceof Error ? err.message : String(err));
  }
};

const storage = refine(
  objectOf<Block<'storage'>>(
    {
      type: oneOf<Block<'storage'>['type']>({ memory: true, file: true }),
      path: nonEmptyString,
      quotaBytes: nonNegativeInteger,
    },
    { required: ['type'] },
  ),
  // Cross-field: a file store needs somewhere to put the files. `resolveStorageConfig` checks
  // this too, without naming the file; this check runs first.
  (value, keyPath, ctx) =>
    value.type === 'file' && value.path === undefined
      ? ctx.missing(`${keyPath}.path`, `when ${keyPath}.type is 'file'`)
      : value,
);

const network = objectOf<Block<'network'>>({
  listenAddrs: arrayOf(stringValue),
  announceAddrs: arrayOf(stringValue),
  appendAnnounceAddrs: arrayOf(stringValue),
  relayAddrs: arrayOf(stringValue),
  enableRelay: booleanValue,
  // 0 is meaningful: refuse every unauthorized reservation.
  unauthorizedRelayReservationCap: nonNegativeInteger,
  cohortQueryTimeoutMs: finiteNumber,
  linkRoundTripMs: finiteNumber,
});

const hibernation = objectOf<Block<'hibernation'>>(
  {
    enabled: booleanValue,
    defaultLatencyHint: oneOf<LatencyHint>({ realtime: true, interactive: true, background: true, archive: true }),
  },
  { required: ['enabled'] },
);

const nodeState = objectOf<Block<'nodeState'>>({ dir: nonEmptyString });

// Push sub-fields are type-checked only. Which of them must be present when a platform block
// is present stays with cadre-core's `validatePushCredentials`, which host and provider also
// use; `resolveConfig` calls it after this pass.
const fcm = objectOf<FcmCredentials>({
  projectId: stringValue,
  clientEmail: stringValue,
  privateKey: secretString,
});

const apns = objectOf<ApnsCredentials>({
  keyId: stringValue,
  teamId: stringValue,
  bundleId: stringValue,
  privateKey: secretString,
  production: booleanValue,
});

const push = objectOf<PushCredentials>({
  fcm,
  apns,
  cooldownMs: nonNegativeNumber,
  debounceMs: nonNegativeNumber,
});

const root = objectOf<CliConfig>(
  {
    identity,
    controlNetwork,
    profile: oneOf<NodeProfile>({ transaction: true, storage: true }),
    strandFilter,
    storage,
    network,
    hibernation,
    strandWatchInterval: positiveNumber,
    nodeState,
    push,
  },
  { required: ['controlNetwork', 'profile'] },
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate the merged config tree against the field tables above.
 *
 * `provenance` maps each dotted path the environment wrote to the variable that wrote it
 * (`applyEnvironmentOverrides` builds it); a problem at a key is attributed to the variable
 * whose written path is the longest prefix of that key, and to `configPath` when none is.
 * Throws one `Error` whose message lists every problem, one per line.
 */
export function validateConfig(
  tree: unknown,
  provenance: ReadonlyMap<string, string>,
  configPath: string,
): CliConfig {
  const ctx = new ValidationContext();
  const config = checkRoot(tree, ctx);
  if (config === undefined || ctx.problems.length > 0) {
    const lines = ctx.problems.map((p) => `${sourceOf(p.keyPath, provenance, configPath)}: ${p.text}`);
    throw new Error(lines.join('\n'));
  }
  return config;
}

function checkRoot(tree: unknown, ctx: ValidationContext): CliConfig | undefined {
  // An empty file parses to undefined/null: an empty mapping, for the environment to fill.
  const value = tree ?? {};
  if (!isPlainObject(value)) {
    return ctx.fail('', `the top level must be a mapping of keys, got ${describeValue(value)}`);
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

function isPathPrefix(prefix: string, keyPath: string): boolean {
  return keyPath === prefix || keyPath.startsWith(`${prefix}.`) || keyPath.startsWith(`${prefix}[`);
}
