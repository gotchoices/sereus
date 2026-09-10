/**
 * The whole shape check for `POST /grants` — one call that either yields the
 * typed {@link DonationProvisionRequest} the `DonationService` is handed, or the
 * message the route answers 400 with.
 *
 * **Why a validator rather than a few more `if`s in the route.** Every field in
 * this body is forwarded into a child process the requester cannot see:
 * `partyId`, `bootstrapNodes` and `profile` are written into the child's
 * `cadre.json` (`orchestrator/host-process-orchestrator.ts`) and `ownerKeys`
 * become its cold-start seed-trust anchors. A field the route forgets to check is
 * not a 400 — it is a donated node that dies at boot, or comes up subtly wrong,
 * with a 201 already sent. Routing the body through one function that *constructs*
 * the request object means a field can only reach the spawn path by having been
 * through here; adding a field to `DonationProvisionRequest` without validating it
 * stops compiling rather than silently shipping.
 *
 * **Division of labour with `DonationService.provision`.** The Ed25519 rule for
 * `ownerKeys` stays in the service, where it is applied by cadre-core's own
 * `requireEd25519PublicKeyB64` — the service is also reached by the respawn path,
 * which replays a persisted record rather than an HTTP body, so the crypto rule
 * has to live there to cover both. What this validator owns for `ownerKeys` is the
 * *container* shape (present, non-empty, all strings), which the service's rule
 * assumes: a number reaching it surfaces as an internal `.trim is not a function`
 * rather than as a message naming what is wrong with the request.
 *
 * The multiaddr rule has no such home — it is duplicated in cadre-provider — so it
 * lives in `bootstrap-node-validation.ts` next to the comment saying so.
 */

import type { DonationProvisionRequest } from '../../donation/donation-service.js';
import { validateBootstrapNodes } from './bootstrap-node-validation.js';

/** `partyId` becomes `controlNetwork.partyId` in the child's config. */
function validatePartyId(value: unknown): { partyId: string } | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: 'partyId is required' };
  }
  return { partyId: value.trim() };
}

/**
 * Container shape only — see the module comment: the per-key Ed25519 rule is
 * `DonationService.provision`'s, so the respawn path gets it too.
 */
function validateOwnerKeys(value: unknown): { ownerKeys: string[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'ownerKeys is required' };
  }
  if (!value.every((key): key is string => typeof key === 'string')) {
    return { error: 'ownerKeys must be an array of strings' };
  }
  return { ownerKeys: value };
}

/** Absent means `storage` — see {@link DonationProvisionRequest.profile}. */
function validateProfile(value: unknown): { profile?: DonationProvisionRequest['profile'] } | { error: string } {
  if (value === undefined) return {};
  if (value !== 'storage' && value !== 'transaction') {
    return { error: 'profile must be "storage" or "transaction"' };
  }
  return { profile: value };
}

/**
 * Validate a `POST /grants` body and build the request `DonationService.provision`
 * is handed.
 *
 * `grantToken` comes from the `Authorization` bearer rather than the body — a
 * requester does not get to name which grant pays for this — so it is a
 * parameter, not a validated field. Whether that grant is live and within quota is
 * `provision`'s call, not this function's.
 *
 * @returns the typed provision request, or the message to answer `invalid_request` with.
 */
export function validateProvisionRequest(
  body: unknown,
  grantToken: string,
): { request: DonationProvisionRequest } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' };
  }
  const fields = body as Record<string, unknown>;

  const partyId = validatePartyId(fields.partyId);
  if ('error' in partyId) return partyId;

  const bootstrap = validateBootstrapNodes(fields.bootstrapNodes);
  if ('error' in bootstrap) return bootstrap;

  const ownerKeys = validateOwnerKeys(fields.ownerKeys);
  if ('error' in ownerKeys) return ownerKeys;

  const profile = validateProfile(fields.profile);
  if ('error' in profile) return profile;

  return {
    request: {
      grantToken,
      partyId: partyId.partyId,
      bootstrapNodes: bootstrap.nodes,
      ownerKeys: ownerKeys.ownerKeys,
      ...(profile.profile ? { profile: profile.profile } : {}),
    },
  };
}
