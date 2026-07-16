import { randomBytes } from 'node:crypto';
import debug from 'debug';

import type { GrantStore } from './grant-store.js';
import type {
  Grant,
  GrantAdminHandlers,
  GrantValidation,
  GrantValidator,
} from './types.js';
import { GrantError } from './types.js';

const log = debug('cadre:host:grant-service');

/** Token byte length (base64url-encoded; ~43 chars). Matches trust-circle. */
const TOKEN_BYTES = 32;

/** Default node cap when the admin doesn't specify one. */
export const DEFAULT_MAX_NODES = 1;

/** Constructor options. */
export interface GrantServiceOptions {
  /** Persistent grant store (`grants.json`). */
  store: GrantStore;
  /** Clock override for tests. */
  now?: () => Date;
}

/**
 * GrantService — issues, validates, lists, and revokes donation grant tokens.
 *
 * It is the authority for a grant's *identity, expiry, and revocation*, and
 * for the per-grantee *node cap* (`maxNodes`). It is deliberately **not** the
 * authority for how many nodes are currently live under a grant — that tally
 * belongs to the donation service (`2-donation-service`), which persists the
 * grant→node records and can see terminations. `validateForProvision` takes
 * the count as a parameter so the two never drift.
 *
 * All methods are synchronous: issuance/validation/revocation are pure local
 * store operations with no node round-trip (unlike the trust-circle flow,
 * which delegates to the owner node).
 */
export class GrantService implements GrantValidator {
  private readonly store: GrantStore;
  private readonly now: () => Date;

  constructor(opts: GrantServiceOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Issue a new grant. Generates a high-entropy base64url token, persists it,
   * and returns the whole `Grant` (the CLI/UI prints/QR-encodes the token).
   */
  issue(opts: { label: string; maxNodes?: number; ttlMs?: number }): Grant {
    const label = normaliseLabel(opts.label);
    const maxNodes = normaliseMaxNodes(opts.maxNodes);

    const created = this.now();
    const grant: Grant = {
      token: generateToken(),
      label,
      maxNodes,
      createdAt: created.toISOString(),
    };

    if (opts.ttlMs !== undefined) {
      if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
        throw new GrantError('invalid_ttl', `Invalid ttlMs: ${opts.ttlMs}`);
      }
      grant.expiresAt = new Date(created.getTime() + opts.ttlMs).toISOString();
    }

    this.store.add(grant);
    log('issued grant "%s" (token=%s, maxNodes=%d, expires=%s)',
      label, grant.token, maxNodes, grant.expiresAt ?? 'never');
    return grant;
  }

  /**
   * Validate a presented bearer token for a non-provisioning op: it must name a
   * known grant that is neither revoked nor expired. No quota check. Never
   * throws for a bad token — returns a denial.
   */
  validate(token: string): GrantValidation {
    if (!token) return { ok: false, reason: 'unknown_token' };
    const grant = this.store.get(token);
    if (!grant) return { ok: false, reason: 'unknown_token' };

    // Revocation is an explicit admin action; check it before expiry so a
    // grant that is both revoked and expired reports the stronger signal.
    if (grant.revokedAt) return { ok: false, grant, reason: 'revoked' };

    if (grant.expiresAt) {
      const expiresAt = new Date(grant.expiresAt);
      if (Number.isFinite(expiresAt.getTime()) && this.now() > expiresAt) {
        return { ok: false, grant, reason: 'expired' };
      }
    }

    return { ok: true, grant };
  }

  /**
   * Validate for a *new* provision request. Runs the identity/expiry/revocation
   * checks of `validate`, then — only if those pass — consults the
   * caller-supplied live-node tally against the grant's `maxNodes`.
   *
   * Concurrency boundary: this is a pure function of the passed count. Two
   * provision requests racing at the quota edge (both seeing count = N-1)
   * would both pass here; serialising them so only one wins is the donation
   * service's responsibility (`2-donation-service` owns the grant→node lock).
   */
  validateForProvision(
    token: string,
    liveNodeCount: (token: string) => number,
  ): GrantValidation {
    const base = this.validate(token);
    if (!base.ok || !base.grant) return base;

    const live = liveNodeCount(token);
    if (live >= base.grant.maxNodes) {
      return { ok: false, grant: base.grant, reason: 'quota_exceeded' };
    }
    return { ok: true, grant: base.grant };
  }

  /**
   * Revoke a grant by token: mark it revoked (denies future requests). Existing
   * live nodes are **not** torn down here — that is a separate admin action via
   * the donation service's terminate (`2-donation-service`). Throws not_found
   * when the token is unknown.
   */
  revoke(token: string): void {
    if (!this.store.markRevoked(token, this.now().toISOString())) {
      throw new GrantError('not_found', `Unknown grant: ${token}`);
    }
    log('revoked grant (token=%s)', token);
  }

  /** Enumerate all grants (for the CLI / UI). */
  list(): Grant[] {
    return this.store.list();
  }
}

/**
 * Wrap a GrantService into the typed handler shape consumed by the loopback
 * management server's `/grants-admin` routes. Errors propagate as GrantError;
 * the server maps `.code` → HTTP status.
 */
export function createGrantAdminHandlers(service: GrantService): GrantAdminHandlers {
  return {
    async postGrant(body) {
      if (!body || typeof body.label !== 'string') {
        throw new GrantError('invalid_label', 'label is required');
      }
      const grant = service.issue({
        label: body.label,
        ...(body.maxNodes !== undefined ? { maxNodes: body.maxNodes } : {}),
        ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
      });
      return { grant };
    },
    async listGrants() {
      return { grants: service.list() };
    },
    async deleteGrant(token) {
      service.revoke(token);
    },
  };
}

function generateToken(): string {
  // base64url so it survives in URLs, QR codes, and shell arguments.
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function normaliseLabel(label: unknown): string {
  if (typeof label !== 'string') {
    throw new GrantError('invalid_label', 'label must be a string');
  }
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw new GrantError('invalid_label', 'label must not be empty');
  }
  if (trimmed.length > 200) {
    throw new GrantError('invalid_label', 'label must be 200 characters or fewer');
  }
  return trimmed;
}

function normaliseMaxNodes(maxNodes: unknown): number {
  if (maxNodes === undefined) return DEFAULT_MAX_NODES;
  if (typeof maxNodes !== 'number' || !Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new GrantError('invalid_max_nodes', `maxNodes must be a positive integer (got ${JSON.stringify(maxNodes)})`);
  }
  return maxNodes;
}
