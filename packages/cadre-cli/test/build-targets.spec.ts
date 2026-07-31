/**
 * Holds this suite's stale-build target list against the package it guards.
 *
 * `global-setup.ts`'s `TARGETS` is hand-written. Without this, adding a workspace
 * or linked dependency to `package.json` leaves it unguarded and says nothing —
 * the suite goes on passing while it runs that dependency's stale `dist`.
 *
 * The list is deliberately wider than `dependencies` (it also covers
 * `quereus-plugin-sereus` and the packages beneath it, reached transitively
 * through `cadre-core`), so only missing entries fail — extra ones are the point.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { distBackedDependencies, targetListProblems } from '../../../test-harness/build-targets.js';
import { TARGETS } from './global-setup.js';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('cadre-cli stale-build targets', () => {
  it('cover every dependency this suite runs compiled code from', () => {
    expect(targetListProblems(packageDir, TARGETS)).toEqual([]);
  });

  // Guards the guard: the assertion above passes trivially if the manifest scan
  // comes back empty (a renamed field, a moved package root).
  it('are checked against dependencies that were actually found', () => {
    const found = distBackedDependencies(packageDir);

    expect(found.get('@serfab/cadre-core')).toBe('workspace');
    expect(found.get('@optimystic/db-p2p')).toBe('linked');
  });

  it('name each package once', () => {
    const names = TARGETS.map((target) => target.packageName);

    expect(names).toEqual([...new Set(names)]);
  });
});
