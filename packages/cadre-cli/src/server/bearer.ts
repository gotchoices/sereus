import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/**
 * Why a request failed the bearer check: it presented no `Bearer` credential at
 * all, or one that does not match. Safe to log — it says nothing about the
 * credential itself.
 */
export type BearerRefusal = 'missing' | 'mismatch';

const BEARER_PREFIX = 'Bearer ';

/**
 * Constant-time `Authorization: Bearer <token>` check shared by the admin
 * channel and the health server's seed route. Returns why the request is
 * refused, or `undefined` when it is authorized.
 *
 * A length mismatch short-circuits before the constant-time compare — the
 * timing leak of token length is not meaningful for a fixed-length secret, and
 * `timingSafeEqual` throws on unequal-length buffers. An empty configured token
 * refuses everything.
 */
export function bearerRefusal(req: http.IncomingMessage, token: string): BearerRefusal | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return 'missing';
  if (token.length === 0) return 'mismatch';

  const provided = Buffer.from(header.slice(BEARER_PREFIX.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) return 'mismatch';
  return timingSafeEqual(provided, expected) ? undefined : 'mismatch';
}

/** Whether the request carries the expected bearer token — see {@link bearerRefusal}. */
export function checkBearer(req: http.IncomingMessage, token: string): boolean {
  return bearerRefusal(req, token) === undefined;
}
