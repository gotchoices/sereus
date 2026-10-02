/**
 * Shared daemon surface for the fake-dockerode harnesses.
 *
 * `DockerOrchestrator` inspects/creates/removes a named `/data` volume on every
 * create and remove, and lists its existing containers before its first create
 * (port rehydration), so every fake docker needs those calls. Kept here
 * so the orchestrator test files agree on the semantics that matter: a missing
 * volume raises a dockerode-shaped 404 rather than a bare Error, which is what
 * the orchestrator keys "does it already exist?" off; and by default the daemon
 * holds no earlier containers.
 *
 * Not a `*.test.ts` file, so vitest's `include` never collects it as a suite.
 */

import { vi } from 'vitest';

/** Error shaped like dockerode's "no such volume" response. */
function notFound(name: string): Error & { statusCode: number } {
  return Object.assign(new Error(`no such volume: ${name}`), { statusCode: 404 });
}

export interface DaemonStubs {
  /** Names currently existing on the fake daemon. */
  volumes: Set<string>;
  /** Names removed via `getVolume(name).remove()`, in call order. */
  removed: string[];
  createVolume: ReturnType<typeof vi.fn>;
  getVolume: ReturnType<typeof vi.fn>;
  /** Answers the port rehydration pass: no earlier containers. */
  listContainers: ReturnType<typeof vi.fn>;
}

/** Build in-memory `createVolume`/`getVolume`/`listContainers` stubs, pre-seeded with `existing` volumes. */
export function daemonStubs(existing: string[] = []): DaemonStubs {
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

  const listContainers = vi.fn(async () => []);

  return { volumes, removed, createVolume, getVolume, listContainers };
}
