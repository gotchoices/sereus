/**
 * Helpers for reaching a cadre container's live health server.
 *
 * The container's health server (see @serfab/cadre-cli `HealthServer`) exposes
 * `/health` (liveness) and `/status` (detailed JSON). The provider only stores
 * the `/health` URL on a container, so the `/status` URL is derived from it.
 * Keeping that derivation in one place avoids the duplicated string surgery
 * that previously lived inline in ContainerService.
 */

import type { Container } from '../types.js';

/** Strand counts as reported by a container's `/status` endpoint. */
export interface ContainerStrandCounts {
  total: number;
  active: number;
  idle: number;
  hibernating: number;
}

/**
 * Subset of the cadre-cli `/status` (`HealthStatus`) payload the provider
 * consumes. Strands live under `node.strands` in the real payload — NOT at the
 * top level. Typed locally because cadre-provider does not depend on cadre-cli.
 */
export interface ContainerHealthStatus {
  status: 'healthy' | 'unhealthy' | 'starting';
  uptime: number;
  node?: {
    strands?: ContainerStrandCounts;
  };
}

/** Derive the `/status` URL from a container's `/health` endpoint URL. */
export function statusUrlFromHealthEndpoint(healthEndpoint: string): string {
  return healthEndpoint.replace('/health', '/status');
}

/**
 * Fetch a container's live `/status` payload.
 *
 * Resolves to `undefined` (never throws) when the container has no health
 * endpoint, the fetch fails, or the response is not OK — so callers can degrade
 * gracefully rather than aborting a wider collection loop.
 */
export async function fetchContainerHealthStatus(
  container: Container
): Promise<ContainerHealthStatus | undefined> {
  if (!container.healthEndpoint) return undefined;

  try {
    const res = await fetch(statusUrlFromHealthEndpoint(container.healthEndpoint));
    if (!res.ok) return undefined;
    return await res.json() as ContainerHealthStatus;
  } catch {
    // Container unreachable / status server down — caller falls back to defaults.
    return undefined;
  }
}
