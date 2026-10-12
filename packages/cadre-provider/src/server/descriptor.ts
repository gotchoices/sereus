/**
 * The provider descriptor: what `GET /descriptor` publishes about this provider, the document
 * an app's store screen renders and the one `cadre-core`'s `parseProviderDescriptor` reads.
 * Computed from the config at request time, so it never disagrees with the registered routes.
 */

import type { FastifyInstance } from 'fastify';
import type { ProviderConfig } from '../config/types.js';

/** Version 1 of the descriptor; `docs/architecture.md` → Provider descriptor and sign-in states each field. */
export interface ProviderDescriptor {
  v: 1;
  /** `provider.id`: stable, what an app keys its rental records by. */
  id: string;
  name: string;
  /** `provider.publicUrl` plus `server.basePath`: the root every API route hangs off. */
  apiBaseUrl: string;
  /**
   * The built-in sign-in endpoints and the union of the registered clients' scope allowances.
   * Absent when the provider validates bearers through an external identity provider alone
   * (`auth.oauth` unset): such a provider publishes a descriptor of its own naming that
   * provider's endpoints, since an app needs these two URLs to sign in.
   */
  oauth?: { authorizeUrl: string; tokenUrl: string; scopes: string[] };
  /** `GET /billing/plans`, public. */
  plansUrl: string;
  termsUrl?: string;
  regions?: string[];
  icon?: string;
}

/** The descriptor for `config`, or `undefined` without a `provider` block. */
export function buildProviderDescriptor(
  config: Pick<ProviderConfig, 'provider' | 'auth'>,
  basePath: string,
): ProviderDescriptor | undefined {
  const identity = config.provider;
  if (!identity) return undefined;
  const apiBaseUrl = `${identity.publicUrl.replace(/\/+$/, '')}${basePath}`;
  const clients = config.auth.mode === 'oauth' ? config.auth.oauth?.clients : undefined;
  return {
    v: 1,
    id: identity.id,
    name: identity.name,
    apiBaseUrl,
    ...(clients
      ? {
          oauth: {
            authorizeUrl: `${apiBaseUrl}/oauth/authorize`,
            tokenUrl: `${apiBaseUrl}/oauth/token`,
            scopes: [...new Set(clients.flatMap((client) => client.scopes))],
          },
        }
      : {}),
    plansUrl: `${apiBaseUrl}/billing/plans`,
    ...(identity.termsUrl !== undefined ? { termsUrl: identity.termsUrl } : {}),
    ...(identity.regions !== undefined ? { regions: identity.regions } : {}),
    ...(identity.icon !== undefined ? { icon: identity.icon } : {}),
  };
}

/** `GET <basePath>/descriptor`, public: the descriptor, or 404 `NOT_CONFIGURED` without a `provider` block. */
export function registerDescriptorRoute(
  app: FastifyInstance,
  ctx: { basePath: string; config: Pick<ProviderConfig, 'provider' | 'auth'> },
): void {
  app.get(`${ctx.basePath}/descriptor`, async (_request, reply) => {
    const descriptor = buildProviderDescriptor(ctx.config, ctx.basePath);
    if (!descriptor) {
      return reply.status(404).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'This provider has no provider block (id, name, publicUrl) configured' },
      });
    }
    return reply.send(descriptor);
  });
}
