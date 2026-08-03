/**
 * The environment a provider-hosted node is started with — the entire
 * contract between the provider and the node it spawns: party id, bootstrap
 * peers, profile, listen address, health/metrics ports, the per-container
 * seed token gating `POST /seed`, and the pinned owner keys a fresh node
 * needs to accept its first delivered seed.
 *
 * Pulled out of `DockerOrchestrator.createContainer` so a non-Docker
 * consumer (e.g. a test starting a real `@serfab/cadre-cli` child) can
 * reproduce exactly what the provider hands a container, rather than a
 * parallel copy that can drift from it.
 */

import type { ContainerResources } from '../types.js';
import type { OrchestratorCreateRequest } from './orchestrator.js';

/** Ports as seen INSIDE the container (the image's EXPOSE set), not host ports. */
export interface NodeEnvPorts {
  health: number;    // 8080 in the image
  metrics: number;   // 9090 in the image
  p2p: number;        // 4001 in the image
}

const DEFAULT_PORTS: NodeEnvPorts = { health: 8080, metrics: 9090, p2p: 4001 };

export interface NodeEnvSpec {
  request: OrchestratorCreateRequest;
  /** Per-container secret gating POST /seed. */
  seedToken: string;
  /** Defaults to { health: 8080, metrics: 9090, p2p: 4001 }. */
  ports?: NodeEnvPorts;
  /** Effective resources (request.resources merged with the config default). */
  resources?: ContainerResources;
}

/** `KEY=value` entries, empty ones already dropped — Docker `Env` order preserved. */
export function buildNodeEnv(spec: NodeEnvSpec): string[] {
  const { request, seedToken } = spec;
  const ports = spec.ports ?? DEFAULT_PORTS;
  const resources = spec.resources ?? {};

  return [
    `CADRE_PARTY_ID=${request.partyId}`,
    `CADRE_BOOTSTRAP_NODES=${request.bootstrapNodes.join(',')}`,
    `CADRE_PROFILE=${request.profile}`,
    `CADRE_HEALTH_PORT=${ports.health}`,
    `CADRE_METRICS_PORT=${ports.metrics}`,
    `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/${ports.p2p}`,
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
  ].filter(Boolean);
}
