/**
 * Removing a machine from a cadre: the listing an app shows (`CadreNode.listMachines`) and the
 * read-only plan behind its confirmation step (`CadreNode.planMachineRemoval`). Pure
 * projections over rows the node has already read; the reads and writes themselves are
 * `CadreNode.removeMachine`'s and `ControlDatabase.removeMachine`'s.
 *
 * A machine is a `CadrePeer` row and nothing more: an owner key is the person's, so removing a
 * machine leaves every owner key standing, the one the machine's user signed with included
 * (removing one is `CadreNode.removeOwner`, `owner-keys.ts`).
 */

import { ed25519PublicKeyB64FromPeerId } from './ed25519-key.js';
import { verifyPeerRecordSignature } from './peer-record.js';
import type {
  CadreInviteStatus,
  CadreInviteUsageRow,
  CadreMachine,
  CadrePeerRow,
  MachineRemovalPlan,
  MachineRemovalRefusal,
} from './types.js';

/**
 * `CadreNode.removeMachine` refused by name, before any write. `code` says which rule
 * (`MachineRemovalRefusal`), for an app to switch on; the message is for a log.
 */
export class MachineRemovalRefusedError extends Error {
  readonly code: MachineRemovalRefusal;
  readonly peerId: string;

  constructor(peerId: string, code: MachineRemovalRefusal) {
    super(`Cannot remove machine ${peerId}: ${MACHINE_REMOVAL_REFUSAL_REASON[code]}`);
    this.name = 'MachineRemovalRefusedError';
    this.code = code;
    this.peerId = peerId;
  }
}

const MACHINE_REMOVAL_REFUSAL_REASON: Record<MachineRemovalRefusal, string> = {
  'not-an-owner': 'this node holds no enrolled owner key',
  'self': 'it is this node; leaving a cadre is stopping the node and deleting its data',
};

/** What {@link describeMachines} projects from: one node's live rows and its own predicate. */
export interface MachineListingInput {
  partyId: string;
  selfPeerId: string | null;
  /** Live `CadrePeer` rows (`ControlDatabase.queryCadrePeers`). */
  rows: readonly CadrePeerRow[];
  /** This node's authorized-membership predicate for one row (`CadreNode.listAuthorizedMembers`'s). */
  trusted: (row: CadrePeerRow) => boolean;
}

/**
 * One entry per live `CadrePeer` row. `profile` and `lastPublishedAt` are reported only when
 * the row's self-signature verifies under the key behind its peer id, as
 * `CadreNode.resolvePeerAddrs` judges the same record: no insert rule constrains `Profile`, and
 * an owner re-vouch may bump `UpdatedAt` without re-signing.
 */
export function describeMachines(input: MachineListingInput): CadreMachine[] {
  return input.rows.map((row) => describeMemberRow(input, row));
}

function describeMemberRow(input: MachineListingInput, row: CadrePeerRow): CadreMachine {
  const publicKey = ed25519PublicKeyB64FromPeerId(row.peerId);
  const selfPublished = publicKey !== null && row.publicKey === publicKey && row.sig !== null
    && verifyPeerRecordSignature(input.partyId, {
      peerId: row.peerId,
      publicKey,
      addrs: row.multiaddr ? row.multiaddr.split(',') : [],
      updatedAt: row.updatedAt,
      profile: row.profile,
      sig: row.sig,
    });
  return {
    peerId: row.peerId,
    publicKey,
    isSelf: row.peerId === input.selfPeerId,
    trusted: input.trusted(row),
    profile: selfPublished ? row.profile : null,
    lastPublishedAt: selfPublished ? row.updatedAt : null,
    vouchedBy: row.vouchOwner,
  };
}

/** What {@link planMachineRemoval} judges from. */
export interface MachineRemovalPlanInput {
  peerId: string;
  machines: readonly CadreMachine[];
  selfPeerId: string | null;
  /** Whether this node's owner signer is an enrolled owner (`CadreNode.ownerSignerEnrolledIn`), so it can sign the removal. */
  canSign: boolean;
  invites: readonly CadreInviteStatus[];
  usages: readonly CadreInviteUsageRow[];
}

/**
 * The plan for removing `peerId` from these rows. The refusals come first and by name: a node
 * that cannot sign, and the node itself (leaving a cadre is the embedder's flow, which stops
 * the node and deletes its data; the removal notice a machine acts on is built around another
 * machine removing it).
 *
 * `invitations` are the live ones the machine could redeem to come back: targeted at it,
 * or already redeemed by it and still redeemable (a multi-use invitation, or an open
 * owner invitation inside its lifetime). The schema's rule: keeping a device out is removing
 * its row and withdrawing the invitation.
 */
export function planMachineRemoval(input: MachineRemovalPlanInput): MachineRemovalPlan {
  return {
    machine: input.machines.find((candidate) => candidate.peerId === input.peerId) ?? null,
    refusal: refusalFor(input),
    invitations: invitationsOpenTo(input),
  };
}

function refusalFor(input: MachineRemovalPlanInput): MachineRemovalRefusal | null {
  if (!input.canSign) {
    return 'not-an-owner';
  }
  if (input.peerId === input.selfPeerId) {
    return 'self';
  }
  return null;
}

function invitationsOpenTo(input: MachineRemovalPlanInput): string[] {
  const redeemed = new Set(input.usages.filter((usage) => usage.peerId === input.peerId).map((usage) => usage.inviteKey));
  return input.invites
    .filter((status) => status.live && (status.invite.peerId === input.peerId || redeemed.has(status.invite.key)))
    .map((status) => status.invite.key);
}
