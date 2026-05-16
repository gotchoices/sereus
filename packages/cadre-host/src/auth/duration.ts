/**
 * Tiny duration parser for invite TTLs.
 *
 * Accepts a single value+unit token: `30s`, `5m`, `24h`, `7d`, `2w`.
 * Whitespace is allowed around it. Bare numbers are treated as milliseconds.
 *
 * Returns the duration in milliseconds. Throws on unparseable input.
 */
const UNIT_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/;

export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const match = DURATION_RE.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid duration: ${JSON.stringify(input)} (expected e.g. "24h", "7d", "30m")`);
  }
  const value = parseFloat(match[1]!);
  const unit = match[2] ?? 'ms';
  const multiplier = UNIT_MULTIPLIERS[unit];
  if (multiplier === undefined) {
    throw new Error(`Unknown duration unit: ${unit}`);
  }
  return Math.round(value * multiplier);
}
