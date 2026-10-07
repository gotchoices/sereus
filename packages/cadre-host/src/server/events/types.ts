/**
 * Event types broadcast over the SPA's SSE channel.
 *
 * Publishers (orchestrator hook, route adapters, NAT change listener, update
 * observer) call EventBus.publish; the `/api/events` route fan-outs to
 * connected clients.
 */

import type { ContainerStatus } from '@serfab/cadre-provider';

import type { DirectReachability } from '../../nat/index.js';

export type LocalUiEvent =
  | { type: 'node-state-changed'; nodeId: string; status: ContainerStatus }
  | { type: 'strands-changed'; kind: 'removed' }
  | { type: 'grants-changed'; kind: 'issued' | 'revoked' | 'terminated' }
  | { type: 'connectivity-changed'; directReachability: DirectReachability }
  | { type: 'update-available'; version: string; releaseNotesUrl?: string };

export type LocalUiEventType = LocalUiEvent['type'];
