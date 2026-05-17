/**
 * Event types broadcast over the SPA's SSE channel.
 *
 * Publishers (orchestrator hook, route adapters, update observer) call
 * EventBus.publish; the `/api/events` route fan-outs to connected clients.
 */

import type { ContainerStatus } from '@serfab/cadre-provider';

import type { DirectReachability, PortForwardMode } from '../../nat/index.js';

export type LocalUiEvent =
  | { type: 'node-state-changed'; nodeId: string; status: ContainerStatus }
  | { type: 'trust-circle-changed'; kind: 'invited' | 'redeemed' | 'revoked' }
  | {
      type: 'connectivity-changed';
      portMode: PortForwardMode;
      directReachability: DirectReachability;
    }
  | { type: 'update-available'; version: string; releaseNotesUrl?: string };

export type LocalUiEventType = LocalUiEvent['type'];
