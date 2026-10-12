/**
 * Permission scope model for provider routes.
 */

/** Permission scopes used by provider routes. */
export const Scope = {
  ContainersRead: 'containers:read',
  ContainersCreate: 'containers:create',
  ContainersDelete: 'containers:delete',
  BillingRead: 'billing:read',
} as const;
export type Scope = typeof Scope[keyof typeof Scope];

/**
 * Whether `scope` is one a token may carry: a `Scope`, or `<resource>:*` for a resource that
 * has one. What a registered OAuth client may be allowed and what an authorize request may
 * ask for; the global `*` is not, since it belongs to static admin keys only.
 */
export function isKnownScope(scope: string): boolean {
  const scopes: string[] = Object.values(Scope);
  if (scopes.includes(scope)) return true;
  if (!scope.endsWith(':*')) return false;
  const resource = scope.slice(0, -2);
  return scopes.some((known) => known.startsWith(`${resource}:`));
}

/**
 * True if `permissions` grants `scope`. Supports the global wildcard '*'
 * and per-resource wildcards like 'containers:*', plus exact matches.
 */
export function hasPermission(permissions: string[], scope: string): boolean {
  const colon = scope.indexOf(':');
  const resource = colon === -1 ? undefined : scope.slice(0, colon);
  for (const granted of permissions) {
    if (granted === '*' || granted === scope) return true;
    if (resource !== undefined && granted === `${resource}:*`) return true;
  }
  return false;
}
