/**
 * How a formation dial fails, as types a joining device can branch on without reading the
 * human-facing wording: a responder's refusal carries a fixed {@link FormationRejectionCode}
 * on the wire and surfaces as a {@link FormationRejectedError}; a dial that never got an
 * answer surfaces as a {@link FormationUnreachableError}.
 */

/**
 * Why a formation responder refused a join. Sent beside the free-text `reason` on every
 * `approved: false` result frame (`FormationResultMessage.code`).
 */
export type FormationRejectionCode =
  /**
   * No invitation row for this token on THIS responder. Retryable: a sibling machine of the
   * inviter may not have received the row yet. Leaks nothing — only a holder of the token can
   * ask, and an unknown token means the same as one never minted.
   */
  | 'token-unknown'
  /**
   * The invitation expired, or every allowed use is recorded. The loser of a redemption race
   * and a latecomer both get this code, so neither can tell the two apart.
   */
  | 'token-spent'
  /** The joiner's consent signature does not verify (or `partyId` does not embed `peerKey`). */
  | 'consent-invalid'
  /** The responder's disclosure validator refused the disclosure. */
  | 'disclosure-invalid'
  | 'disclosure-too-large'
  /** The invitation's outside approval hook answered no. */
  | 'approval-refused'
  /** The invitation's outside approval hook could not be reached or did not answer in time. */
  | 'approval-unavailable'
  /** The inviter's approval setup is wrong: a malformed answer, an unenrolled key, or a misconfigured hook. */
  | 'approval-invalid'
  /**
   * The host strand is not running (or not yet replicated) on this responder, or issuing the
   * joiner's membership invitation into it failed.
   */
  | 'host-strand-unavailable'
  /** The host strand predates the per-party identity split and can never admit a joiner. */
  | 'host-strand-must-be-recreated'
  /** The responder is at its cap on concurrent formation sessions. */
  | 'busy'
  /** Provisioning outran the responder's budget; the invitation is left unspent. */
  | 'provisioning-timeout'
  /** The consent write failed for a reason other than a spent invitation. */
  | 'conflict'
  /** An unexpected responder-side failure. */
  | 'internal';

/**
 * Which rejections are worth retrying — the single place that says so. A retry repeats the
 * same redemption later (or against another of the inviter's machines); a final code means
 * no retry of this invitation can succeed.
 */
export const FORMATION_REJECTION_RETRYABLE: Readonly<Record<FormationRejectionCode, boolean>> = {
  'token-unknown': true,
  'token-spent': false,
  'consent-invalid': false,
  'disclosure-invalid': false,
  'disclosure-too-large': false,
  'approval-refused': false,
  'approval-unavailable': true,
  'approval-invalid': false,
  'host-strand-unavailable': true,
  'host-strand-must-be-recreated': false,
  'busy': true,
  'provisioning-timeout': true,
  'conflict': true,
  'internal': true
};

/** Is `value` a code this build knows? Own keys only, so a peer's `'constructor'` does not pass. */
export function isFormationRejectionCode(value: unknown): value is FormationRejectionCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FORMATION_REJECTION_RETRYABLE, value);
}

/**
 * The responder answered and refused the join.
 *
 * `code` is `'unrecognized'` when the frame carried no code or one this build does not know
 * — formation runs between two parties on different versions — and such a rejection counts
 * as retryable: retrying an unknown answer until the invitation expires is safe, while giving
 * up on one that would have succeeded is not.
 */
export class FormationRejectedError extends Error {
  readonly code: FormationRejectionCode | 'unrecognized';
  readonly reason: string;
  readonly retryable: boolean;

  /** Both arguments come straight off the wire, so neither is trusted to have its declared type. */
  constructor(code: unknown, reason: unknown) {
    const text = typeof reason === 'string' ? reason : 'no reason provided';
    super(`Formation rejected: ${text}`);
    this.name = 'FormationRejectedError';
    this.code = isFormationRejectionCode(code) ? code : 'unrecognized';
    this.reason = text;
    this.retryable = this.code === 'unrecognized' || FORMATION_REJECTION_RETRYABLE[this.code];
  }
}

/**
 * The dial ended before a result frame was read: no responder address parsed, every address
 * failed to dial, a deadline passed, or the stream closed early. Always retryable. Keeps the
 * underlying failure's message, and the failure itself as `cause`.
 */
export class FormationUnreachableError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FormationUnreachableError';
  }
}

/**
 * The responder approved the join, so the invitation's one-time token is spent, and then a
 * step on the joining machine failed: persisting the party's membership identity, or
 * remembering the join. Never retryable: the same invitation can only answer `token-spent`
 * from now on, so recovery is fixing the local cause and redeeming a fresh invitation.
 */
export class FormationPostApprovalError extends Error {
  readonly retryable = false;

  constructor(readonly strandId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FormationPostApprovalError';
  }
}
