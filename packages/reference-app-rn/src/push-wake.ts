/**
 * push-wake.ts — platform-agnostic core of the mobile push-wake **receive** path.
 *
 * The control-network transport (`pushWake`/`StrandWakeService`) cannot reach a
 * suspended app, so a wake for a hibernating phone must arrive over the platform
 * push channel (FCM/APNs). When such a data-message is delivered, the OS runs a
 * short background task that brings the node online just long enough to service
 * the wake (`CadreNode.serviceWake`) and then lets it re-hibernate.
 *
 * This module owns the parts that run in plain node and are unit-testable: the
 * shared payload contract, its parser, the background-task **handler** (parse →
 * ensure node → bounded control wait → `serviceWake`), and the device-token
 * registrar. The native expo-notifications / expo-task-manager wiring (the only
 * code that imports `react-native`) lives in `push-wake-native.ts`, mirroring how
 * `app-state.ts` isolates the native `AppState` from `background-runner.ts`.
 *
 * Receive flow:
 *
 *   FCM/APNs data message ──► OS wakes app (background task / content-available)
 *          │
 *          ▼   parse {type:'strand-wake', strandId, reason}
 *   createPushWakeHandler().handle(raw)
 *          │
 *          ├─ foreground ─► wakeStrand + recordStrandActivity (no re-hibernate;
 *          │                the user is viewing — BackgroundRunner owns lifecycle)
 *          │
 *          └─ background ─► ensureNode (cold start) ─► await control (bounded)
 *                           ─► serviceWake(strandId, {windowMs}) ─► re-hibernate
 */

import { STRAND_WAKE_TYPE } from '@serfab/cadre-core';
import type { CadreNode, PushPlatform, ServiceWakeResult, StrandWakePayload } from '@serfab/cadre-core';

// ── Shared payload contract (canonical home: @serfab/cadre-core) ─────────────
//
// `STRAND_WAKE_TYPE` + `StrandWakePayload` are the data-only message both this
// receiver and the server-side sender (`PushNotifier`) agree on. They now live in
// cadre-core (`strand-wake-payload.ts`) so the sender does not depend on this RN
// app; re-exported here for this module's existing callers/tests. The defensive
// `parseStrandWakePayload` parser below stays receive-side — it guards untrusted
// push input rather than re-declaring the contract.
export { STRAND_WAKE_TYPE };
export type { StrandWakePayload };

/**
 * Parse an opaque push `data` record into a {@link StrandWakePayload}, or `null`
 * if it is not a well-formed strand-wake message. Never throws — a malformed or
 * unrelated push must be ignored, not crash the background task.
 *
 * Push channels coerce data values to strings (FCM) or deliver loosely-typed
 * JSON (APNs `userInfo`), so we validate the shape defensively rather than trust
 * the wire types.
 */
export function parseStrandWakePayload(raw: unknown): StrandWakePayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== STRAND_WAKE_TYPE) return null;
  const strandId = obj.strandId;
  if (typeof strandId !== 'string' || strandId.length === 0) return null;
  const reason = typeof obj.reason === 'string' ? obj.reason : 'unknown';
  return { type: STRAND_WAKE_TYPE, strandId, reason };
}

// ── Device-token platform mapping ───────────────────────────────────────────

/**
 * Pull the application data record out of an expo notification-task payload.
 *
 * expo-notifications normalizes FCM/APNs delivery into a `data` object: Android
 * data messages arrive as `data.dataString` (a JSON string), while iOS / already
 * parsed payloads expose the keys directly on `data`. We handle both and return
 * the resulting record (or `null`) for {@link parseStrandWakePayload} to validate.
 * Kept pure (operates on `unknown`) so the JSON-string path is unit-testable.
 */
export function extractPushData(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const dataString = (data as { dataString?: unknown }).dataString;
  if (typeof dataString === 'string') {
    try {
      return JSON.parse(dataString);
    } catch (err) {
      console.warn('[push-wake] failed to parse data.dataString as JSON:', err);
      return null;
    }
  }
  return data;
}

/**
 * Map an expo `DevicePushToken.type` (`'ios'` / `'android'`) to the cadre-core
 * {@link PushPlatform} stored in `DeviceToken`. Returns `null` for anything else
 * (e.g. `'web'`), which the caller treats as "not registerable".
 */
export function pushPlatformFromTokenType(type: string): PushPlatform | null {
  switch (type) {
    case 'ios':
      return 'apns';
    case 'android':
      return 'fcm';
    default:
      return null;
  }
}

// ── Background-task handler ──────────────────────────────────────────────────

export interface PushWakeHandlerDeps {
  /** Live node singleton (e.g. `cadre-phone.getPhoneNode`), or null if stopped. */
  getNode: () => CadreNode | null;
  /**
   * Cold-start hook: bring the node up when a background wake finds it
   * stopped/killed. Optional — without it (or if start options aren't persisted)
   * a wake into a fully-killed process degrades to a `no-node` no-op rather than
   * crashing. Must be idempotent.
   */
  ensureNode?: () => Promise<void>;
  /**
   * True when the app is foregrounded. A push that arrives foreground routes to a
   * plain `wakeStrand`/`recordStrandActivity` (the user is viewing the strand);
   * the re-hibernating `serviceWake` path is background-only.
   */
  isForeground: () => boolean;
  /**
   * Live-window for the background `serviceWake`. Kept conservative (smaller than
   * the interactive check-in window) so the cycle returns within the OS
   * background budget. Defaults to {@link DEFAULT_BACKGROUND_WINDOW_MS}.
   */
  windowMs?: number;
  /**
   * Max wait for `control:connected` before driving `serviceWake` on a cold
   * start. Defaults to {@link DEFAULT_CONTROL_SETTLE_MS}. `serviceWake` itself
   * is control-absent-safe, so this is best-effort: we give the control network
   * a bounded chance to come up rather than waking into a guaranteed miss.
   */
  controlSettleTimeoutMs?: number;
}

/** Conservative background live-window (3s) — fits inside the OS wake budget. */
export const DEFAULT_BACKGROUND_WINDOW_MS = 3_000;
/** Bounded control-network settle on a cold-start wake (10s). */
export const DEFAULT_CONTROL_SETTLE_MS = 10_000;

/** Branchable result of handling one push (never thrown — a task must return). */
export type PushWakeOutcome =
  | { handled: false; reason: 'malformed' | 'no-node' }
  | { handled: true; mode: 'foreground'; strandId: string }
  | { handled: true; mode: 'service-wake'; strandId: string; result: ServiceWakeResult };

export interface PushWakeHandler {
  /**
   * Handle one delivered push `data` record. Resolves when the wake cycle has
   * completed (and the strand re-hibernated, if backgrounded) so the native task
   * can return and let the OS re-suspend the app. Never rejects.
   */
  handle(raw: unknown): Promise<PushWakeOutcome>;
}

/**
 * Build a {@link PushWakeHandler}. Pure: depends only on injectable accessors, so
 * the same handler is exercised by unit tests with a mock node and by the native
 * task in `push-wake-native.ts` with the real singleton.
 */
export function createPushWakeHandler(deps: PushWakeHandlerDeps): PushWakeHandler {
  const windowMs = deps.windowMs ?? DEFAULT_BACKGROUND_WINDOW_MS;
  const settleMs = deps.controlSettleTimeoutMs ?? DEFAULT_CONTROL_SETTLE_MS;

  async function handle(raw: unknown): Promise<PushWakeOutcome> {
    const payload = parseStrandWakePayload(raw);
    if (!payload) {
      console.warn('[push-wake] ignoring malformed push payload');
      return { handled: false, reason: 'malformed' };
    }
    const { strandId } = payload;

    // Foreground: the user is in the app. Route to a plain wake + activity reset
    // so the strand the user is (or is about to be) viewing comes up and stays
    // up — never the re-hibernating background path. The AppState BackgroundRunner
    // owns lifecycle while foregrounded; we only nudge the strand awake.
    if (deps.isForeground()) {
      const node = deps.getNode();
      if (!node) return { handled: false, reason: 'no-node' };
      try {
        await node.wakeStrand(strandId);
        node.recordStrandActivity(strandId);
      } catch (err) {
        console.warn('[push-wake] foreground wake failed for strand %s:', strandId, err);
      }
      return { handled: true, mode: 'foreground', strandId };
    }

    // Background: ensure a node exists (cold start if the OS killed it), give the
    // control network a bounded chance to connect, then run one serviceWake cycle
    // and let the node re-hibernate. serviceWake returns a branchable result for
    // every failure mode (unknown strand → serviced:false), so we never throw out.
    const node = await ensureLiveNode();
    if (!node) {
      console.warn('[push-wake] no node available to service wake for strand %s', strandId);
      return { handled: false, reason: 'no-node' };
    }

    await awaitControlConnected(node, settleMs);
    const result = await node.serviceWake(strandId, { windowMs });
    if (!result.serviced) {
      // Unknown / non-participated strand, or node not running — informational.
      console.warn('[push-wake] serviceWake not serviced for strand %s', strandId);
    }
    return { handled: true, mode: 'service-wake', strandId, result };
  }

  // Return a running node, cold-starting via ensureNode if needed. Best-effort:
  // any start failure degrades to null (handled as a no-op), never a throw.
  async function ensureLiveNode(): Promise<CadreNode | null> {
    let node = deps.getNode();
    if ((!node || !node.running) && deps.ensureNode) {
      try {
        await deps.ensureNode();
      } catch (err) {
        console.warn('[push-wake] ensureNode (cold start) failed:', err);
      }
      node = deps.getNode();
    }
    return node && node.running ? node : null;
  }

  return { handle };
}

/**
 * Resolve once the node's control network connects, or after `timeoutMs` —
 * whichever first. Always cleans up its listener + timer. Resolves `true` if
 * connected, `false` on timeout. Standalone (not the BackgroundRunner's copy) so
 * the push path has no dependency on a runner being mounted.
 */
export function awaitControlConnected(node: CadreNode, timeoutMs: number): Promise<boolean> {
  if (node.controlConnected) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      node.off('control:connected', onConnected);
      clearTimeout(timer);
      resolve(connected);
    };
    const onConnected = () => finish(true);
    node.on('control:connected', onConnected);
    const timer = setTimeout(() => finish(false), timeoutMs);
    // Guard a connect that raced between the initial check and subscribe.
    if (node.controlConnected) finish(true);
  });
}

// ── Device-token registrar ──────────────────────────────────────────────────

export interface DeviceTokenRegistrarDeps {
  /** Live node singleton, or null if stopped. */
  getNode: () => CadreNode | null;
}

export interface DeviceTokenRegistrar {
  /**
   * Publish the raw FCM/APNs token into this node's `DeviceToken` row. Returns
   * `true` on success, `false` if it was deferred (node not started, or the peer
   * isn't yet a member / has no authority-seeded row) — the native layer retries
   * on the next start / token event rather than treating a defer as fatal.
   */
  register(platform: PushPlatform, token: string): Promise<boolean>;
  /** Delete this node's `DeviceToken` row (logout). Swallows + logs failures. */
  clear(): Promise<void>;
}

/**
 * Build a {@link DeviceTokenRegistrar} over the node singleton. Wraps
 * `CadreNode.registerDeviceToken` / `clearDeviceToken` with the deferred-retry
 * semantics the push path needs: registration legitimately fails before the node
 * is started or before an authority has seeded the first `DeviceToken` row, and
 * that must not crash token acquisition.
 */
export function createDeviceTokenRegistrar(deps: DeviceTokenRegistrarDeps): DeviceTokenRegistrar {
  async function register(platform: PushPlatform, token: string): Promise<boolean> {
    const node = deps.getNode();
    if (!node || !node.running) {
      console.warn('[push-wake] device-token registration deferred: node not running');
      return false;
    }
    try {
      await node.registerDeviceToken(platform, token);
      return true;
    } catch (err) {
      // Expected before membership / first authority-seeded row exists. Retried
      // on the next start or token-rotation event.
      console.warn('[push-wake] device-token registration deferred:', err);
      return false;
    }
  }

  async function clear(): Promise<void> {
    const node = deps.getNode();
    if (!node || !node.running) return;
    try {
      await node.clearDeviceToken();
    } catch (err) {
      console.warn('[push-wake] device-token clear failed:', err);
    }
  }

  return { register, clear };
}
