/**
 * Authority-node delegation surface for cadre-host.
 *
 * The manager process spawns the admin's authority cadre node (via
 * `HostProcessOrchestrator`) and delegates authority/membership/identity
 * operations to it over the loopback admin channel using
 * {@link AuthorityNodeClient}. See `docs/cadre-host.md` § Control-plane
 * separation.
 */

export { AuthorityNodeClient, AuthorityNodeUnavailableError } from './authority-node-client.js';
export type { AuthorityNodeClientOptions } from './authority-node-client.js';
