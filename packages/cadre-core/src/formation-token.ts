import type { FormationRejectionCode } from './strand-formation-rejection.js';

/** The `FormationInvite` columns a formation session acts on. */
export interface FormationInviteFacts {
  sAppId: string;
  /** Epoch ms of the stored `ExpiresAt`; null when the invitation never expires. */
  expiresAtMs: number | null;
  /** Null is unlimited. */
  totalUses: number | null;
  /** A bound invitation's host strand; null on the responder-provisions path. */
  strandId: string | null;
  /** The outside approval hook; null when no approval is required. */
  validationUrl: string | null;
}

/**
 * One formation token as read once at the start of a responder session. Every later step of
 * the session takes this value instead of reading the invite again.
 */
export interface FormationTokenRead {
  token: string;
  /** Null: no invite row here (it may not have replicated to this machine yet). */
  invite: FormationInviteFacts | null;
  /** Uses recorded so far; counted only for a metered, unexpired invite, else null. */
  usesRecorded: number | null;
}

/**
 * What the responder's token check yields; an invalid token names which way it failed. The
 * valid arm carries the session's {@link FormationTokenRead}, absent only when the manager has
 * no recorder and so accepts every token with nothing read.
 */
export type FormationTokenCheck =
  | { valid: true; read?: FormationTokenRead }
  | { valid: false; code: Extract<FormationRejectionCode, 'token-unknown' | 'token-spent'> };

/**
 * `expiresAtMs <= nowMs` is expired: the same boundary `hasOutstandingFormationInvite` applies,
 * so an invite the formation handler refuses can never hold the connection gate open.
 */
export function isInviteExpired(invite: FormationInviteFacts, nowMs: number): boolean {
  return invite.expiresAtMs !== null && invite.expiresAtMs <= nowMs;
}

/** Used up: a metered invite whose recorded uses reached `totalUses`. An unknown token is not used up. */
export function isTokenReadSpent(read: FormationTokenRead): boolean {
  const totalUses = read.invite?.totalUses ?? null;
  return totalUses !== null && read.usesRecorded !== null && read.usesRecorded >= totalUses;
}

/**
 * No invite row is `'token-unknown'` (retryable: the row may not have replicated to this
 * machine yet); an expired or used-up invite is `'token-spent'` (final).
 */
export function classifyTokenRead(read: FormationTokenRead, nowMs: number): FormationTokenCheck {
  if (read.invite === null) {
    return { valid: false, code: 'token-unknown' };
  }
  if (isInviteExpired(read.invite, nowMs) || isTokenReadSpent(read)) {
    return { valid: false, code: 'token-spent' };
  }
  return { valid: true, read };
}
