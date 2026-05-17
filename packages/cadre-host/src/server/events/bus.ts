/**
 * In-memory event bus for the local UI.
 *
 * Tiny synchronous fan-out: publishers (route adapters, orchestrator hook,
 * update observer) call `publish`; SSE connections subscribe and receive every
 * event until they unsubscribe. Listener errors are caught so one broken
 * client cannot break others.
 */

import debug from 'debug';

import type { LocalUiEvent } from './types.js';

const log = debug('cadre:host:event-bus');

export type LocalUiEventListener = (event: LocalUiEvent) => void;

export class EventBus {
  private readonly listeners = new Set<LocalUiEventListener>();

  publish(event: LocalUiEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log('listener threw for event %s: %s', event.type, (err as Error).message);
      }
    }
  }

  subscribe(listener: LocalUiEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test helper. */
  listenerCount(): number {
    return this.listeners.size;
  }
}
