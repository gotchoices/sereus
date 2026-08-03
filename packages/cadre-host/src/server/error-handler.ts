/**
 * Fastify error handler — translates known typed errors to stable HTTP status
 * codes and uniform `{ ok: false, error: { code, message } }` payloads.
 *
 * Codes (cross-referenced with `auth/types.ts`, `nat/types.ts`, `strands/types.ts`,
 * `update/types.ts`):
 *   - TrustCircleError
 *       invalid_label, invalid_token             → 400
 *       not_found, already_redeemed              → 404
 *       expired                                  → 410
 *       node_unavailable                         → 503
 *       storage_error                            → 500
 *   - NatError
 *       invalid_config, ddns_provider_unknown,
 *       ddns_credentials_missing                 → 400
 *       secrets_unavailable, storage_error,
 *       mapping_failed, router_unreachable,
 *       ip_detection_failed, ddns_update_failed  → 500
 *       node_unavailable                         → 503
 *   - StrandError
 *       invalid_id                               → 400
 *       confirmation_required                    → 428
 *       node_unavailable                         → 503
 *       internal                                 → 500
 *   - UpdateErrorException
 *       manifest_invalid, no_update_available,
 *       min_previous_version                     → 400
 *       apply_in_progress                        → 409
 *       signature_invalid, unsupported_state_version,
 *       apply_failed, rollback_failed, storage_error → 500
 *   - GrantError
 *       invalid_label, invalid_max_nodes,
 *       invalid_ttl                              → 400
 *       not_found                                → 404
 *       storage_error                            → 500
 *   - DonationError
 *       invalid_request                          → 400
 *       unauthorized                             → 401
 *       forbidden                                → 403
 *       not_found                                → 404
 *       invalid_state                            → 409
 *       quota_exceeded                           → 429
 *       orchestrator_error, storage_error        → 500
 *       seed_failed                              → 502
 *       peer_unavailable                         → 503
 *   - everything else                            → 500 (code "internal")
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import debug from 'debug';

import { TrustCircleError, type TrustCircleErrorCode } from '../auth/types.js';
import { NatError, type NatErrorCode } from '../nat/types.js';
import { StrandError, type StrandErrorCode } from '../strands/types.js';
import { UpdateErrorException, type UpdateErrorCode } from '../update/types.js';
import { GrantError, type GrantErrorCode, DonationError, type DonationErrorCode } from '../donation/types.js';

const log = debug('cadre:host:error-handler');

const TRUST_STATUS: Record<TrustCircleErrorCode, number> = {
  invalid_label: 400,
  invalid_token: 400,
  not_found: 404,
  already_redeemed: 404,
  expired: 410,
  storage_error: 500,
  node_unavailable: 503,
};

const NAT_STATUS: Record<NatErrorCode, number> = {
  invalid_config: 400,
  ddns_provider_unknown: 400,
  ddns_credentials_missing: 400,
  secrets_unavailable: 500,
  storage_error: 500,
  mapping_failed: 500,
  router_unreachable: 500,
  ip_detection_failed: 500,
  ddns_update_failed: 500,
  node_unavailable: 503,
};

/**
 * 428 (Precondition Required) for `confirmation_required`: the node refused a
 * closed-strand removal because the caller had not confirmed. It is not a 400
 * (the request was well-formed) and not a 409 (nothing conflicts) — the caller
 * must re-send with the precondition satisfied.
 */
const STRAND_STATUS: Record<StrandErrorCode, number> = {
  invalid_id: 400,
  confirmation_required: 428,
  node_unavailable: 503,
  internal: 500,
};

const GRANT_STATUS: Record<GrantErrorCode, number> = {
  invalid_label: 400,
  invalid_max_nodes: 400,
  invalid_ttl: 400,
  not_found: 404,
  storage_error: 500,
};

const DONATION_STATUS: Record<DonationErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  quota_exceeded: 429,
  invalid_request: 400,
  not_found: 404,
  invalid_state: 409,
  seed_failed: 502,
  peer_unavailable: 503,
  orchestrator_error: 500,
  storage_error: 500,
};

const UPDATE_STATUS: Record<UpdateErrorCode, number> = {
  manifest_invalid: 400,
  no_update_available: 400,
  min_previous_version: 400,
  apply_in_progress: 409,
  signature_invalid: 500,
  unsupported_state_version: 500,
  apply_failed: 500,
  rollback_failed: 500,
  storage_error: 500,
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const { status, code, message } = classify(err);
    if (status >= 500) {
      log('5xx %s %s: [%s] %s', request.method, request.url, code, message);
    } else {
      log('%d %s %s: [%s] %s', status, request.method, request.url, code, message);
    }
    return reply.code(status).send({
      ok: false,
      error: { code, message },
    });
  });
}

interface Classified {
  status: number;
  code: string;
  message: string;
}

function classify(err: FastifyError): Classified {
  if (err instanceof TrustCircleError) {
    return { status: TRUST_STATUS[err.code] ?? 500, code: err.code, message: err.message };
  }
  if (err instanceof NatError) {
    return { status: NAT_STATUS[err.code] ?? 500, code: err.code, message: err.message };
  }
  if (err instanceof StrandError) {
    return { status: STRAND_STATUS[err.code] ?? 500, code: err.code, message: err.message };
  }
  if (err instanceof UpdateErrorException) {
    return { status: UPDATE_STATUS[err.code] ?? 500, code: err.code, message: err.message };
  }
  if (err instanceof GrantError) {
    return { status: GRANT_STATUS[err.code] ?? 500, code: err.code, message: err.message };
  }
  if (err instanceof DonationError) {
    return { status: DONATION_STATUS[err.code] ?? 500, code: err.code, message: err.message };
  }
  // Fastify body-parsing / validation errors have a statusCode we should honour.
  if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600) {
    return {
      status: err.statusCode,
      code: err.code ?? (err.statusCode === 404 ? 'not_found' : 'bad_request'),
      message: err.message ?? 'request failed',
    };
  }
  return { status: 500, code: 'internal', message: err.message || 'internal error' };
}
