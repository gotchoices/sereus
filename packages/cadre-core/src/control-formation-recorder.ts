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
 * usage questions. Under the picked **provision-then-record** model the host
 * strand already exists (authority-signed up front and named by the invite's
 * `StrandId`), so {@link recordUsage} writes the consent row against that
 * pre-existing strand (record-only) rather than inserting a new `Strand`. This
 * replaces the in-memory stubs used by the formation tests so the consent path
 * is exercised against the persisted control network.
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
   * Record consent against an **already-existing** host strand (record-only): the
   * single `FormationUsage` insert auto-commits and the deferred `StrandExists`
   * CHECK is satisfied by the pre-existing strand. This is the provision-then-record
   * commitment — the strand was minted authority-signed up front, so we do NOT
   * re-insert it (which would double-insert the same PK). `initiatorKey` is carried
   * as the usage `PeerId` (advisory). Use {@link ControlDatabase.redeemInvitation}
   * for the consent-creates-strand path instead.
   */
  async recordUsage(token: string, initiatorKey: string, strandId: string): Promise<void> {
    await this.controlDatabase.recordFormationUsage({ token, strandId, peerId: initiatorKey });
    log('Recorded formation usage: token=%s strand=%s', token, strandId);
  }

  /**
   * Resolve the host strand this invite binds to, for provision-then-record. Reads
   * the invite's `StrandId`, then the strand's `MemberPrivateKey` (the closed-strand
   * read-gating secret) to deliver to a validated invitee. Returns null when the
   * invite carries no strand binding (legacy/open responder-provisions path) or the
   * named strand is missing.
   */
  async resolveStrand(
    token: string
  ): Promise<{ strandId: string; memberPrivateKey: string | null } | null> {
    const invite = await this.controlDatabase.queryFormationInvite(token);
    if (!invite || !invite.strandId) {
      return null;
    }
    const strand = await this.controlDatabase.queryStrand(invite.strandId);
    return {
      strandId: invite.strandId,
      memberPrivateKey: strand?.MemberPrivateKey ?? null,
    };
  }
}
