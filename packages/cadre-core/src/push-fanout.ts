/**
 * push-fanout.ts — the server-side push-wake **trigger policy + fan-out**.
 *
 * The delivery half (`push-notifier.ts`) knows *how* to send one strand-wake to
 * one device; this module owns *who* to wake and *when*. On strand activity it
 * enumerates the cadre's hibernating mobile members, prefers a direct
 * control-network `pushWake`, falls back to FCM/APNs platform push only when the
 * direct dial cannot reach the (suspended) peer, and dedups/cooldowns per
 * `(peer, strand)` so a chatty strand cannot spam wakes.
 *
 * It owns no transport and no DB access: every node primitive (member
 * enumeration, participation check, direct dial, token resolve, stale-token
 * expiry) and the `PushNotifier` are injected, so the whole policy is unit-tested
 * with fakes and never throws to its trigger (a dropped wake is recoverable — the
 * hibernation check-in wake is the backstop).
 *
 * Cross-platform-clean by construction: it imports only the `PushNotifier`
 * *type* (erased at emit) and the dependency-free `STRAND_WAKE_TYPE` value, so it
 * carries no `node:http2`/`node:crypto` edge. The Node-only notifier is built by
 * `CadreNode` (via a guarded dynamic import) and injected here.
 */

import debug from 'debug';
import type { StrandInstance, WakeAck, DeviceTokenRecord } from './types.js';
import type { PushNotifier } from './push-notifier.js';
import { STRAND_WAKE_TYPE } from './strand-wake-payload.js';

const log = debug('sereus:cadre:push-fanout');

/** Default per-`(peer, strand)` minimum gap between wakes. */
export const DEFAULT_PUSH_COOLDOWN_MS = 5 * 60_000;
/** Default per-strand burst-coalescing window. */
export const DEFAULT_PUSH_DEBOUNCE_MS = 10_000;

/** A cadre member as returned by {@link CadreNode.listMembers}. */
export interface FanoutMember {
  peerId: string;
  multiaddr: string | null;
}

/**
 * Everything {@link PushFanoutService} needs, injected so the policy is pure and
 * testable. The node-bound implementations live on {@link CadreNode}; the
 * `notifier` is a {@link PushNotifier} built from `config.push`.
 */
export interface PushFanoutOptions {
  /** Enumerate the cadre's `CadrePeer` membership (every party node). */
  listMembers: () => Promise<FanoutMember[]>;
  /**
   * The local strand instance for `strandId`, or `undefined` when this node does
   * not participate — the participation gate (never push for a strand we cannot
   * vouch for).
   */
  getStrand: (strandId: string) => StrandInstance | undefined;
  /** This node's own peerId, excluded from every fan-out (never wake self). */
  selfPeerId: () => string | undefined;
  /**
   * Direct control-network push-wake. Resolves to a {@link WakeAck} when the dial
   * REACHED the peer (whatever the peer then decided); REJECTS only on a
   * dial/transport failure (no dialable address / timeout ⇒ the phone is
   * suspended), which is what triggers the platform-push fallback.
   */
  pushWake: (peerId: string, strandId: string, reason?: string) => Promise<WakeAck>;
  /** Resolve a peer's FCM/APNs token; `null` ⇒ not a registered mobile peer. */
  resolveDeviceToken: (peerId: string) => Promise<DeviceTokenRecord | null>;
  /**
   * Expire a peer's stale `DeviceToken` after a platform reports it unregistered.
   * Authority nodes delete the row; non-authority nodes only log (the in-memory
   * dead-token set below is what actually stops re-pushing this process).
   */
  expireDeviceToken: (peerId: string) => Promise<void>;
  /** Platform-push delivery seam (FCM/APNs router). */
  notifier: PushNotifier;
  /** Monotonic clock (epoch ms); injectable for deterministic cooldown/debounce tests. */
  now?: () => number;
  /** Per-`(peer, strand)` minimum gap. Default {@link DEFAULT_PUSH_COOLDOWN_MS}. */
  cooldownMs?: number;
  /** Per-strand burst coalescing. Default {@link DEFAULT_PUSH_DEBOUNCE_MS}. */
  debounceMs?: number;
}

/**
 * Server-side push-wake fan-out (see module header). One per participating
 * {@link CadreNode}, constructed only when push credentials are configured.
 */
export class PushFanoutService {
  private readonly deps: PushFanoutOptions;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly debounceMs: number;

  /** Per-strand leading-edge debounce: last fan-out start time (epoch ms). */
  private readonly lastFanoutAt = new Map<string, number>();
  /** Per-strand in-flight pass, so two near-simultaneous triggers coalesce into one. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Per-`(peer, strand)` last-wake time (epoch ms); the anti-spam cooldown. */
  private readonly cooldownAt = new Map<string, number>();
  /**
   * Peers whose `DeviceToken` a platform reported unregistered. Consulted before
   * every resolve→send so we stop pushing to a dead token. In-memory and
   * acceptably lossy: a restart re-learns staleness on the next failed send.
   */
  private readonly deadTokens = new Set<string>();

  constructor(options: PushFanoutOptions) {
    this.deps = options;
    this.now = options.now ?? (() => Date.now());
    this.cooldownMs = options.cooldownMs ?? DEFAULT_PUSH_COOLDOWN_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
  }

  /**
   * Fan a wake out to the cadre's hibernating mobile members for a strand that
   * just saw activity. Best-effort: never throws to the trigger (the check-in
   * wake is the backstop). No-ops when this node does not participate in the
   * strand, when the strand was already fanned out within `debounceMs`, or — by
   * joining — when a pass for the strand is already in flight.
   *
   * @param strandId - the strand whose activity should wake hibernating peers.
   * @param reason - free-form cause hint carried in the wake (default `activity`).
   */
  async notify(strandId: string, reason = 'activity'): Promise<void> {
    try {
      // 1. Participation gate — never push for a strand we do not participate in.
      if (!this.deps.getStrand(strandId)) {
        log('notify: not participating in strand %s; no-op', strandId);
        return;
      }

      // Concurrent trigger coalescing: a second near-simultaneous notify joins the
      // in-flight pass rather than enumerating + sending again (mirrors
      // CadreNode.serviceWakePromises).
      const inflight = this.inFlight.get(strandId);
      if (inflight) {
        log('notify: joining in-flight fan-out for strand %s', strandId);
        return inflight;
      }

      // 2. Per-strand debounce — coalesce bursts after a pass has completed.
      const now = this.now();
      const last = this.lastFanoutAt.get(strandId);
      if (last !== undefined && now - last < this.debounceMs) {
        log('notify: debounced fan-out for strand %s', strandId);
        return;
      }

      this.lastFanoutAt.set(strandId, now);
      const op = this.runFanout(strandId, reason);
      this.inFlight.set(strandId, op);
      try {
        await op;
      } finally {
        this.inFlight.delete(strandId);
      }
    } catch (error) {
      // The trigger must never see a throw — failures are logged best-effort.
      log('notify: fan-out for strand %s failed (best-effort): %o', strandId, error);
    }
  }

  /** Release the notifier's transport resources (e.g. the APNs HTTP/2 session). */
  async close(): Promise<void> {
    await this.deps.notifier.close();
  }

  /**
   * One fan-out pass: enumerate members, drop self and any peer still cooling
   * down for this strand, and wake the survivors concurrently. Each
   * {@link wakePeer} is self-contained (never rejects), so one peer's failure
   * never aborts the others.
   */
  private async runFanout(strandId: string, reason: string): Promise<void> {
    const members = await this.deps.listMembers();
    const self = this.deps.selfPeerId();
    const targets = members.filter(
      (m) => m.peerId !== self && !this.isCoolingDown(m.peerId, strandId)
    );
    log('fanout: strand %s — %d candidate(s) after self/cooldown filter', strandId, targets.length);
    await Promise.all(targets.map((m) => this.wakePeer(m.peerId, strandId, reason)));
  }

  /**
   * Wake one candidate: try the direct control-network dial first, falling back
   * to a platform push only when the dial cannot reach the (suspended) peer.
   *
   * A resolved {@link WakeAck} means the control path REACHED the peer — even an
   * ack with `accepted:false` (the receiver declined, e.g. non-member/unknown
   * strand) counts as reached, so we do NOT also send a platform push (that would
   * double-wake). Only a dial/transport REJECTION means the phone is suspended
   * and unreachable over the control network, which is the one case that falls
   * through to FCM/APNs.
   */
  private async wakePeer(peerId: string, strandId: string, reason: string): Promise<void> {
    // A wake of either kind is now being attempted → arm the cooldown up front.
    this.markCooldown(peerId, strandId);

    try {
      const ack = await this.deps.pushWake(peerId, strandId, reason);
      log(
        'wakePeer: direct pushWake reached %s for strand %s (accepted=%s); no platform fallback',
        peerId, strandId, ack.accepted
      );
      return;
    } catch (error) {
      // Dial/transport failure ⇒ suspended phone ⇒ fall through to platform push.
      log('wakePeer: direct pushWake could not reach %s; trying platform push: %o', peerId, error);
    }

    try {
      await this.platformPush(peerId, strandId, reason);
    } catch (error) {
      log('wakePeer: platform push for %s failed (best-effort): %o', peerId, error);
    }
  }

  /**
   * Deliver a platform push (FCM/APNs) to a suspended peer. Skips a peer with a
   * known-dead token, no-ops for a non-mobile peer (`resolveDeviceToken` → null),
   * and — on an `unregistered` send — marks the token dead and expires the row.
   */
  private async platformPush(peerId: string, strandId: string, reason: string): Promise<void> {
    if (this.deadTokens.has(peerId)) {
      log('platformPush: %s has a known-stale token; skipping resolve→send', peerId);
      return;
    }

    const record = await this.deps.resolveDeviceToken(peerId);
    if (!record) {
      log('platformPush: %s is not a registered mobile peer; no platform push', peerId);
      return;
    }

    const result = await this.deps.notifier.send({
      token: record.token,
      platform: record.platform,
      payload: { type: STRAND_WAKE_TYPE, strandId, reason },
    });

    if (!result.ok && result.unregistered) {
      // Permanently-invalid token: stop pushing to it this process (the set), and
      // expire the row (authority delete; non-authority logs re-registration).
      this.deadTokens.add(peerId);
      await this.deps.expireDeviceToken(peerId);
      log('platformPush: expired stale token for %s (platform=%s)', peerId, record.platform);
    }
  }

  /** Whether `peerId` was woken for `strandId` within `cooldownMs`. */
  private isCoolingDown(peerId: string, strandId: string): boolean {
    const last = this.cooldownAt.get(cooldownKey(peerId, strandId));
    return last !== undefined && this.now() - last < this.cooldownMs;
  }

  /** Arm the per-`(peer, strand)` cooldown at the current clock time. */
  private markCooldown(peerId: string, strandId: string): void {
    this.cooldownAt.set(cooldownKey(peerId, strandId), this.now());
  }
}

/** Composite key for the per-`(peer, strand)` cooldown map. */
function cooldownKey(peerId: string, strandId: string): string {
  return `${peerId} ${strandId}`;
}
