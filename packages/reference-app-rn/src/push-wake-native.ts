/**
 * push-wake-native.ts — react-native / expo-notifications wiring for the mobile
 * push-wake receive path.
 *
 * This is the single module that imports the native push stack (`expo-notifications`,
 * `expo-task-manager`, `react-native`'s `AppState`). It adapts them onto the pure,
 * unit-tested core in `push-wake.ts` — the same split `app-state.ts` makes for the
 * `BackgroundRunner`, so the core (parser, handler, registrar) never pulls a
 * native import into the node test environment.
 *
 * Two entry points, both meant to be called once at app start:
 *  - {@link registerStrandWakeTask} — define + register the background notification
 *    task. Per expo's contract this MUST run in the module scope of a file required
 *    early (our `index.js`), because `expo-task-manager` reloads the JS bundle in
 *    the background and re-runs that module before invoking the task.
 *  - {@link acquireAndRegisterDeviceToken} — request permission, fetch the raw
 *    FCM/APNs token, publish it into `DeviceToken`, and subscribe to rotation.
 *    Call this after the node is started + a member (e.g. from `use-cadre`).
 */

import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import type { CadreNode } from '@serfab/cadre-core';
import { getPhoneNode, loadSavedStartOptions, startPhoneNode } from './cadre-phone';
import {
  createPushWakeHandler,
  createDeviceTokenRegistrar,
  extractPushData,
  pushPlatformFromTokenType,
  type DeviceTokenRegistrar,
} from './push-wake';

/** Task name shared between {@link TaskManager.defineTask} and `registerTaskAsync`. */
export const STRAND_WAKE_TASK = 'sereus-strand-wake';

/** True while the app is foregrounded (drives foreground-vs-background routing). */
function isForeground(): boolean {
  return AppState.currentState === 'active';
}

/**
 * Cold start for a wake into a process the OS killed: bring the node up with the
 * options it last started with — but only when the last session ended connected. A
 * user who tapped Disconnect has logged out (the device token was cleared then too),
 * so a wake stays a `no-node` no-op rather than logging them back in. A throw is
 * caught and logged by the handler.
 */
async function startFromSavedOptions(): Promise<void> {
  const saved = await loadSavedStartOptions();
  if (!saved?.autoStart) return;
  await startPhoneNode(saved.options);
}

// The handler is constructed once, in module scope, because `expo-task-manager`
// re-runs this module in a fresh JS runtime before invoking the task — the case
// `ensureNode` exists for. A backgrounded-but-alive process with hibernated strands
// is served by the live singleton and never reaches it.
const handler = createPushWakeHandler({
  getNode: () => getPhoneNode(),
  ensureNode: startFromSavedOptions,
  isForeground,
});

/**
 * Define and register the background notification task. Idempotent at the expo
 * layer (`registerTaskAsync` tolerates re-registration); we still guard the
 * define so a bundle reload doesn't double-define.
 */
export function registerStrandWakeTask(): void {
  if (!TaskManager.isTaskDefined(STRAND_WAKE_TASK)) {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(
      STRAND_WAKE_TASK,
      async ({ data: payload, error }) => {
        if (error) {
          console.warn('[push-wake] background task error:', error);
          return;
        }
        // `payload` is the NotificationTaskPayload; its own `.data` field carries
        // the application record (Android delivers it as a JSON `dataString`).
        // extractPushData reads `payload.data` and normalizes both shapes.
        const record = extractPushData(payload);
        await handler.handle(record);
      },
    );
  }
  // Fire-and-forget: registration is async but the module-scope caller can't await.
  void Notifications.registerTaskAsync(STRAND_WAKE_TASK).catch((err) => {
    console.warn('[push-wake] registerTaskAsync failed:', err);
  });
}

// ── Device-token acquisition ────────────────────────────────────────────────

let registrar: DeviceTokenRegistrar | null = null;
let rotationSub: Notifications.EventSubscription | null = null;

function getRegistrar(): DeviceTokenRegistrar {
  if (!registrar) {
    registrar = createDeviceTokenRegistrar({ getNode: () => getPhoneNode() });
  }
  return registrar;
}

/**
 * Request notification permission, fetch the raw device push token, publish it
 * into `DeviceToken`, and subscribe to token rotation. Best-effort: a declined
 * permission or a deferred registration (node not yet a member) is logged, not
 * thrown — the app degrades to check-in-wake only. Re-callable on each node start.
 *
 * @returns the {@link CadreNode.registerDeviceToken} outcome: `true` if the token
 *   was published, `false` if permission was denied or registration deferred.
 */
export async function acquireAndRegisterDeviceToken(): Promise<boolean> {
  const granted = await ensureNotificationPermission();
  if (!granted) {
    console.warn('[push-wake] notification permission denied; push-wake disabled');
    return false;
  }

  const published = await publishCurrentDeviceToken();
  subscribeTokenRotation();
  return published;
}

async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

async function publishCurrentDeviceToken(): Promise<boolean> {
  let token: Notifications.DevicePushToken;
  try {
    token = await Notifications.getDevicePushTokenAsync();
  } catch (err) {
    console.warn('[push-wake] getDevicePushTokenAsync failed:', err);
    return false;
  }
  return registerDevicePushToken(token);
}

async function registerDevicePushToken(token: Notifications.DevicePushToken): Promise<boolean> {
  const platform = pushPlatformFromTokenType(token.type);
  if (!platform || typeof token.data !== 'string') {
    console.warn('[push-wake] unsupported device push token type:', token.type);
    return false;
  }
  return getRegistrar().register(platform, token.data);
}

// Re-register on rotation: the push service can roll the token while running, and
// the old one stops delivering. One subscription for the app's lifetime.
function subscribeTokenRotation(): void {
  if (rotationSub) return;
  rotationSub = Notifications.addPushTokenListener((token) => {
    void registerDevicePushToken(token);
  });
}

/**
 * Clear this node's `DeviceToken` (logout) and drop the rotation subscription.
 */
export async function clearDeviceTokenRegistration(): Promise<void> {
  if (rotationSub) {
    rotationSub.remove();
    rotationSub = null;
  }
  await getRegistrar().clear();
}

// Re-export the node type so callers needn't reach into cadre-core for it.
export type { CadreNode };
