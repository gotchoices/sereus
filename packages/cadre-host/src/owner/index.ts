/**
 * Owner-node delegation surface for cadre-host.
 *
 * The manager process spawns the admin's owner cadre node (via
 * `HostProcessOrchestrator`) and delegates owner/membership/identity
 * operations to it over the loopback admin channel using
 * {@link OwnerNodeClient}. See `docs/cadre-host.md` § Control-plane
 * separation.
 */

export { OwnerNodeClient, OwnerNodeUnavailableError } from './owner-node-client.js';
export type { OwnerNodeClientOptions } from './owner-node-client.js';
