/**
 * The checker mechanism: a problem collector and one small checker per kind of value.
 *
 * There is no schema library and no generic schema interpreter. Each object level is a
 * `FieldTable<T>` — one checker per key — typed against the TypeScript type it validates, so
 * the compiler, not a test, catches a key added to the type without a checker or a checker for
 * a key the type lacks. The accepted-key set at runtime is the table's own keys, which is also
 * what the unknown-key error and its typo suggestion are drawn from.
 */

import { nearestKey } from './nearest-key.js';

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

  /**
   * @param suppliersOf what, besides the config file, could supply a key — the environment
   * variables that write `keyPath` or a key beneath it. Named in "is required" messages.
   * @param concealUnder key paths whose whole subtree holds secrets: a rejected value at or
   * under one is described by kind only (see {@link ValidationContext.describe}).
   */
  constructor(
    private readonly suppliersOf: (keyPath: string) => readonly string[] = () => [],
    private readonly concealUnder: readonly string[] = [],
  ) {}

  /** Record a problem and hand back the "failed" result a checker returns. */
  fail(keyPath: string, text: string): undefined {
    this.problems.push({ keyPath, text });
    return undefined;
  }

  /** Record a required key that is absent, naming the variable(s) that could supply it. */
  missing(keyPath: string, condition?: string): undefined {
    const variables = this.suppliersOf(keyPath);
    const hint = variables.length > 0 ? ` (or set ${variables.join(' and ')})` : '';
    return this.fail(keyPath, `${keyPath} is required${condition ? ` ${condition}` : ''}${hint}`);
  }

  /**
   * How a rejected value at `keyPath` is shown in a message: {@link describeValue}'s echo,
   * unless the key is at or under a `concealUnder` prefix, where a private key pasted in the
   * wrong place (`push.fcm: "-----BEGIN PRIVATE KEY…"`) must not be echoed — then its kind only.
   * Every checker in this package describes values through here, so a hand-written checker
   * should too.
   */
  describe(keyPath: string, value: unknown): string {
    const concealed = this.concealUnder.some((prefix) => isPathPrefix(prefix, keyPath));
    return concealed ? kindOf(value) : describeValue(value);
  }
}

/** Whether `keyPath` is `prefix` itself or a key beneath it (`a.b` is under `a`; `ab` is not). */
export function isPathPrefix(prefix: string, keyPath: string): boolean {
  return keyPath === prefix || keyPath.startsWith(`${prefix}.`) || keyPath.startsWith(`${prefix}[`);
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
   * Set on checkers built by {@link objectOf} and {@link recordOf}: a `null` at this key means
   * the block is absent. YAML `network:` with every child commented out parses to `null`, and
   * cadre-cli's Docker entrypoint writes exactly that when no address variable is set. A `null`
   * leaf, by contrast, is ill-typed.
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
export function kindOf(value: unknown): string {
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
 * {@link secretString}, which never shows the value; for a whole subtree that is hand-written
 * and holds secrets, `validateTree`'s `concealUnder` option describes every value under it by
 * kind only (cadre-provider lists `push` and `billing`). cadre-cli has not opted in: its `push`
 * block is written by an orchestrator, not by hand.
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
    : ctx.fail(keyPath, `${keyPath} must be a string, got ${ctx.describe(keyPath, value)}`);

export const nonEmptyString: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a non-empty string, got ${ctx.describe(keyPath, value)}`);

/** A string whose value is a secret: the message says only what kind of thing arrived instead. */
export const secretString: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string'
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a string, got ${kindOf(value)}`);

export const booleanValue: Checker<boolean> = (value, keyPath, ctx) =>
  typeof value === 'boolean'
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a boolean (true or false), got ${ctx.describe(keyPath, value)}`);

/** A finite number `accepts` admits; `expected` completes "must be …" in the message. */
export function numberWhere(accepts: (n: number) => boolean, expected: string): Checker<number> {
  return (value, keyPath, ctx) =>
    typeof value === 'number' && Number.isFinite(value) && accepts(value)
      ? value
      : ctx.fail(keyPath, `${keyPath} must be ${expected}, got ${ctx.describe(keyPath, value)}`);
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
      : ctx.fail(keyPath, `${keyPath} must be one of ${list}, got ${ctx.describe(keyPath, value)}`);
}

export function arrayOf<T>(item: Checker<T>): Checker<T[]> {
  return (value, keyPath, ctx) => {
    if (!Array.isArray(value)) {
      return ctx.fail(keyPath, `${keyPath} must be a list, got ${ctx.describe(keyPath, value)}`);
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
      return ctx.fail(keyPath, `${keyPath} must be a mapping of keys, got ${ctx.describe(keyPath, value)}`);
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

/**
 * A mapping whose keys are the operator's own (cadre-provider's tenant ids), each value checked
 * by `value` at `<keyPath>.<key>`. An empty or blank key is a problem. Unlike a key in an
 * {@link objectOf} table, a `null` value is not an absent block: `tenants: { acme: }` is
 * reported, because treating it as absent would silently hand that tenant the defaults.
 */
export function recordOf<T>(value: Checker<T>): Checker<Record<string, T>> {
  const checker = (raw: unknown, keyPath: string, ctx: ValidationContext): Record<string, T> | undefined => {
    if (!isPlainObject(raw)) {
      return ctx.fail(keyPath, `${keyPath} must be a mapping of keys, got ${ctx.describe(keyPath, raw)}`);
    }
    const before = ctx.problems.length;
    const out: Record<string, T> = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (key.trim() === '') {
        ctx.fail(keyPath, `${keyPath} has an empty key`);
        continue;
      }
      const checked = value(entry, joinPath(keyPath, key), ctx);
      if (checked !== undefined) out[key] = checked;
    }
    return ctx.problems.length === before ? out : undefined;
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
