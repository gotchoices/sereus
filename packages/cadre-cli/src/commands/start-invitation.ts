/**
 * `cadre start` joining a cadre by invitation, or becoming an owner by owner grant: where the
 * credential comes from, the checks that run before anything starts, the invitation's redemption
 * right after the node is up, and how a failed redemption of either is reported, as `/status`
 * reports it (`InvitationStatus`, `OwnerGrantRedemptionStatus`). The grant's redemption itself is
 * `start-owner.ts`'s, since it seats the owner key file's key.
 */

import {
  CadreInviteRejectedError,
  CadreInviteUnreachableError,
  OwnerGrantIssuerUnknownError,
  OwnerGrantRejectedError,
  OwnerGrantUnreachableError,
  OwnerKeyAddRefusedError,
  decodeCadreInvitation,
  decodeOwnerGrant,
  type CadreInvitation,
  type CadreNode,
  type OwnerGrantBundle,
} from '@serfab/cadre-core';
import { specifiedEnv } from '@serfab/config-check';
import type { InvitationStatus } from '../server/health.js';

/** A credential passed to `cadre start`, and which of its two forms carried it, for the messages that name it. */
interface StartupCredential<Source extends string> {
  encoded: string;
  source: Source;
}

export type StartupInvitation = StartupCredential<'--invitation' | 'CADRE_INVITATION'>;
export type StartupOwnerGrant = StartupCredential<'--owner-grant' | 'CADRE_OWNER_GRANT'>;

/**
 * The credential from its flag or its variable (set-but-empty is unset), refusing both at once.
 * The variable is for a launcher (cadre-host): the text carries the credential's private key, and
 * an argument shows in the process list.
 */
function startupCredential<Flag extends string, Env extends string>(
  names: { flag: Flag; env: Env; noun: string },
  flag: string | undefined,
  env: string | undefined,
): StartupCredential<Flag | Env> | undefined {
  const fromEnv = specifiedEnv(env);
  if (flag && fromEnv !== undefined) {
    throw new Error(`${names.flag} and ${names.env} cannot both be set: pass the ${names.noun} one way.`);
  }
  if (flag) return { encoded: flag, source: names.flag };
  return fromEnv === undefined ? undefined : { encoded: fromEnv, source: names.env };
}

/** The invitation to redeem: `--invitation`, or `CADRE_INVITATION`. */
export function startupInvitation(flag: string | undefined, env: string | undefined): StartupInvitation | undefined {
  return startupCredential({ flag: '--invitation', env: 'CADRE_INVITATION', noun: 'invitation' }, flag, env);
}

/** The owner grant to redeem: `--owner-grant`, or `CADRE_OWNER_GRANT`. */
export function startupOwnerGrant(flag: string | undefined, env: string | undefined): StartupOwnerGrant | undefined {
  return startupCredential({ flag: '--owner-grant', env: 'CADRE_OWNER_GRANT', noun: 'owner grant' }, flag, env);
}

/**
 * Decode a start-up credential and check that it names this node's party, throwing when either
 * fails. The node's redemption repeats the party check, but like `decodeSeedFor` this runs before
 * anything starts, so a credential for another cadre stops start-up instead of leaving the node
 * running un-admitted.
 */
function decodeCredentialFor<T extends { partyId: string }>(
  credential: StartupCredential<string>,
  partyId: string,
  kind: { noun: string; decode: (encoded: string) => T },
): T {
  let decoded: T;
  try {
    decoded = kind.decode(credential.encoded);
  } catch (err) {
    throw new Error(
      `${credential.source} does not decode as ${kind.noun}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (decoded.partyId !== partyId) {
    throw new Error(
      `${credential.source} was minted for party ${decoded.partyId}, but this node's config names party ${partyId} `
      + `(controlNetwork.partyId). Use ${kind.noun} minted by an owner of this party, or correct the config.`
    );
  }
  return decoded;
}

export function decodeInvitationFor(invitation: StartupInvitation, partyId: string): CadreInvitation {
  return decodeCredentialFor(invitation, partyId, { noun: 'a cadre invitation', decode: decodeCadreInvitation });
}

export function decodeOwnerGrantFor(grant: StartupOwnerGrant, partyId: string): OwnerGrantBundle {
  return decodeCredentialFor(grant, partyId, { noun: 'an owner grant', decode: decodeOwnerGrant });
}

/**
 * The start-up options that cannot be combined with an invitation, each with why. A seed is
 * the owner-online way to the same end. `--owner` runs the founder's genesis insert on a fresh
 * store, which on a node that is joining somebody else's cadre would seat a second founding
 * key beside theirs. A machine that should be an owner too joins with an owner grant instead,
 * which seats the owner key file's key as it joins (`start-owner.ts`).
 */
export function refuseInvitationConflicts(invitation: StartupInvitation, options: { seed?: string; owner?: boolean }): void {
  const { source } = invitation;
  if (options.seed) {
    throw new Error(`${source} and --seed cannot be combined: a seed is the owner-online way to join, an invitation the owner-offline way. Pass one of them.`);
  }
  if (options.owner) {
    throw new Error(`${source} and --owner cannot be combined: --owner founds a cadre on this node, an invitation joins one. `
      + `To join as an owner too, start with an owner grant (--owner-grant) instead of ${source}.`);
  }
}

/**
 * The start-up options that cannot be combined with an owner grant: a grant alone joins a node
 * that is not a member yet, so a seed or an invitation beside it is a second way in. `--owner` is
 * refused only on a party with no owner here, once the store is open (`refuseFoundingBesideGrant`
 * in `start-owner.ts`).
 */
export function refuseOwnerGrantConflicts(grant: StartupOwnerGrant, options: { seed?: string; invitation?: StartupInvitation }): void {
  const others = [options.seed ? '--seed' : undefined, options.invitation?.source].filter((name): name is string => name !== undefined);
  if (others.length > 0) {
    throw new Error(`${grant.source} cannot be combined with ${others.join(' or ')}: an owner grant alone makes this server an owner, `
      + 'joining the cadre as a machine too when it is not in it yet. Pass only the grant.');
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
 * window after the owner left their cohort) is not retried here: one pass. If headless joins in
 * that window become common, pass `waitForMember: true` with a `signal` bounding the wait, which
 * keeps making passes on the same signed request until a member accepts or the invitation expires.
 */
export async function redeemStartupInvitation(node: CadreNode, invitation: CadreInvitation): Promise<InvitationStatus> {
  try {
    const joined = await node.redeemCadreInvitation(invitation);
    console.log(`✓ Invitation accepted by member ${joined.peerId ?? '(unnamed address)'}: this node is a member of party ${invitation.partyId}`);
    return { state: 'accepted', ...(joined.peerId ? { memberPeerId: joined.peerId } : {}) };
  } catch (err) {
    const failure = describeRedemptionFailure(err);
    console.error(`✗ Failed to redeem the invitation: ${failure.error}`);
    return { state: 'failed', ...failure };
  }
}

/**
 * A failed redemption, of an invitation or an owner grant, as `/status` reports it. A refusal
 * keeps its code beside its reason, since the code is what a launcher can match on
 * (`invite-spent`, `grant-spent`, `alone`). `retryable` is cadre-core's own verdict where its
 * error carries one; the grant's local-path refusals are retryable as a member's own
 * `issuer-unknown` is, since both clear once the node is connected and synced. Anything else
 * (a reply that fails the check, a precondition) is final.
 */
export function describeRedemptionFailure(err: unknown): { error: string; retryable: boolean } {
  if (err instanceof CadreInviteRejectedError || err instanceof OwnerGrantRejectedError) {
    return { error: `${err.message} (${err.code})`, retryable: err.retryable };
  }
  if (err instanceof CadreInviteUnreachableError) {
    return { error: `No member named in the invitation could be reached. ${err.message}`, retryable: true };
  }
  if (err instanceof OwnerGrantUnreachableError) {
    return { error: `No member named in the owner grant could be reached. ${err.message}`, retryable: true };
  }
  if (err instanceof OwnerKeyAddRefusedError) return { error: `${err.message} (${err.code})`, retryable: true };
  if (err instanceof OwnerGrantIssuerUnknownError) return { error: `${err.message} (issuer-unknown)`, retryable: true };
  return { error: err instanceof Error ? err.message : String(err), retryable: false };
}
