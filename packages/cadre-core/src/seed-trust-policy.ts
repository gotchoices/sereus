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
 *     (founding the party, the `CadreInvite` that enrolled this node, an
 *     operator pin). Deliberately NOT the replicated `CadreControl.OwnerKey`
 *     table — any connecting node can genesis-insert its own key there and let
 *     it replicate, so that table can be made to say "yes" by a stranger.
 *  2. Pinned out-of-band — keys handed to the node for this seed only (carried
 *     by a `CadreInvite.ownerKeys`, or pinned by an operator) without having
 *     been anchored yet.
 *  3. TOFU (opt-in) — an explicit confirmation callback invoked on first sight
 *     of an unknown signer key. Interactive hosts only; off by default.
 *
 * Secure default (`anchoredTrustPolicy`): a node with an empty anchor and no
 * pinned keys rejects the seed — a seed can no longer vouch for its own signer,
 * and neither can a polluted replicated table.
 *
 * A key accepted via anchor 2 or 3 is reported back through
 * {@link SeedTrustDecision.anchorAs} so `applySeed` can persist it into the
 * node-local anchor, and later seeds from the same owner are accepted without
 * re-supplying the invite/confirmation.
 */
import type { TrustSource } from './trusted-owner-store.js';

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
}

export interface SeedTrustDecision {
  /** Whether the signer key is trusted. */
  trusted: boolean;
  /** Human-readable reason, surfaced as the seed-apply error when not trusted. */
  reason?: string;
  /**
   * Set when the key was trusted via an anchor OUTSIDE the node-local store (a
   * pinned key, a TOFU confirmation): the provenance to record it under, so
   * `applySeed` persists it and the next seed from that owner is anchored
   * without re-supplying the pin. Omitted when the key was already anchored
   * (nothing to persist) or not trusted at all.
   */
  anchorAs?: Exclude<TrustSource, 'genesis'>;
}

/**
 * Decides whether a signature-verified seed's signer key should be trusted.
 * May be synchronous (anchored/pinned) or asynchronous (TOFU confirmation).
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
 * (typically `CadreInvite.ownerKeys` or operator config). Lets an unenrolled
 * invitee accept its first seed without the seed vouching for itself.
 *
 * @param anchorAs - provenance under which a pin-only acceptance is persisted
 *   into the node-local anchor ('invite' by default — the invite-redemption
 *   case; pass 'operator' for an operator-supplied pin).
 */
export function pinnedKeyTrustPolicy(
  pinned: Iterable<string>,
  anchorAs: Exclude<TrustSource, 'genesis'> = 'invite'
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
 * on an unknown key invoke `confirm` (e.g. a trust-circle UI prompt). The key is
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
