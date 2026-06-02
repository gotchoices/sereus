/**
 * Trust-anchor policy for control-network seeds.
 *
 * A seed carries an ed25519 signature over its body and the `signerKey` that
 * produced it. Verifying that signature only proves the seed is internally
 * consistent — it does NOT prove the signer is an authority, because both the
 * signer key and the seed's own `isAuthority` peer flags are attacker-supplied.
 * The trust decision must therefore rest on an anchor that does not come from
 * the seed body:
 *
 *  1. DB-anchored — keys already in the receiver's `CadreControl.AuthorityKey`
 *     table (steady state: the node is enrolled / has synced control state).
 *  2. Pinned out-of-band — keys handed to the node from outside the seed
 *     (carried by a `CadreInvite.authorityKeys`, or pinned by an operator).
 *  3. TOFU (opt-in) — an explicit confirmation callback invoked on first sight
 *     of an unknown signer key. Interactive hosts only; off by default.
 *
 * Secure default (`dbAnchoredTrustPolicy`): a cold-start node with an empty
 * `AuthorityKey` table and no pinned keys rejects the seed — a seed can no
 * longer vouch for its own signer.
 */
export interface SeedTrustContext {
  /** Party the seed claims to belong to. */
  partyId: string;
  /** ed25519 base64url signer key — already signature-verified by `applySeed`. */
  signerKey: string;
  /**
   * The receiver's known authority keys, sourced from its `AuthorityKey`
   * table — NOT from the seed. Empty for a cold-start node.
   */
  knownAuthorityKeys: ReadonlySet<string>;
}

export interface SeedTrustDecision {
  /** Whether the signer key is trusted. */
  trusted: boolean;
  /** Human-readable reason, surfaced as the seed-apply error when not trusted. */
  reason?: string;
}

/**
 * Decides whether a signature-verified seed's signer key should be trusted.
 * May be synchronous (DB/pinned anchors) or asynchronous (TOFU confirmation).
 */
export interface SeedTrustPolicy {
  evaluate(ctx: SeedTrustContext): Promise<SeedTrustDecision> | SeedTrustDecision;
}

/**
 * Default policy: trust only keys already present in the receiver's
 * `AuthorityKey` table. A cold-start node (empty table) rejects every seed.
 */
export function dbAnchoredTrustPolicy(): SeedTrustPolicy {
  return {
    evaluate({ signerKey, knownAuthorityKeys }) {
      if (knownAuthorityKeys.has(signerKey)) {
        return { trusted: true };
      }
      return {
        trusted: false,
        reason: 'Signer key is not a known authority (DB-anchored trust policy)',
      };
    },
  };
}

/**
 * Cold-start policy: trust keys in the receiver's `AuthorityKey` table plus a
 * set pinned out-of-band (typically `CadreInvite.authorityKeys` or operator
 * config). Lets an unenrolled invitee accept its first seed without the seed
 * vouching for itself.
 */
export function pinnedKeyTrustPolicy(pinned: Iterable<string>): SeedTrustPolicy {
  const pinnedSet = new Set(pinned);
  return {
    evaluate({ signerKey, knownAuthorityKeys }) {
      if (knownAuthorityKeys.has(signerKey) || pinnedSet.has(signerKey)) {
        return { trusted: true };
      }
      return {
        trusted: false,
        reason: 'Signer key is neither a known nor a pinned authority (pinned-key trust policy)',
      };
    },
  };
}

/**
 * Opt-in interactive policy: trust keys already in the `AuthorityKey` table,
 * and on an unknown key invoke `confirm` (e.g. a trust-circle UI prompt). The
 * key is trusted iff `confirm` resolves true. Not enabled by default.
 */
export function tofuTrustPolicy(
  confirm: (ctx: SeedTrustContext) => Promise<boolean>
): SeedTrustPolicy {
  return {
    async evaluate(ctx) {
      if (ctx.knownAuthorityKeys.has(ctx.signerKey)) {
        return { trusted: true };
      }
      const accepted = await confirm(ctx);
      return accepted
        ? { trusted: true }
        : { trusted: false, reason: 'TOFU confirmation declined for unknown signer key' };
    },
  };
}
