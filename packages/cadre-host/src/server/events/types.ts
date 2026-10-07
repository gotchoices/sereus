/**
 * Event types broadcast over the SPA's SSE channel.
 *
 * Publishers (orchestrator hook, route adapters, NAT change listener, the
 * hosted-node service's change listener, update observer) call
 * EventBus.publish; the `/api/events` route fan-outs to connected clients.
 */

import type { ContainerStatus } from '@serfab/cadre-provider';

import type { HostedNodeChangeKind } from '../../hosted/types.js';
import type { DirectReachability } from '../../nat/index.js';

export type LocalUiEvent =
  | { type: 'node-state-changed'; nodeId: string; status: ContainerStatus }
  | { type: 'hosted-nodes-changed'; kind: HostedNodeChangeKind; nodeId: string }
  | { type: 'connectivity-changed'; directReachability: DirectReachability }
  | { type: 'update-available'; version: string; releaseNotesUrl?: string };

export type LocalUiEventType = LocalUiEvent['type'];
