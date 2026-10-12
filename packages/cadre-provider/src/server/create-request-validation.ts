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
 * The three field rules with real substance live in their own modules, each with the
 * reasoning behind it: `owner-key-validation.ts` (the Ed25519 rule, a copy of
 * cadre-core's), `bootstrap-node-validation.ts` (the multiaddr rule, and when the
 * list may be empty) and `invitation-validation.ts` (the cadre invitation bundle a
 * `join.kind: 'invitation'` carries). The rest — plain type and enum checks, and which
 * fields a `join` excludes — are here.
 */

import {
  type ContainerJoinRequest,
  type ContainerResources,
  type CreateContainerRequest,
  UNCLAIMED_PARTY_ID,
} from '../types.js';
import { parseCpuLimit, parseMemoryLimit } from '../service/resource-limits.js';
import { type BootstrapNodesOptions, validateBootstrapNodes } from './bootstrap-node-validation.js';
import { validatePinnedOwnerKeys } from './owner-key-validation.js';
import { validateInvitation } from './invitation-validation.js';

/** `partyId` becomes `CADRE_PARTY_ID`, so a non-string would be stringified into it. */
function validatePartyId(value: unknown): { partyId: string } | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: 'partyId is required' };
  }
  return { partyId: value.trim() };
}

/** What a `join` settles: how the container joins, and the party that follows from it. */
interface ValidatedJoin {
  join: ContainerJoinRequest;
  partyId: string;
}

/**
 * Whether a body field was given beside a `join`. `bootstrapNodes: []` counts as not given:
 * it is how the publicHost path already spells "no bootstrap peers", and both joins want
 * exactly that.
 */
function isGivenBesideJoin(field: string, value: unknown): boolean {
  if (value === undefined) return false;
  return field !== 'bootstrapNodes' || !(Array.isArray(value) && value.length === 0);
}

/** The refusal of the first of `fields` given beside a `join`, naming the field, or undefined. */
function refuseBesideJoin(
  body: Record<string, unknown>,
  kind: ContainerJoinRequest['kind'],
  fields: readonly string[],
  reason: string,
): { error: string } | undefined {
  const given = fields.find(field => isGivenBesideJoin(field, body[field]));
  return given ? { error: `${given} must be absent with join.kind "${kind}": ${reason}` } : undefined;
}

/**
 * `join.kind: 'claim'`: the container starts waiting to be claimed, with the placeholder
 * party. Only a dialable container can be claimed — the phone dials it with the code — so
 * the provider must announce a public address (`docker.publicHost`, the same flag that
 * makes `bootstrapNodes` optional). The claim names the party and the owner, so `partyId`,
 * `bootstrapNodes` and `pinnedOwnerKeys` are refused rather than merged: an unclaimed node
 * has nobody to dial, and a pin beside a claim is refused by `cadre start`.
 */
function validateClaimJoin(body: Record<string, unknown>, options: BootstrapNodesOptions): ValidatedJoin | { error: string } {
  if (!options.optional) {
    return { error: 'join.kind "claim" requires docker.publicHost: a container is claimed by being dialed, and this provider announces no public address for its containers' };
  }
  const conflict = refuseBesideJoin(body, 'claim', ['partyId', 'bootstrapNodes', 'pinnedOwnerKeys'], 'a container that is claimed takes its party and owner from the claim');
  if (conflict) return conflict;
  return { join: { kind: 'claim' }, partyId: UNCLAIMED_PARTY_ID };
}

/**
 * `join.kind: 'invitation'`: the container redeems the bundle at a member it names. The
 * bundle supplies the party (a body `partyId` may repeat it, never contradict it), the
 * members to dial (`bootstrapNodes` is refused) and the owner keys the node pins itself
 * (`pinnedOwnerKeys` is refused). No public address is needed: the container dials out.
 */
function validateInvitationJoin(body: Record<string, unknown>, invitation: unknown): ValidatedJoin | { error: string } {
  const checked = validateInvitation(invitation);
  if ('error' in checked) return checked;
  const conflict = refuseBesideJoin(body, 'invitation', ['bootstrapNodes', 'pinnedOwnerKeys'], 'the invitation names the members to dial and carries the owner keys the node pins itself');
  if (conflict) return conflict;
  if (body.partyId !== undefined) {
    const partyId = validatePartyId(body.partyId);
    if ('error' in partyId) return partyId;
    if (partyId.partyId !== checked.partyId) {
      return { error: 'partyId disagrees with the invitation: the bundle names the cadre the container joins, so leave partyId out or give the same value' };
    }
  }
  return { join: { kind: 'invitation', invitation: checked.invitation }, partyId: checked.partyId };
}

/** The optional `join`: absent is the seed path; otherwise one of the two kinds above. */
function validateJoin(body: Record<string, unknown>, options: BootstrapNodesOptions): ValidatedJoin | { error: string } | undefined {
  const value = body.join;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'join must be an object with kind "claim" or "invitation"' };
  }
  const { kind, invitation } = value as Record<string, unknown>;
  if (kind === 'claim') return validateClaimJoin(body, options);
  if (kind === 'invitation') return validateInvitationJoin(body, invitation);
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
 * `bootstrapNodes` is the one field whose rule depends on the provider rather than
 * the body: see {@link BootstrapNodesOptions}. A `join` shares the flag: a claim needs
 * the public address it stands for, an invitation does not.
 *
 * @returns the typed create request, or the message to answer `INVALID_REQUEST` with.
 */
export function validateCreateContainerRequest(
  body: unknown,
  customerId: string,
  bootstrapNodesOptions: BootstrapNodesOptions,
): { request: CreateContainerRequest } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' };
  }
  const fields = body as Record<string, unknown>;

  // First, because a join settles the party and excludes the seed-path fields below.
  const join = validateJoin(fields, bootstrapNodesOptions);
  if (join && 'error' in join) return join;

  const partyId = join ? { partyId: join.partyId } : validatePartyId(fields.partyId);
  if ('error' in partyId) return partyId;

  // A join already refused a non-empty list, so `optional` here can only yield [] — the
  // provider's own flag is for the seed path, where the container must dial somebody.
  const bootstrap = validateBootstrapNodes(fields.bootstrapNodes, join ? { optional: true } : bootstrapNodesOptions);
  if ('error' in bootstrap) return bootstrap;

  // Optional, but create is the last point where the caller can still supply it —
  // a seed-path container created without it refuses every seed. (Refused beside a join above.)
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
      ...(join ? { join: join.join } : {}),
    },
  };
}
