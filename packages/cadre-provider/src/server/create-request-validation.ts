/**
 * The whole shape check for `POST /containers` — one call that either yields the
 * typed {@link CreateContainerRequest} the service is handed, or the message the
 * route answers 400 with.
 *
 * **Why a validator rather than a few more `if`s in the route.** Every field in
 * this body is forwarded verbatim into a spawned container the caller cannot see:
 * the `join` becomes `CADRE_CLAIM_SECRET` or `CADRE_INVITATION`, `profile` and
 * `strandFilter` become environment variables (`service/container-env.ts`), and
 * `resources` become Docker limits. A field the route forgets to check is not a 400
 * — it is a container that dies at boot, or comes up subtly wrong, with a 201
 * already sent. Routing the body through one function that *constructs* the request
 * object means a field can only reach the spawn path by having been through here;
 * adding a field to `CreateContainerRequest` without validating it stops compiling
 * rather than silently shipping. A body field this does not read never reaches the
 * container.
 *
 * The invitation bundle's rule lives in its own module, with the reasoning behind it
 * (`invitation-validation.ts`). The rest — plain type and enum checks, and what each
 * `join` kind requires of the provider — are here.
 */

import {
  type ContainerJoinRequest,
  type ContainerResources,
  type CreateContainerRequest,
  UNCLAIMED_PARTY_ID,
} from '../types.js';
import { parseCpuLimit, parseMemoryLimit } from '../service/resource-limits.js';
import { validateInvitation } from './invitation-validation.js';

/** What the provider contributes to the check: the one rule that depends on its config rather than the body. */
export interface CreateRequestOptions {
  /**
   * Whether this provider's containers can be claimed: true when it announces a public
   * address for them (`docker.publicHost`). A container is claimed by being dialed with
   * its node code, and without a public address nothing outside the machine can dial it.
   */
  claimable: boolean;
}

/** What a `join` settles: how the container joins, and the party that follows from it. */
interface ValidatedJoin {
  join: ContainerJoinRequest;
  partyId: string;
}

/**
 * `join.kind: 'claim'`: the container starts waiting to be claimed, with the placeholder
 * party; the claim names the party and the owner. Only a provider whose containers can be
 * dialed accepts it.
 */
function validateClaimJoin(options: CreateRequestOptions): ValidatedJoin | { error: string } {
  if (!options.claimable) {
    return { error: 'join.kind "claim" requires docker.publicHost: a container is claimed by being dialed, and this provider announces no public address for its containers' };
  }
  return { join: { kind: 'claim' }, partyId: UNCLAIMED_PARTY_ID };
}

/**
 * `join.kind: 'invitation'`: the container redeems the bundle at a member it names. The
 * bundle supplies the party, the members to dial and the owner keys the node pins itself.
 * No public address is needed: the container dials out.
 */
function validateInvitationJoin(invitation: unknown): ValidatedJoin | { error: string } {
  const checked = validateInvitation(invitation);
  if ('error' in checked) return checked;
  return { join: { kind: 'invitation', invitation: checked.invitation }, partyId: checked.partyId };
}

/** The required `join`: one of the two kinds above. */
function validateJoin(value: unknown, options: CreateRequestOptions): ValidatedJoin | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'join is required: an object with kind "claim" or "invitation"' };
  }
  const { kind, invitation } = value as Record<string, unknown>;
  if (kind === 'claim') return validateClaimJoin(options);
  if (kind === 'invitation') return validateInvitationJoin(invitation);
  return { error: 'join.kind must be "claim" or "invitation"' };
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
 * Resource limits. `memoryLimit` / `cpuLimit` must be text the orchestrator can turn into a
 * Docker limit (`service/resource-limits.ts`, the same rule the config's defaults are held to):
 * text it cannot read used to pass through and start the container with *no* limit at all.
 * `storageQuotaBytes` becomes `CADRE_STORAGE_QUOTA`, so only its kind is checked.
 */
function validateResources(value: unknown): { resources?: ContainerResources } | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'resources must be an object' };
  }

  const { memoryLimit, cpuLimit, storageQuotaBytes } = value as Record<string, unknown>;
  if (memoryLimit !== undefined && (typeof memoryLimit !== 'string' || parseMemoryLimit(memoryLimit) === undefined)) {
    return { error: 'resources.memoryLimit must be a size like "512M" or "2G"' };
  }
  if (cpuLimit !== undefined && (typeof cpuLimit !== 'string' || parseCpuLimit(cpuLimit) === undefined)) {
    return { error: 'resources.cpuLimit must be a number of CPUs written as a string, like "0.5" or "2"' };
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
  options: CreateRequestOptions,
): { request: CreateContainerRequest } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' };
  }
  const fields = body as Record<string, unknown>;

  const join = validateJoin(fields.join, options);
  if ('error' in join) return join;

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
      partyId: join.partyId,
      profile: profile.profile,
      join: join.join,
      ...(strandFilter.strandFilter !== undefined ? { strandFilter: strandFilter.strandFilter } : {}),
      ...(resources.resources ? { resources: resources.resources } : {}),
      ...(tags.tags ? { tags: tags.tags } : {}),
    },
  };
}
