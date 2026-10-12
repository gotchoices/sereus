/**
 * Removing a machine from a cadre: the listing an app shows (`CadreNode.listMachines`), the
 * read-only plan behind its confirmation step (`CadreNode.planMachineRemoval`), and the
 * check that a requested re-vouch stays inside that plan. Pure projections over rows the
 * node has already read; the reads and writes themselves are `CadreNode.removeMachine`'s and
 * `ControlDatabase.removeMachine`'s.
 *
 * A machine's owner key is its own identity key: an owner-granting invitation seats
 * `OwnerKey.Key = CadrePeer.PublicKey`, and `addOwner` takes the key behind a peer id. So
 * "this machine is an owner" is "the ed25519 key behind its peer id is a live `OwnerKey`",
 * and an owner key with no machine row is still listed, as the machine it names.
 */

import { ed25519PublicKeyB64FromPeerId, peerIdFromEd25519PublicKeyB64 } from './ed25519-key.js';
import { verifyPeerRecordSignature } from './peer-record.js';
import type {
  CadreInviteStatus,
  CadreInviteUsageRow,
  CadreMachine,
  CadrePeerRow,
  MachineRemovalPlan,
  MachineRemovalRefusal,
  OwnerKeyRow,
  RemoveMachineOptions,
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
  'self': 'an owner cannot remove its own machine; ask another owner',
  'last-owner': 'it holds the only live owner key',
};

/** What {@link describeMachines} projects from: one node's live rows and its own predicate. */
export interface MachineListingInput {
  partyId: string;
  selfPeerId: string | null;
  /** Live `CadrePeer` rows (`ControlDatabase.queryCadrePeers`). */
  rows: readonly CadrePeerRow[];
  /** Live `OwnerKey` rows (`ControlDatabase.queryOwnerKeyRows`). */
  owners: readonly OwnerKeyRow[];
  /** This node's authorized-membership predicate for one row (`CadreNode.listAuthorizedMembers`'s). */
  trusted: (row: CadrePeerRow) => boolean;
}

/**
 * One entry per live `CadrePeer` row, then one per live `OwnerKey` whose key derives a peer
 * id with no row. `profile` and `lastPublishedAt` are reported only when the row's
 * self-signature verifies under the key behind its peer id, as `CadreNode.resolvePeerAddrs`
 * judges the same record: no insert rule constrains `Profile`, and an owner re-vouch may
 * bump `UpdatedAt` without re-signing.
 */
export function describeMachines(input: MachineListingInput): CadreMachine[] {
  const ownerKeys = new Set(input.owners.map((owner) => owner.key));
  const machines = input.rows.map((row) => describeMemberRow(input, row, ownerKeys));
  const listed = new Set(machines.map((machine) => machine.peerId));
  for (const owner of input.owners) {
    const peerId = peerIdFromEd25519PublicKeyB64(owner.key);
    if (peerId === null || listed.has(peerId)) {
      continue;
    }
    listed.add(peerId);
    machines.push({
      peerId,
      publicKey: owner.key,
      isSelf: peerId === input.selfPeerId,
      isOwner: true,
      isMember: false,
      trusted: false,
      profile: null,
      lastPublishedAt: null,
      vouchedBy: owner.vouchOwner,
    });
  }
  return machines;
}

function describeMemberRow(input: MachineListingInput, row: CadrePeerRow, ownerKeys: ReadonlySet<string>): CadreMachine {
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
    isOwner: publicKey !== null && ownerKeys.has(publicKey),
    isMember: true,
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
  rows: readonly CadrePeerRow[];
  owners: readonly OwnerKeyRow[];
  selfPeerId: string | null;
  /** This node's enrolled owner key (`CadreNode.enrolledOwnerSigningKey`), or null when it cannot sign owner writes. */
  selfOwnerKey: string | null;
  invites: readonly CadreInviteStatus[];
  usages: readonly CadreInviteUsageRow[];
}

/**
 * The plan for removing `peerId` from these rows. The refusals come first and by name: a
 * node that cannot sign, the node itself (an owner cannot sign its own `OwnerKey` removal;
 * refusing the whole self-removal keeps one rule for owners and non-owners), and a machine
 * holding the only live owner key. The last cannot coexist with this node being a different
 * owner, but the local count can be wrong under concurrency, so the name stays.
 *
 * `dependents` are the rows the machine's owner key vouched, which every reader judges
 * against its anchor through `VouchOwner`: once the key is removed they stop passing the
 * membership predicate on every machine unless re-vouched first. This node's own rows are
 * reported as `ownDependency` instead, since it cannot re-vouch them itself.
 *
 * `invitations` are the live ones the machine could redeem to come back: targeted at it,
 * or already redeemed by it and still redeemable (a multi-use invitation, or an open
 * owner invitation inside its lifetime). The schema's rule: keeping a device out is removing
 * its row and withdrawing the invitation.
 */
export function planMachineRemoval(input: MachineRemovalPlanInput): MachineRemovalPlan {
  const machine = input.machines.find((candidate) => candidate.peerId === input.peerId) ?? null;
  const key = machine?.isOwner ? machine.publicKey : null;
  const refusal = refusalFor(input, machine);
  const removesOwnerKey = key !== null;
  return {
    machine,
    refusal,
    removesOwnerKey,
    dependents: removesOwnerKey ? dependentsOf(input, key) : { owners: [], peers: [] },
    invitations: invitationsOpenTo(input),
    ownDependency: removesOwnerKey && isOwnDependency(input, key),
  };
}

function refusalFor(input: MachineRemovalPlanInput, machine: CadreMachine | null): MachineRemovalRefusal | null {
  if (input.selfOwnerKey === null) {
    return 'not-an-owner';
  }
  if (input.peerId === input.selfPeerId) {
    return 'self';
  }
  if (machine?.isOwner && input.owners.length <= 1) {
    return 'last-owner';
  }
  return null;
}

function dependentsOf(input: MachineRemovalPlanInput, key: string): MachineRemovalPlan['dependents'] {
  return {
    owners: input.owners
      .filter((owner) => owner.vouchOwner === key && owner.key !== key && owner.key !== input.selfOwnerKey)
      .map((owner) => owner.key),
    peers: input.rows
      .filter((row) => row.vouchOwner === key && row.peerId !== input.peerId && row.peerId !== input.selfPeerId)
      .map((row) => row.peerId),
  };
}

function isOwnDependency(input: MachineRemovalPlanInput, key: string): boolean {
  const ownRow = input.rows.find((row) => row.peerId === input.selfPeerId);
  const ownOwner = input.owners.find((owner) => owner.key === input.selfOwnerKey);
  return ownRow?.vouchOwner === key || ownOwner?.vouchOwner === key;
}

function invitationsOpenTo(input: MachineRemovalPlanInput): string[] {
  const redeemed = new Set(input.usages.filter((usage) => usage.peerId === input.peerId).map((usage) => usage.inviteKey));
  return input.invites
    .filter((status) => status.live && (status.invite.peerId === input.peerId || redeemed.has(status.invite.key)))
    .map((status) => status.invite.key);
}

/**
 * The re-vouch a caller asked for, checked against the plan: every key and peer must be in
 * `plan.dependents`, so a caller cannot re-vouch a row the removed owner never vouched (nor
 * the machine itself, which `dependents.peers` excludes). Throws naming the offenders, before
 * `CadreNode.removeMachine` writes anything. Duplicates are dropped.
 */
export function revouchWithinPlan(plan: MachineRemovalPlan, revouch: RemoveMachineOptions['revouch']): MachineRemovalPlan['dependents'] {
  const owners = [...new Set(revouch?.owners ?? [])];
  const peers = [...new Set(revouch?.peers ?? [])];
  const strayOwners = owners.filter((key) => !plan.dependents.owners.includes(key));
  const strayPeers = peers.filter((peerId) => !plan.dependents.peers.includes(peerId));
  if (strayOwners.length > 0 || strayPeers.length > 0) {
    throw new Error(
      `removeMachine: re-vouch names rows the removed machine did not vouch: ${[...strayOwners, ...strayPeers].join(', ')}`,
    );
  }
  return { owners, peers };
}
