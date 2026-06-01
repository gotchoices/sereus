/**
 * Fastify error handler — translates known typed errors to stable HTTP status
 * codes and uniform `{ ok: false, error: { code, message } }` payloads.
 *
 * Codes (cross-referenced with `auth/types.ts`, `nat/types.ts`, `update/types.ts`):
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
 *   - UpdateErrorException
 *       manifest_invalid, no_update_available,
 *       min_previous_version                     → 400
 *       apply_in_progress                        → 409
 *       signature_invalid, unsupported_state_version,
 *       apply_failed, rollback_failed, storage_error → 500
 *   - everything else                            → 500 (code "internal")
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import debug from 'debug';

import { TrustCircleError, type TrustCircleErrorCode } from '../auth/types.js';
import { NatError, type NatErrorCode } from '../nat/types.js';
import { UpdateErrorException, type UpdateErrorCode } from '../update/types.js';

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
  if (err instanceof UpdateErrorException) {
    return { status: UPDATE_STATUS[err.code] ?? 500, code: err.code, message: err.message };
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
