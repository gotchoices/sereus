/**
 * Permission scope model for provider routes.
 */

/** Permission scopes used by provider routes. */
export const Scope = {
  ContainersRead: 'containers:read',
  ContainersCreate: 'containers:create',
  ContainersDelete: 'containers:delete',
  ContainersSeed: 'containers:seed',
  BillingRead: 'billing:read',
} as const;
export type Scope = typeof Scope[keyof typeof Scope];

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
