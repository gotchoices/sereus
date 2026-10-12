/**
 * The environment a provider-hosted node is started with — the entire
 * contract between the provider and the node it spawns: party id, bootstrap
 * peers, profile, listen and announced addresses, health/metrics ports, the
 * per-container seed token gating `POST /seed`, and how the node joins its
 * cadre: the claim secret (`CADRE_CLAIM_SECRET`) or the invitation bundle
 * (`CADRE_INVITATION`) of a `join`, or the pinned owner keys a fresh seed-path
 * node needs to accept its first delivered seed.
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
  /** Per-container secret gating POST /seed. */
  seedToken: string;
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
 * The one variable that tells the node how to join its cadre, or '' on the seed path.
 * cadre-cli reads both straight from the environment (`COMMAND_ENV` in its `env.ts`),
 * never from a flag, since either value in a process list would leak it.
 *
 * Throws on pins beside a join: a claim names the owner and the bundle carries the owner
 * keys the node pins itself, so a pin trusts a signer neither named. Beside a claim
 * `cadre start` refuses `CADRE_OWNER_KEYS` and the container would die at boot with the
 * cause visible only in its log; beside an invitation it would start with a trust anchor
 * the owner never chose. Failing here names it at the provision instead. `POST /containers`
 * already refuses the body; this guards a direct `ContainerService` caller.
 */
function joinEnv(request: OrchestratorCreateRequest): string {
  const { join } = request;
  if (!join) return '';
  if (request.pinnedOwnerKeys?.length) {
    throw new Error(`a container that joins by ${join.kind} cannot pin owner keys: the ${join.kind} names its owner, and a pin would trust a signer it never named`);
  }
  return join.kind === 'claim' ? `CADRE_CLAIM_SECRET=${join.secret}` : `CADRE_INVITATION=${join.invitation}`;
}

/** `KEY=value` entries, empty ones already dropped — Docker `Env` order preserved. */
export function buildNodeEnv(spec: NodeEnvSpec): string[] {
  const { request, seedToken } = spec;
  const ports = spec.ports ?? CONTAINER_PORTS;
  const resources = spec.resources ?? {};
  const announce = spec.appendAnnounceAddrs ?? [];

  return [
    // The placeholder party (`UNCLAIMED_PARTY_ID`) for a claim, the bundle's for an
    // invitation; the request carries the right one either way.
    `CADRE_PARTY_ID=${request.partyId}`,
    // Omitted when empty, like CADRE_OWNER_KEYS: the image's entrypoint then writes
    // `bootstrapNodes: []`, a node that waits to be dialed.
    request.bootstrapNodes.length ? `CADRE_BOOTSTRAP_NODES=${request.bootstrapNodes.join(',')}` : '',
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
    // NOTE: emitted unconditionally — the provider always mints a token. A
    // caller passing '' would ship a present-but-empty var, which cadre-cli
    // reads as "seed endpoint disabled"; guard it here if a consumer ever
    // legitimately wants a node with no seed route.
    `CADRE_SEED_TOKEN=${seedToken}`,
    request.strandFilter ? `CADRE_STRAND_FILTER=${request.strandFilter}` : '',
    resources.storageQuotaBytes ? `CADRE_STORAGE_QUOTA=${resources.storageQuotaBytes}` : '',
    // This tenant's push credentials, JSON-encoded (handles the PEM newlines)
    // — only ever this tenant's, resolved upstream by ContainerService. The
    // node reads it via the CADRE_PUSH env mapping. Never logged.
    request.push ? `CADRE_PUSH=${JSON.stringify(request.push)}` : '',
    // This tenant's cold-start seed-trust anchors. `cadre-cli start` unions
    // the comma-separated list into a pinnedKeyTrustPolicy, which is the
    // only thing that lets a fresh container accept the first seed the
    // provider delivers — its node-local trusted-owner store starts empty
    // and nothing replicated can fill it. Omitted entirely when the list is
    // empty (the CLI would parse a bare var to [] anyway, but a node told to
    // trust nobody should not look configured).
    request.pinnedOwnerKeys?.length ? `CADRE_OWNER_KEYS=${request.pinnedOwnerKeys.join(',')}` : '',
    joinEnv(request),
  ].filter(Boolean);
}
