import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CONTROL_SCHEMA } from '../src/control-schema.js';

/**
 * Drift guard for the security-critical CadreControl authorization schema.
 *
 * The schema exists as two hand-maintained copies:
 *   - `schemas/control.qsql`                  — the on-disk reference artifact
 *   - `CONTROL_SCHEMA` in `control-schema.ts` — the embedded copy that actually
 *     runs in production / React Native (`ControlDatabase.loadSchema()` uses it by
 *     default; the `.qsql` file is only read when an explicit `schemaPath` is set,
 *     which no runtime code path does).
 *
 * Because this schema gates every control-plane mutation (the `verify(...)` checks
 * for OwnerKey / ValidationKey / Strand / CadrePeer / FormationInvite /
 * FormationUsage), a one-sided edit is a silent security regression. This test
 * fails the build whenever the two copies drift.
 *
 * Normalization tolerates ONLY end-of-line and trailing-newline differences (the
 * repo is checked out with `core.autocrlf`, so git may deliver CRLF). It
 * deliberately does NOT collapse interior whitespace or strip comments, so any real
 * content change — e.g. an altered `verify(...)` argument — still trips the guard.
 */

// Resolve the repo-root `.qsql` relative to this source file. vitest runs the `.ts`
// under packages/cadre-core/test/, so three levels up reaches the repo root.
const QSQL_URL = new URL('../../../schemas/control.qsql', import.meta.url);

const normalize = (s: string): string =>
  s.replace(/\r\n/g, '\n')      // CRLF -> LF
   .replace(/[ \t]+$/gm, '')    // strip trailing horizontal whitespace per line
   .replace(/\n+$/g, '')        // drop trailing blank lines / final newline
   .trimEnd();

/** First 1-based line where the two normalized texts differ, or null if identical. */
function firstDiffLine(
  a: string,
  b: string
): { line: number; a: string; b: string } | null {
  const al = a.split('\n');
  const bl = b.split('\n');
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    if (al[i] !== bl[i]) {
      return { line: i + 1, a: al[i] ?? '<missing line>', b: bl[i] ?? '<missing line>' };
    }
  }
  return null;
}

describe('control schema drift guard', () => {
  it('embedded CONTROL_SCHEMA matches schemas/control.qsql', async () => {
    const fileContents = await readFile(fileURLToPath(QSQL_URL), 'utf-8');
    const fileNorm = normalize(fileContents);
    const embeddedNorm = normalize(CONTROL_SCHEMA);

    const diff = firstDiffLine(fileNorm, embeddedNorm);
    const message = diff
      ? 'CadreControl schema drift detected: the embedded CONTROL_SCHEMA and ' +
        'schemas/control.qsql have diverged. Mirror your edit in BOTH ' +
        'packages/cadre-core/src/control-schema.ts and schemas/control.qsql.\n' +
        `First difference at line ${diff.line}:\n` +
        `  schemas/control.qsql: ${JSON.stringify(diff.a)}\n` +
        `  control-schema.ts   : ${JSON.stringify(diff.b)}`
      : 'schemas match';

    expect(embeddedNorm, message).toBe(fileNorm);
  });
});
