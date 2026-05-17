/**
 * Tiny semver comparator. We refuse to pull in `semver` for a single
 * compareVersions() call; the surface here is intentionally narrow.
 *
 * Supports `MAJOR.MINOR.PATCH` and `MAJOR.MINOR.PATCH-PRERELEASE` (semver §11).
 * Build metadata (`+...`) is rejected — releases shouldn't ship with it and
 * it'd only confuse equality.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Empty string when there is no prerelease (= a higher precedence release). */
  prerelease: string;
}

export function parseVersion(input: string): ParsedVersion {
  if (typeof input !== 'string') {
    throw new Error(`Invalid version: ${String(input)}`);
  }
  const m = SEMVER_RE.exec(input.trim());
  if (!m) {
    throw new Error(`Invalid version: ${input}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
  };
}

/** -1 if a < b, 0 if equal, +1 if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  // Per semver §11: a version *without* a prerelease has higher precedence
  // than one with a prerelease.
  if (pa.prerelease === '' && pb.prerelease === '') return 0;
  if (pa.prerelease === '') return 1;
  if (pb.prerelease === '') return -1;

  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** Component-wise compare per semver §11.4. */
function comparePrerelease(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const c = compareIdentifier(as[i]!, bs[i]!);
    if (c !== 0) return c;
  }
  if (as.length === bs.length) return 0;
  return as.length < bs.length ? -1 : 1;
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  // Numeric identifiers always have lower precedence than alphanumeric.
  if (aNum) return -1;
  if (bNum) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
