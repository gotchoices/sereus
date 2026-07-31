/**
 * Shared volume surface for the fake-dockerode harnesses.
 *
 * `DockerOrchestrator` now inspects/creates/removes a named `/data` volume on
 * every create and remove, so every fake docker needs those three calls. Kept
 * here so the three orchestrator test files agree on the semantics that matter:
 * a missing volume raises a dockerode-shaped 404 rather than a bare Error, which
 * is what the orchestrator keys "does it already exist?" off.
 *
 * Not a `*.test.ts` file, so vitest's `include` never collects it as a suite.
 */

import { vi } from 'vitest';

/** Error shaped like dockerode's "no such volume" response. */
function notFound(name: string): Error & { statusCode: number } {
  return Object.assign(new Error(`no such volume: ${name}`), { statusCode: 404 });
}

export interface VolumeStubs {
  /** Names currently existing on the fake daemon. */
  volumes: Set<string>;
  /** Names removed via `getVolume(name).remove()`, in call order. */
  removed: string[];
  createVolume: ReturnType<typeof vi.fn>;
  getVolume: ReturnType<typeof vi.fn>;
}

/** Build an in-memory `createVolume`/`getVolume` pair, pre-seeded with `existing`. */
export function volumeStubs(existing: string[] = []): VolumeStubs {
  const volumes = new Set(existing);
  const removed: string[] = [];

  const createVolume = vi.fn(async (options: { Name?: string }) => {
    volumes.add(options.Name!);
    return { Name: options.Name! };
  });

  const getVolume = vi.fn((name: string) => ({
    name,
    inspect: async () => {
      if (!volumes.has(name)) throw notFound(name);
      return { Name: name, Labels: {} };
    },
    remove: async () => {
      if (!volumes.delete(name)) throw notFound(name);
      removed.push(name);
    },
  }));

  return { volumes, removed, createVolume, getVolume };
}
