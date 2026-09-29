import type { StrandFilter } from '@serfab/cadre-core';
import type { StrandFilterConfig } from './types.js';

const STRAND_FILTER_FORMS =
  `"all", "none", {"sAppId":"..."}, or {"strandId":"..."} (object forms carry exactly one ` +
  `non-empty string discriminant)`;

/** The message every rejected strand filter gets, whichever path found it. */
export function invalidStrandFilterMessage(filter: unknown): string {
  return `Invalid strandFilter ${JSON.stringify(filter)}: expected ${STRAND_FILTER_FORMS}`;
}

/**
 * Parse a strand filter (from a config file or an env override) into a
 * {@link StrandFilter}.
 *
 * This is the single validation point for both env-driven and file-loaded
 * configs, so it takes `unknown`: env overrides inject already-parsed JSON
 * ahead of the narrow config type. Accepted forms are `all`, `none`,
 * `{ sAppId }`, and `{ strandId }` (each object carrying exactly one
 * discriminant with a non-empty string value). Anything else throws — a
 * misconfigured node must refuse to start rather than silently over-subscribe
 * to every strand.
 */
export function parseStrandFilter(filter: unknown): StrandFilter {
  if (filter === undefined || filter === null || filter === 'all') return { mode: 'all' };
  if (filter === 'none') return { mode: 'none' };
  if (typeof filter === 'object') {
    const obj = filter as Record<string, unknown>;
    const sAppId = obj.sAppId;
    const strandId = obj.strandId;
    const hasSAppId = sAppId !== undefined;
    const hasStrandId = strandId !== undefined;
    if (hasSAppId && !hasStrandId && typeof sAppId === 'string' && sAppId.length > 0) {
      return { mode: 'sAppId', sAppId };
    }
    if (hasStrandId && !hasSAppId && typeof strandId === 'string' && strandId.length > 0) {
      return { mode: 'strandId', strandId };
    }
  }
  throw new Error(invalidStrandFilterMessage(filter));
}

/**
 * Parse the text form of a strand filter — the `CADRE_STRAND_FILTER` value, or the
 * `strandFilter` string of a provision request — into the shape {@link parseStrandFilter}
 * expects. Callers pass a non-empty string; `label` names the source in the error.
 *
 * Bare `all`/`none` (case-insensitive, trimmed) are kept as scalar strings.
 * Object filters must be supplied as **JSON** — e.g. `{"sAppId":"myapp"}` or
 * `{"strandId":"<id>"}` — mirroring the explicit encoding precedent of the
 * `_NODES`/`_ADDRS` vars. A `{`-leading value that fails to parse throws,
 * rather than degrading to a raw string that {@link parseStrandFilter} would
 * later reject.
 */
export function parseStrandFilterText(value: string, label = 'CADRE_STRAND_FILTER'): unknown {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'all' || lower === 'none') return lower;

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    if (trimmed.startsWith('{')) {
      throw new Error(
        `Invalid ${label} ${JSON.stringify(value)}: expected JSON object ` +
        `(e.g. {"sAppId":"myapp"} or {"strandId":"<id>"})`,
        { cause: err },
      );
    }
    // Any other unrecognized scalar passes through for parseStrandFilter to
    // reject loudly with the full list of accepted forms.
    return trimmed;
  }
}

/**
 * The text form as a validated config-file value: what a config writer that is handed a strand
 * filter as text (cadre-host writing a child's `cadre.json`) stores under `strandFilter`.
 * Throws on anything the node itself would refuse, so the mistake surfaces where the request
 * is made rather than when the node fails to start.
 */
export function strandFilterConfigFromText(text: string): StrandFilterConfig {
  const raw = parseStrandFilterText(text, 'strandFilter');
  parseStrandFilter(raw);
  return raw as StrandFilterConfig;
}
