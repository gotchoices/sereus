import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time `Authorization: Bearer <token>` check shared by the admin
 * channel and the health server's seed route.
 *
 * A length mismatch short-circuits before the constant-time compare — the
 * timing leak of token length is not meaningful for a fixed-length secret, and
 * `timingSafeEqual` throws on unequal-length buffers.
 */
export function checkBearer(req: http.IncomingMessage, token: string): boolean {
  if (token.length === 0) return false;
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;

  const provided = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
