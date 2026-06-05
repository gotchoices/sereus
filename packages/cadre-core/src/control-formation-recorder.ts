import debug from 'debug';
import type { ControlDatabase } from './control-database.js';
import type { FormationUsageRecorder } from './strand-solicitation.js';
import type { OpenInvitation } from './types.js';

const log = debug('sereus:cadre:formation-recorder');

/** Far-future sentinel for an invitation that never expires (max valid JS Date). */
const NEVER_EXPIRES = new Date(8640000000000000);

/**
 * {@link FormationUsageRecorder} backed by the real `CadreControl` tables.
 *
 * It reads `FormationInvite` / `FormationUsage` to answer token-validity and
 * usage questions, and redeems an invite by inserting the `Strand` + matching
 * `FormationUsage` row atomically (the consent branch of `Strand.Authorized`).
 * This replaces the in-memory stubs used by the formation tests so the consent
 * path is exercised against the persisted control network.
 *
 * Usage accounting follows the schema's `FormationUsage.Authorized` semantics:
 * a null `TotalUses` means unlimited uses; otherwise the invite is "used up"
 * once the recorded usage count reaches `TotalUses`.
 */
export class ControlFormationUsageRecorder implements FormationUsageRecorder {
  constructor(private readonly controlDatabase: ControlDatabase) {}

  /** A token is valid when a matching, unexpired `FormationInvite` exists. */
  async isTokenValid(token: string): Promise<{ valid: boolean; invitation?: OpenInvitation }> {
    const invite = await this.controlDatabase.queryFormationInvite(token);
    if (!invite) {
      return { valid: false };
    }
    if (invite.expiresAtMs !== null && invite.expiresAtMs <= Date.now()) {
      log('Token expired: %s', token);
      return { valid: false };
    }
    return {
      valid: true,
      invitation: {
        token: invite.token,
        sAppId: invite.sAppId,
        expiration: invite.expiresAtMs !== null ? new Date(invite.expiresAtMs) : NEVER_EXPIRES,
        bootstrap: [],
      },
    };
  }

  /**
   * A token is "used" when its recorded usage count has reached the invite's
   * `TotalUses`. A null `TotalUses` (unlimited) is never used up; an unknown
   * token is reported not-used (validity is handled by {@link isTokenValid}).
   */
  async isTokenUsed(token: string): Promise<boolean> {
    const invite = await this.controlDatabase.queryFormationInvite(token);
    if (!invite || invite.totalUses === null) {
      return false;
    }
    const uses = await this.controlDatabase.countFormationUsage(token);
    return uses >= invite.totalUses;
  }

  /**
   * Record a redemption: insert the `Strand` row + a matching `FormationUsage`
   * row atomically. `initiatorKey` is carried as the usage `PeerId` (advisory).
   */
  async recordUsage(token: string, initiatorKey: string, strandId: string): Promise<void> {
    await this.controlDatabase.redeemInvitation({ token, strandId, peerId: initiatorKey });
    log('Recorded redemption: token=%s strand=%s', token, strandId);
  }
}
