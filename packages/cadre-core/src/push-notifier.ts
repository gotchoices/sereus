/**
 * push-notifier.ts — the platform-push **delivery** contract for strand-wake.
 *
 * This module is the cross-platform-safe *interface* half: the message shape
 * ({@link PushMessage}), the outcome value ({@link PushSendResult}), and the
 * {@link PushNotifier} port a `CadreNode` sends over. It carries ZERO runtime
 * dependencies and imports no implementation — so the RN/browser entry graph can
 * reference the type without ever resolving `node:crypto` / `node:http2`.
 *
 * The concrete FCM/APNs implementations (`push-notifier-fcm.ts` /
 * `push-notifier-apns.ts`) and the `createPushNotifier` router that builds them
 * live behind the Node-only subpath `@serfab/cadre-core/push-node`
 * (`push-node.ts`). A Node host constructs a notifier from that subpath and
 * injects the instance into `CadreNodeConfig.push.notifier`; the cross-platform
 * core never constructs one, so the Node-only builtins stay out of its graph.
 *
 * Keep this file zero-import (beyond erased type-only imports): the whole point
 * of the seam is that referencing the interface can never drag an implementation
 * module into a bundler's graph.
 */

import type { PushPlatform } from './types.js';
import type { StrandWakePayload } from './strand-wake-payload.js';

/** One strand-wake data message addressed to one device. */
export interface PushMessage {
  /** The resolved `DeviceToken.token` for the target peer. */
  token: string;
  /** Which channel — selects FCM vs APNs. */
  platform: PushPlatform;
  /** The strand-wake payload `{ type:'strand-wake', strandId, reason }`. */
  payload: StrandWakePayload;
}

/**
 * Outcome of a single {@link PushNotifier.send}. A delivery failure is a value,
 * never a thrown error. `unregistered: true` means the platform reported the
 * token is permanently invalid (FCM 404 `UNREGISTERED` / 400 naming the token;
 * APNs 410 `Unregistered` / 400 `BadDeviceToken`) — the caller should expire the
 * stale `DeviceToken`. Any other failure is `unregistered: false` and is treated
 * as best-effort/transient (no retry storm).
 */
export type PushSendResult =
  | { ok: true }
  | { ok: false; unregistered: boolean; error: string };

export interface PushNotifier {
  /** Send one strand-wake data message to one device. Never throws. */
  send(msg: PushMessage): Promise<PushSendResult>;
  /** Release transport resources (e.g. the APNs HTTP/2 session). */
  close(): Promise<void>;
}
