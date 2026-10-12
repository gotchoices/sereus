/**
 * The environment a provider-hosted node is started with — the entire
 * contract between the provider and the node it spawns: party id, profile,
 * listen and announced addresses, health/metrics ports, and how the node joins
 * its cadre: the claim secret (`CADRE_CLAIM_SECRET`) or the invitation bundle
 * (`CADRE_INVITATION`) of a `join`. No `CADRE_SEED_TOKEN`, so the node registers
 * no seed route, and no `CADRE_OWNER_KEYS`: the claim names the owner and the
 * bundle carries the owner keys the node pins itself.
 *
 * Pulled out of `DockerOrchestrator.createContainer` so a non-Docker
 * consumer (e.g. a test starting a real `@serfab/cadre-cli` child) can
 * reproduce exactly what the provider hands a container, rather than a
 * parallel copy that can drift from it.
 */

import { isIP } from 'node:net';
import type { ContainerResources } from '../types.js';
import type { OrchestratorCreateRequest } from './orchestrator.js';

/** Ports as seen INSIDE the container (the image's EXPOSE set), not host ports. */
export interface NodeEnvPorts {
  health: number;
  metrics: number;
  /** libp2p TCP listener. */
  p2p: number;
  /** libp2p WebSocket listener — the only transport a phone can dial. */
  ws: number;
}

/**
 * The image's fixed in-container ports — the default for `NodeEnvSpec.ports`,
 * and the same set `DockerOrchestrator` publishes host ports against, so the
 * env vars and the `PortBindings` keys cannot drift apart.
 */
export const CONTAINER_PORTS: NodeEnvPorts = { health: 8080, metrics: 9090, p2p: 4001, ws: 4002 };

/**
 * The multiaddr host component for a DNS name or IP address: `/ip4/…` or
 * `/ip6/…` for an address, `/dns4/…` for a name (every published-address example
 * in this repo and the phone apps uses `/dns4`). Not validated here: config
 * validation parses the result once at provider start.
 */
export function hostComponent(host: string): string {
  const family = isIP(host);
  const proto = family === 4 ? 'ip4' : family === 6 ? 'ip6' : 'dns4';
  return `/${proto}/${host}`;
}

/**
 * The addresses at which a container is reachable from off this machine: the
 * provider's public host with the container's published TCP and WebSocket host
 * ports. libp2p appends `/p2p/<peerId>` itself when it announces them.
 */
export function publicNodeAddrs(publicHost: string, hostPorts: { p2p: number; ws: number }): string[] {
  const host = hostComponent(publicHost);
  return [`${host}/tcp/${hostPorts.p2p}`, `${host}/tcp/${hostPorts.ws}/ws`];
}

export interface NodeEnvSpec {
  request: OrchestratorCreateRequest;
  /** Defaults to `CONTAINER_PORTS` (the image's in-container ports). */
  ports?: NodeEnvPorts;
  /** Effective resources (request.resources merged with the config default). */
  resources?: ContainerResources;
  /**
   * Addresses the node announces besides the ones it binds — `publicNodeAddrs`
   * when the provider knows its public host. Absent or empty: the node announces
   * only its in-container addresses.
   */
  appendAnnounceAddrs?: readonly string[];
}

/**
 * The one variable that tells the node how to join its cadre, or '' when the request
 * carries no join. cadre-cli reads both straight from the environment (`COMMAND_ENV` in
 * its `env.ts`), never from a flag, since either value in a process list would leak it.
 */
function joinEnv(request: OrchestratorCreateRequest): string {
  const { join } = request;
  if (!join) return '';
  return join.kind === 'claim' ? `CADRE_CLAIM_SECRET=${join.secret}` : `CADRE_INVITATION=${join.invitation}`;
}

/** `KEY=value` entries, empty ones already dropped — Docker `Env` order preserved. */
export function buildNodeEnv(spec: NodeEnvSpec): string[] {
  const { request } = spec;
  const ports = spec.ports ?? CONTAINER_PORTS;
  const resources = spec.resources ?? {};
  const announce = spec.appendAnnounceAddrs ?? [];

  return [
    // The placeholder party (`UNCLAIMED_PARTY_ID`) for a claim, the bundle's for an
    // invitation; the request carries the right one either way.
    `CADRE_PARTY_ID=${request.partyId}`,
    `CADRE_PROFILE=${request.profile}`,
    `CADRE_HEALTH_PORT=${ports.health}`,
    `CADRE_METRICS_PORT=${ports.metrics}`,
    `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/${ports.p2p},/ip4/0.0.0.0/tcp/${ports.ws}/ws`,
    // The append form, not CADRE_ANNOUNCE_ADDRS: the in-container addresses stay
    // advertised, so containers on one Docker network still reach each other directly.
    // NOTE: a provider that fronts tenants with a TLS proxy (`/wss` on 443) would announce
    // the proxy's address here instead of the published ports, and would need a
    // per-container path or port on that proxy to tell tenants apart.
    announce.length ? `CADRE_APPEND_ANNOUNCE_ADDRS=${announce.join(',')}` : '',
    request.strandFilter ? `CADRE_STRAND_FILTER=${request.strandFilter}` : '',
    resources.storageQuotaBytes ? `CADRE_STORAGE_QUOTA=${resources.storageQuotaBytes}` : '',
    // This tenant's push credentials, JSON-encoded (handles the PEM newlines)
    // — only ever this tenant's, resolved upstream by ContainerService. The
    // node reads it via the CADRE_PUSH env mapping. Never logged.
    request.push ? `CADRE_PUSH=${JSON.stringify(request.push)}` : '',
    joinEnv(request),
  ].filter(Boolean);
}
