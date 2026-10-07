/**
 * Trust-anchor policy for control-network seeds.
 *
 * A seed carries an ed25519 signature over its body and the `signerKey` that
 * produced it. Verifying that signature only proves the seed is internally
 * consistent — it does NOT prove the signer is an owner, because both the
 * signer key and the seed's own `isOwner` peer flags are attacker-supplied.
 * The trust decision must therefore rest on an anchor that does not come from
 * the seed body:
 *
 *  1. Anchored — keys in the receiver's NODE-LOCAL `TrustedOwnerStore`: the
 *     non-replicated, per-party record of owner keys established out of band
 *     (founding the party, the cadre invitation that enrolled this node, an
 *     operator pin, a claim). Deliberately NOT the replicated `CadreControl.OwnerKey`
 *     table — any connecting node can genesis-insert its own key there and let
 *     it replicate, so that table can be made to say "yes" by a stranger.
 *  2. Pinned out-of-band — keys handed to the node for this seed only (carried
 *     by a cadre invitation's `ownerKeys`, or pinned by an operator) without having
 *     been anchored yet.
 *  3. Claim secret — a brand-new node that belongs to nobody accepts its first seed
 *     from whoever proves they hold its one-time claim secret (`claim-proof.ts`), and
 *     anchors that signer itself under source `claim`.
 *  4. TOFU (opt-in) — an explicit confirmation callback invoked on first sight
 *     of an unknown signer key. Interactive hosts only; off by default.
 *
 * Secure default (`anchoredTrustPolicy`): a node with an empty anchor and no
 * pinned keys rejects the seed — a seed can no longer vouch for its own signer,
 * and neither can a polluted replicated table.
 *
 * A key accepted via anchor 2 or 4 is reported back through
 * {@link SeedTrustDecision.anchorAs} so `applySeed` can persist it into the
 * node-local anchor, and later seeds from the same owner are accepted without
 * re-supplying the invite/confirmation. Anchor 3 persists the key itself before it
 * answers, because for a claim the persist must succeed for the acceptance to mean
 * anything (see {@link claimSecretTrustPolicy}).
 */
import debug from 'debug';
import type { SeedRefusalCode } from './types.js';
import type { TrustSource, TrustedOwnerStore } from './trusted-owner-store.js';
import { verifyClaimProof } from './claim-proof.js';

const log = debug('sereus:cadre:seed-trust-policy');

export interface SeedTrustContext {
  /** Party the seed claims to belong to. */
  partyId: string;
  /** ed25519 base64url signer key — already signature-verified by `applySeed`. */
  signerKey: string;
  /**
   * The receiver's anchored owner keys, sourced from its node-local
   * `TrustedOwnerStore` — NOT from the seed, and NOT from the replicated
   * `OwnerKey` table. Empty for a node whose anchor was never seeded.
   */
  knownOwnerKeys: ReadonlySet<string>;
  /**
   * The receiver's OWN libp2p peer id. A claim proof is bound to the node it was
   * minted for, and this is the receiver's side of that binding; it must never be
   * taken from the message.
   */
  localPeerId: string;
  /**
   * The seed's signature digest (`seedDigest` in `seed-bootstrap.ts`), computed once
   * per seed and shared with the signature check. The third field a claim proof binds.
   */
  seedDigest: string;
  /** The claim proof the message carried beside the seed, if any (`SeedMessage.claimProof`). */
  claimProof?: string;
  /** The delivering peer, when the seed arrived over the wire; absent for a local `applySeed`. */
  remotePeerId?: string;
}

export interface SeedTrustDecision {
  /** Whether the signer key is trusted. */
  trusted: boolean;
  /** Human-readable reason, surfaced as the seed-apply error when not trusted. */
  reason?: string;
  /** Machine-readable refusal cause, for callers that must branch on it (the claiming phone). */
  code?: SeedRefusalCode;
  /**
   * Set when the key was trusted via an anchor OUTSIDE the node-local store (a
   * pinned key, a TOFU confirmation): the provenance to record it under, so
   * `applySeed` persists it and the next seed from that owner is anchored
   * without re-supplying the pin. Omitted when the key was already anchored
   * (nothing to persist) or not trusted at all.
   *
   * `claim` is excluded on purpose: `applySeed` logs and continues when this persist
   * fails, which is right for a pin that is re-supplied at the next start and wrong for
   * a claim, so the claim policy anchors its signer itself and never asks for it here.
   */
  anchorAs?: Exclude<TrustSource, 'genesis' | 'claim'>;
}

/**
 * Decides whether a signature-verified seed's signer key should be trusted.
 * May be synchronous (anchored/pinned) or asynchronous (TOFU confirmation, claim).
 */
export interface SeedTrustPolicy {
  evaluate(ctx: SeedTrustContext): Promise<SeedTrustDecision> | SeedTrustDecision;
}

/**
 * Default policy: trust only keys already in the receiver's node-local
 * trusted-owner anchor. A node whose anchor was never seeded (no genesis, no
 * invite pin, no operator pin) rejects every seed.
 */
export function anchoredTrustPolicy(): SeedTrustPolicy {
  return {
    evaluate({ signerKey, knownOwnerKeys }) {
      if (knownOwnerKeys.has(signerKey)) {
        return { trusted: true };
      }
      return {
        trusted: false,
        reason: 'Signer key is not an anchored owner (anchored trust policy)',
      };
    },
  };
}

/**
 * Cold-start policy: trust anchored keys plus a set pinned out-of-band
 * (typically a cadre invitation's `ownerKeys` or operator config). Lets an unenrolled
 * invitee accept its first seed without the seed vouching for itself.
 *
 * @param anchorAs - provenance under which a pin-only acceptance is persisted
 *   into the node-local anchor ('invite' by default — the invite-redemption
 *   case; pass 'operator' for an operator-supplied pin).
 */
export function pinnedKeyTrustPolicy(
  pinned: Iterable<string>,
  anchorAs: Exclude<TrustSource, 'genesis' | 'claim'> = 'invite'
): SeedTrustPolicy {
  const pinnedSet = new Set(pinned);
  return {
    evaluate({ signerKey, knownOwnerKeys }) {
      if (knownOwnerKeys.has(signerKey)) {
        return { trusted: true };
      }
      if (pinnedSet.has(signerKey)) {
        return { trusted: true, anchorAs };
      }
      return {
        trusted: false,
        reason: 'Signer key is neither an anchored nor a pinned owner (pinned-key trust policy)',
      };
    },
  };
}

/**
 * Opt-in interactive policy: trust keys already in the node-local anchor, and
 * on an unknown key invoke `confirm` (e.g. a host UI prompt). The key is
 * trusted iff `confirm` resolves true, and a confirmed key is persisted into the
 * anchor as an 'operator' pin (a human at the console is the same provenance as
 * an explicit operator pin) so the prompt is not repeated. Not enabled by default.
 */
export function tofuTrustPolicy(
  confirm: (ctx: SeedTrustContext) => Promise<boolean>
): SeedTrustPolicy {
  return {
    async evaluate(ctx) {
      if (ctx.knownOwnerKeys.has(ctx.signerKey)) {
        return { trusted: true };
      }
      const accepted = await confirm(ctx);
      return accepted
        ? { trusted: true, anchorAs: 'operator' }
        : { trusted: false, reason: 'TOFU confirmation declined for unknown signer key' };
    },
  };
}

/** Failed proofs tolerated inside one window before further proofs are refused unverified. */
const DEFAULT_CLAIM_FAILURE_LIMIT = 10;
/** The sliding window the failure limit counts over (ms). */
const DEFAULT_CLAIM_FAILURE_WINDOW_MS = 60_000;

export interface ClaimSecretTrustPolicyOptions {
  /** The node's one-time claim secret, already parsed (`parseClaimSecret`): 32 bytes. */
  secret: Uint8Array;
  /**
   * The node's anchor. A key under source `claim` here is the durable "this node is
   * claimed" marker; the policy writes it and awaits its durability before accepting.
   * Must be the same store the `SeedBootstrapService` snapshots into
   * `SeedTrustContext.knownOwnerKeys`: steps 1 and 2 read that snapshot, and a claim
   * written to a different store would never be seen there.
   */
  trustedOwners: TrustedOwnerStore;
  /** Called once, after the claim is durable, with the owner key that claimed the node. */
  onClaimed?: (signerKey: string) => void;
  /** Failed proofs tolerated per window; default {@link DEFAULT_CLAIM_FAILURE_LIMIT}. */
  failureLimit?: number;
  /** The window those failures are counted over (ms); default {@link DEFAULT_CLAIM_FAILURE_WINDOW_MS}. */
  failureWindowMs?: number;
  /** Clock, injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Cold-start policy for a node that belongs to nobody yet: accept the first seed whose
 * sender proves it holds this node's one-time claim secret, anchor that signer under
 * source `claim`, and from then on behave as the anchored policy.
 *
 * Decision order, for a signer key `K` with proof `P`:
 *
 *  1. `K` is anchored → trusted. The node was claimed by this owner earlier, possibly in
 *     an earlier process. This is also why a claimed node restarted with the secret still
 *     in its config ignores the secret.
 *  2. The anchor holds some other key, or the in-process latch names another key →
 *     refused, `already-claimed`.
 *  3. The latch names `K` → trusted. The same owner re-sent while its first delivery's
 *     persist is still in flight (a dropped response); idempotent success.
 *  4. No `P` → refused, `claim-proof-invalid`.
 *  5. Too many failed proofs recently → refused, `claim-rate-limited`, without verifying.
 *  6. `P` does not verify → one failure counted, refused, `claim-proof-invalid`.
 *  7. Latch `K`, then `trustedOwners.trust(K, 'claim')` and await it. Durable → trusted,
 *     with no `anchorAs` (the policy anchored the key itself). Persist rejected → remove
 *     `K` from the anchor, clear the latch, refuse `claim-not-persisted`; the claimant
 *     may retry.
 *
 * The anchor write is the commit point. `SeedBootstrapService.anchorAcceptedSigner`
 * deliberately logs and continues when a persist fails, which is right for a pin that
 * is re-supplied at the next start but wrong here: a lost claim anchor would leave the
 * node unclaimed again after a restart with nobody told. Keeping the latch, the anchor
 * write and the rollback in one object is what lets the refusal be definite.
 *
 * The failure limit is node-wide, not per peer: libp2p peer ids are free to mint, so a
 * per-peer limit is bypassed by reconnecting. With a 256-bit secret guessing is
 * infeasible either way; the limit bounds CPU and log noise, not security.
 */
export function claimSecretTrustPolicy(options: ClaimSecretTrustPolicyOptions): SeedTrustPolicy {
  const { secret, trustedOwners, onClaimed } = options;
  const failureLimit = options.failureLimit ?? DEFAULT_CLAIM_FAILURE_LIMIT;
  const failureWindowMs = options.failureWindowMs ?? DEFAULT_CLAIM_FAILURE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());

  /**
   * The signer whose claim this process has accepted or is persisting. Set
   * synchronously in `evaluate`, before its first `await`, so a second claimant whose
   * evaluation interleaves with the first's persist sees it and is refused.
   */
  let latchedSigner: string | undefined;
  /** Wall-clock times of recent failed proofs, oldest first. */
  const failureTimes: number[] = [];

  function refuse(code: SeedRefusalCode, reason: string): SeedTrustDecision {
    return { trusted: false, code, reason };
  }

  /** Drop failures older than the window, then say whether the limit is reached. */
  function rateLimited(at: number): boolean {
    while (failureTimes.length > 0 && failureTimes[0]! <= at - failureWindowMs) {
      failureTimes.shift();
    }
    return failureTimes.length >= failureLimit;
  }

  async function anchorClaim(signerKey: string): Promise<SeedTrustDecision> {
    try {
      await trustedOwners.trust(signerKey, 'claim');
    } catch (error) {
      log('claim anchor persist failed; rolling the claim back: %o', error);
      await rollbackClaim(signerKey);
      return refuse('claim-not-persisted', 'This node could not durably record the claim; it remains unclaimed, retry');
    }
    log('node claimed by signer %s', signerKey);
    notifyClaimed(signerKey);
    return { trusted: true };
  }

  /**
   * Undo an in-memory anchor whose persist failed, so the node is unclaimed again.
   * Best effort: the remove is a second write to the same slot and may fail the same
   * way, and the latch clears regardless so the claimant (or another) can retry. A
   * claimant refused `already-claimed` while this was in flight was refused wrongly and
   * simply retries; acceptable.
   */
  async function rollbackClaim(signerKey: string): Promise<void> {
    try {
      await trustedOwners.remove(signerKey);
    } catch (error) {
      log('failed to remove the un-persisted claim anchor for %s: %o', signerKey, error);
    }
    latchedSigner = undefined;
  }

  /** The claim is durable whatever the callback does; a throwing embedder must not undo it. */
  function notifyClaimed(signerKey: string): void {
    try {
      onClaimed?.(signerKey);
    } catch (error) {
      log('onClaimed callback threw; the claim stands: %o', error);
    }
  }

  return {
    evaluate(ctx) {
      if (ctx.knownOwnerKeys.has(ctx.signerKey)) {
        return { trusted: true };
      }
      if (ctx.knownOwnerKeys.size > 0 || (latchedSigner !== undefined && latchedSigner !== ctx.signerKey)) {
        return refuse('already-claimed', 'This node has already been claimed by another owner');
      }
      if (latchedSigner === ctx.signerKey) {
        return { trusted: true };
      }
      if (ctx.claimProof === undefined) {
        return refuse('claim-proof-invalid', 'This node is unclaimed and accepts only a seed carrying its claim proof');
      }
      const at = now();
      if (rateLimited(at)) {
        return refuse('claim-rate-limited', 'Too many failed claim proofs recently; retry later');
      }
      if (!verifyClaimProof(secret, ctx.localPeerId, ctx.signerKey, ctx.seedDigest, ctx.claimProof)) {
        failureTimes.push(at);
        log('claim proof from %s did not verify (%d recent failure(s))', ctx.remotePeerId ?? 'local', failureTimes.length);
        return refuse('claim-proof-invalid', 'The claim proof does not verify for this node, signer and seed');
      }
      // Everything above ran synchronously: this is the first point the policy yields,
      // and the latch is set before it. Two claimants racing with valid proofs therefore
      // cannot both reach the anchor write; the second sees the latch at step 2.
      latchedSigner = ctx.signerKey;
      return anchorClaim(ctx.signerKey);
    },
  };
}
