/**
 * The whole shape check for `POST /containers` — one call that either yields the
 * typed {@link CreateContainerRequest} the service is handed, or the message the
 * route answers 400 with.
 *
 * **Why a validator rather than a few more `if`s in the route.** Every field in
 * this body is forwarded verbatim into a spawned container the caller cannot see:
 * `partyId`, `bootstrapNodes`, `profile` and `strandFilter` become environment
 * variables (`service/container-env.ts`), `resources` become Docker limits, and
 * `pinnedOwnerKeys` become the node's seed-trust anchors. A field the route
 * forgets to check is not a 400 — it is a container that dies at boot, or comes up
 * subtly wrong, with a 201 already sent. Routing the body through one function
 * that *constructs* the request object means a field can only reach the spawn path
 * by having been through here; adding a field to `CreateContainerRequest` without
 * validating it stops compiling rather than silently shipping.
 *
 * The two field rules with real substance live in their own modules, because each
 * is duplicated in another package and needs to be read next to the comment saying
 * so: `owner-key-validation.ts` (the Ed25519 rule, a copy of cadre-core's) and
 * `bootstrap-node-validation.ts` (the multiaddr rule, a copy of cadre-host's). The
 * rest — plain type and enum checks — are here.
 */

import type { ContainerResources, CreateContainerRequest } from '../types.js';
import { validateBootstrapNodes } from './bootstrap-node-validation.js';
import { validatePinnedOwnerKeys } from './owner-key-validation.js';

/** `partyId` becomes `CADRE_PARTY_ID`, so a non-string would be stringified into it. */
function validatePartyId(value: unknown): { partyId: string } | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: 'partyId is required' };
  }
  return { partyId: value.trim() };
}

/** Absent means `storage` — the profile that participates and is dialable. */
function validateProfile(value: unknown): { profile: CreateContainerRequest['profile'] } | { error: string } {
  if (value === undefined) return { profile: 'storage' };
  if (value !== 'storage' && value !== 'transaction') {
    return { error: 'profile must be "storage" or "transaction"' };
  }
  return { profile: value };
}

/** `strandFilter` becomes `CADRE_STRAND_FILTER` verbatim; its *syntax* is the node's business. */
function validateStrandFilter(value: unknown): { strandFilter?: string } | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    return { error: 'strandFilter must be a string' };
  }
  return { strandFilter: value };
}

/**
 * Resource limits, type-checked only: `memoryLimit` / `cpuLimit` are parsed by
 * `DockerOrchestrator` (which has its own opinion about `"512M"` vs `"2G"`) and
 * `storageQuotaBytes` becomes `CADRE_STORAGE_QUOTA`. What is rejected here is a
 * value of the wrong *kind* — the thing that would otherwise reach Docker or the
 * env as `[object Object]`.
 */
function validateResources(value: unknown): { resources?: ContainerResources } | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'resources must be an object' };
  }

  const { memoryLimit, cpuLimit, storageQuotaBytes } = value as Record<string, unknown>;
  if (memoryLimit !== undefined && typeof memoryLimit !== 'string') {
    return { error: 'resources.memoryLimit must be a string' };
  }
  if (cpuLimit !== undefined && typeof cpuLimit !== 'string') {
    return { error: 'resources.cpuLimit must be a string' };
  }
  if (storageQuotaBytes !== undefined && (typeof storageQuotaBytes !== 'number' || !Number.isFinite(storageQuotaBytes))) {
    return { error: 'resources.storageQuotaBytes must be a finite number' };
  }

  return {
    resources: {
      ...(memoryLimit !== undefined ? { memoryLimit } : {}),
      ...(cpuLimit !== undefined ? { cpuLimit } : {}),
      ...(storageQuotaBytes !== undefined ? { storageQuotaBytes } : {}),
    },
  };
}

/** Free-form labels, stored on the container record and echoed back to the tenant. */
function validateTags(value: unknown): { tags?: Record<string, string> } | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'tags must be an object of strings' };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    return { error: 'tags must be an object of strings' };
  }
  return { tags: Object.fromEntries(entries) };
}

/**
 * Validate a `POST /containers` body and build the request the service is handed.
 *
 * `customerId` comes from the authenticated identity rather than the body — a
 * tenant does not get to name whose container this is — so it is a parameter, not
 * a validated field.
 *
 * Transport-only flags (`shutdownAfter`) are deliberately not part of this: they
 * do not describe the container, are shared with other routes, and never reach the
 * spawned child.
 *
 * @returns the typed create request, or the message to answer `INVALID_REQUEST` with.
 */
export function validateCreateContainerRequest(
  body: unknown,
  customerId: string,
): { request: CreateContainerRequest } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' };
  }
  const fields = body as Record<string, unknown>;

  const partyId = validatePartyId(fields.partyId);
  if ('error' in partyId) return partyId;

  const bootstrap = validateBootstrapNodes(fields.bootstrapNodes);
  if ('error' in bootstrap) return bootstrap;

  // Optional, but create is the last point where the caller can still supply it —
  // a container created without it refuses every seed.
  const pinned = validatePinnedOwnerKeys(fields.pinnedOwnerKeys);
  if ('error' in pinned) return pinned;

  const profile = validateProfile(fields.profile);
  if ('error' in profile) return profile;

  const strandFilter = validateStrandFilter(fields.strandFilter);
  if ('error' in strandFilter) return strandFilter;

  const resources = validateResources(fields.resources);
  if ('error' in resources) return resources;

  const tags = validateTags(fields.tags);
  if ('error' in tags) return tags;

  return {
    request: {
      customerId,
      partyId: partyId.partyId,
      bootstrapNodes: bootstrap.nodes,
      profile: profile.profile,
      ...(strandFilter.strandFilter !== undefined ? { strandFilter: strandFilter.strandFilter } : {}),
      ...(resources.resources ? { resources: resources.resources } : {}),
      ...(tags.tags ? { tags: tags.tags } : {}),
      ...(pinned.keys ? { pinnedOwnerKeys: pinned.keys } : {}),
    },
  };
}
