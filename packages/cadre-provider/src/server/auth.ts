/**
 * Authentication middleware for the Provider API.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import debug from 'debug';
import type { AuthConfig } from '../config/types.js';
import { validateAuthConfig } from '../config/validate.js';
import type { ProviderStore } from '../service/store.js';
import type { CustomerIdentity } from './routes.js';

const log = debug('cadre:provider:auth');

/** Authentication hooks for custom auth logic */
export interface AuthHooks {
  /** Validate an API key and return customer identity */
  validateApiKey?(key: string): Promise<CustomerIdentity | undefined>;
  /** Validate a JWT token and return customer identity */
  validateJwt?(token: string): Promise<CustomerIdentity | undefined>;
}

/** Authentication context */
export interface AuthContext {
  config: AuthConfig;
  store: ProviderStore;
  hooks?: AuthHooks;
}

/** Hash an API key for storage/comparison */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Register authentication middleware */
export function registerAuth(app: FastifyInstance, ctx: AuthContext): void {
  const { config, store, hooks } = ctx;

  // Defense in depth: programmatic construction that bypasses loadConfig must
  // not silently go fully open in 'none' mode without an explicit opt-in.
  validateAuthConfig(config);

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health/status endpoints
    if (request.url.endsWith('/status') || request.url.endsWith('/health')) {
      return;
    }

    // No auth mode - for development
    if (config.mode === 'none') {
      (request as any).customer = {
        customerId: 'dev-customer',
        permissions: ['*'],
      } as CustomerIdentity;
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      log('Missing authorization header');
      return reply.status(401).send({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
      });
    }

    try {
      let customer: CustomerIdentity | undefined;

      // API key authentication
      if (config.mode === 'api-key') {
        const key = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : authHeader;

        // Custom hook takes precedence
        if (hooks?.validateApiKey) {
          customer = await hooks.validateApiKey(key);
        } else {
          // Default: lookup in store
          const keyHash = hashApiKey(key);

          // Check static config keys first
          if (config.apiKeyHashes?.includes(keyHash)) {
            customer = { customerId: 'admin', permissions: ['*'] };
          } else {
            const apiKey = await store.getApiKey(keyHash);
            if (apiKey) {
              // Check expiration
              if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
                log('API key expired');
              } else {
                customer = {
                  customerId: apiKey.customerId,
                  permissions: apiKey.permissions,
                };
                // Update last used
                apiKey.lastUsedAt = new Date();
                await store.saveApiKey(apiKey);
              }
            }
          }
        }
      }

      // OAuth/JWT authentication
      if (config.mode === 'oauth') {
        const token = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : authHeader;

        if (hooks?.validateJwt) {
          customer = await hooks.validateJwt(token);
        } else {
          // Without custom hook, we can't validate JWTs
          // In production, you'd integrate with your JWT library
          log('OAuth mode requires validateJwt hook');
        }
      }

      if (!customer) {
        log('Authentication failed');
        return reply.status(401).send({
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
        });
      }

      (request as any).customer = customer;
      log('Authenticated customer: %s', customer.customerId);

    } catch (error) {
      log('Auth error: %O', error);
      return reply.status(401).send({
        ok: false,
        error: { code: 'AUTH_ERROR', message: 'Authentication failed' },
      });
    }
  });

  log('Authentication middleware registered, mode: %s', config.mode);
}

