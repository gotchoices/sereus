/**
 * `cadre start` joining a cadre by invitation: where the invitation comes from, the checks
 * that run before anything starts, and the redemption right after the node is up, whose
 * outcome `/status` reports (`InvitationStatus`).
 */

import {
  CadreInviteRejectedError,
  CadreInviteUnreachableError,
  decodeCadreInvitation,
  type CadreInvitation,
  type CadreNode,
} from '@serfab/cadre-core';
import { specifiedEnv } from '@serfab/config-check';
import type { InvitationStatus } from '../server/health.js';

/** The invitation passed to `cadre start`, and which of its two forms carried it, for the messages that name it. */
export interface StartupInvitation {
  encoded: string;
  source: '--invitation' | 'CADRE_INVITATION';
}

/**
 * The invitation to redeem: `--invitation`, or `CADRE_INVITATION` (set-but-empty is unset),
 * refusing both at once. The env form is for a launcher (cadre-host): the bundle carries the
 * invitation's private key, and an argument shows in the process list.
 */
export function startupInvitation(flag: string | undefined, env: string | undefined): StartupInvitation | undefined {
  const fromEnv = specifiedEnv(env);
  if (flag && fromEnv !== undefined) {
    throw new Error('--invitation and CADRE_INVITATION cannot both be set: pass the invitation one way.');
  }
  if (flag) return { encoded: flag, source: '--invitation' };
  return fromEnv === undefined ? undefined : { encoded: fromEnv, source: 'CADRE_INVITATION' };
}

/**
 * Decode the start-up invitation and check that it names this node's party, throwing when
 * either fails. `redeemCadreInvitation` repeats the party check, but like `decodeSeedFor` this
 * runs before anything starts, so a bundle for another cadre stops start-up instead of leaving
 * the node running un-admitted.
 */
export function decodeInvitationFor(invitation: StartupInvitation, partyId: string): CadreInvitation {
  let decoded: CadreInvitation;
  try {
    decoded = decodeCadreInvitation(invitation.encoded);
  } catch (err) {
    throw new Error(
      `${invitation.source} does not decode as a cadre invitation: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (decoded.partyId !== partyId) {
    throw new Error(
      `${invitation.source} was minted for party ${decoded.partyId}, but this node's config names party ${partyId} `
      + '(controlNetwork.partyId). Use an invitation minted by this party\'s owner, or correct the config.'
    );
  }
  return decoded;
}

/**
 * The start-up options that cannot be combined with an invitation, each with why. A seed is
 * the owner-online way to the same end. `--owner` runs the founder's genesis insert on a fresh
 * store, which on a node that is joining somebody else's cadre would seat a second founding
 * key beside theirs; an invitation that grants ownership seats this node's key by consent
 * instead, and the node wires it for signing on a later start with `--owner` once the
 * invitation is dropped.
 */
export function refuseInvitationConflicts(invitation: StartupInvitation, options: { seed?: string; owner?: boolean }): void {
  const { source } = invitation;
  if (options.seed) {
    throw new Error(`${source} and --seed cannot be combined: a seed is the owner-online way to join, an invitation the owner-offline way. Pass one of them.`);
  }
  if (options.owner) {
    throw new Error(`${source} and --owner cannot be combined: --owner founds a cadre on this node, an invitation joins one. `
      + `Join first; if the invitation granted ownership, restart with --owner and without ${source} to wire the key for signing.`);
  }
}

/**
 * Redeem the start-up invitation and say how it ended, on the console and as the `/status`
 * answer. Never throws: a failure is reported and the node keeps running, as a failed `--seed`
 * does — nothing was written here, and the operator (or cadre-host's Retry) starts the node
 * again with the same or a fresh invitation.
 *
 * A node that is already a member (a restart with the invitation still set) is answered as
 * accepted by the member's idempotent redemption; the log line cannot tell the two apart, and
 * neither needs to.
 *
 * NOTE: a retryable failure (no member reachable, or members that answered busy/conflict in the
 * window after the owner left their cohort) is not retried here. If headless joins in that
 * window become common, add a bounded retry on `retryable` before giving up.
 */
export async function redeemStartupInvitation(node: CadreNode, invitation: CadreInvitation): Promise<InvitationStatus> {
  try {
    const joined = await node.redeemCadreInvitation(invitation);
    console.log(`✓ Invitation accepted by member ${joined.peerId ?? '(unnamed address)'}: this node is a member of party ${invitation.partyId}${joined.grantsOwner ? ', and an owner' : ''}`);
    return { state: 'accepted', ...(joined.peerId ? { memberPeerId: joined.peerId } : {}) };
  } catch (err) {
    const failure = describeRedemptionFailure(err);
    console.error(`✗ Failed to redeem the invitation: ${failure.error}`);
    return { state: 'failed', ...failure };
  }
}

/**
 * A failed redemption as `/status` reports it. A member's refusal keeps its code beside its
 * reason, since the code is what a launcher can match on (`invite-spent`, `invite-invalid`).
 * `retryable` is cadre-core's own verdict, and only its two redemption errors carry one:
 * anything else (a reply that fails the check, a precondition) is final.
 */
export function describeRedemptionFailure(err: unknown): { error: string; retryable: boolean } {
  if (err instanceof CadreInviteRejectedError) return { error: `${err.message} (${err.code})`, retryable: err.retryable };
  if (err instanceof CadreInviteUnreachableError) {
    return { error: `No member named in the invitation could be reached. ${err.message}`, retryable: true };
  }
  return { error: err instanceof Error ? err.message : String(err), retryable: false };
}
