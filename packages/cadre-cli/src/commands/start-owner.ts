/**
 * `cadre start --owner` and `--owner-grant`: this server deliberately holds an owner key for its
 * party (`docs/architecture.md` → Owner Keys), kept in the owner key file (`owner-key-file.ts`),
 * never derived from the node identity.
 *
 * The key is loaded, or created, before the node is built, so a file that cannot be read fails the
 * start before any port is bound. Once the control database is up, `--owner` wires it by where it
 * stands in the party's `OwnerKey` table ({@link ownerKeyStanding}); `--owner-grant` first makes it
 * an owner with the grant ({@link redeemStartupOwnerGrant}).
 */
import os from 'node:os';
import debug from 'debug';
import { OWNER_KEY_MAX_LABEL, type CadreNode, type ControlDatabase, type OwnerGrantBundle, type OwnerSigner } from '@serfab/cadre-core';
import { loadOrCreateOwnerKeyFile, ownerKeyFingerprint } from './owner-key-file.js';
import { modeOpenToOtherAccounts } from './private-file.js';
import { describeRedemptionFailure } from './start-invitation.js';
import type { OwnerGrantRedemptionStatus } from '../server/health.js';

const log = debug('cadre:cli:start-owner');

/** The owner key a `--owner` start signs with, and the file it lives in. */
export interface ServerOwnerKey {
  signer: OwnerSigner;
  file: string;
}

/**
 * The label a founding owner key gets: `--owner-label`, trimmed, else `server <hostname>` cut to
 * the longest label the control schema takes. Refused before anything starts when the operator's
 * is blank or too long, rather than when the genesis insert would refuse it.
 */
export function ownerKeyLabel(option: string | undefined, hostname: string = os.hostname()): string {
  if (option === undefined) return `server ${hostname}`.slice(0, OWNER_KEY_MAX_LABEL);
  const trimmed = option.trim();
  if (trimmed.length === 0) throw new Error('--owner-label must not be blank');
  if (trimmed.length > OWNER_KEY_MAX_LABEL) {
    throw new Error(`--owner-label must be at most ${OWNER_KEY_MAX_LABEL} characters (this one has ${trimmed.length})`);
  }
  return trimmed;
}

/**
 * The key in `file`, creating it when there is none and saying so on stderr: making a server an
 * owner is a choice whose cost the operator should see once, plainly.
 */
export async function loadServerOwnerKey(file: string, partyId: string): Promise<ServerOwnerKey> {
  const { signer, created } = await loadOrCreateOwnerKeyFile(file);
  if (created) {
    console.warn(`⚠ This server now holds an owner key for party ${partyId}: ${file} (owner key ${ownerKeyFingerprint(signer.publicKey)}).`);
    console.warn('  Anyone who can read that file controls the cadre. Keep it private, and back it up with `cadre owner-key export`.');
  }
  const mode = modeOpenToOtherAccounts(file);
  if (mode !== undefined) {
    console.warn(`⚠ ${file} is readable by other accounts (mode ${mode.toString(8)}); anyone who reads it controls the cadre. Run: chmod 600 ${file}`);
  }
  return { signer, file };
}

/** Where a key stands in a party's `OwnerKey` table, which decides what a `--owner` start does with it. */
export type OwnerKeyStanding =
  /** The party has no owner key: the key founds it. */
  | 'founding'
  /** The key is a live owner: wire it, insert nothing. */
  | 'owner'
  /** The party has owners and this key is not one of them: refuse. */
  | 'not-an-owner';

/**
 * `founding` is judged on the raw rows (`hasOwnerKey`), as the genesis insert is, so a party whose
 * only rows are retired is not re-founded; `owner` on the live set (`getOwnerKeys`).
 */
export async function ownerKeyStanding(db: ControlDatabase, publicKey: string): Promise<OwnerKeyStanding> {
  if (!(await db.hasOwnerKey())) return 'founding';
  return (await db.getOwnerKeys()).has(publicKey) ? 'owner' : 'not-an-owner';
}

/**
 * Wire the server's owner key on a started node: genesis-insert it under `label` on a party with
 * no owner, wire it as it is on a party that lists it, and refuse, inserting nothing, on a party
 * whose owners do not include it. The refusal names the key, so an owner can add it and the
 * operator start again.
 */
export async function wireServerOwnerKey(node: CadreNode, owner: ServerOwnerKey, label: string): Promise<void> {
  const db = node.getControlDatabase();
  if (!db) throw new Error('Control database unavailable after start; cannot wire the owner key');
  const { publicKey } = owner.signer;
  const fingerprint = ownerKeyFingerprint(publicKey);
  let standing = await ownerKeyStanding(db, publicKey);
  if (standing === 'founding' && !(await db.ensureOwnerKey(publicKey, label))) {
    // An owner row replicated in between the read and the insert; judge the key against it.
    standing = await ownerKeyStanding(db, publicKey);
  }
  if (standing === 'not-an-owner') {
    throw new Error(
      `This server's owner key ${fingerprint} (${owner.file}) is not an owner of party ${node.partyId}, which already has owners. `
      + `Add it as an owner from a device that holds one of the party's owner keys (its public key is ${publicKey}), `
      + 'or import one of the party\'s owner keys here with `cadre owner-key import`, then start again with --owner; '
      + 'or start with an owner grant (--owner-grant) instead, which makes this key an owner.',
    );
  }
  console.log(standing === 'founding'
    ? `✓ Genesis: founded party ${node.partyId} with owner key ${fingerprint} ("${label}")`
    : `• Owner key ${fingerprint} is an owner of party ${node.partyId}; no genesis`);
  await node.useOwnerSigner(owner.signer);
}

/**
 * `--owner` beside an owner grant, refused on a party with no owner in this node's store: there
 * `--owner` would found the party with the owner key file's key, while the grant joins one. On a
 * party with owners the two agree and the grant decides ({@link redeemStartupOwnerGrant}).
 *
 * NOTE: judged once the node has started, since the store is what says whether the party is
 * fresh, so the refusal exits a node whose ports are already bound; nothing has been written or
 * redeemed by then.
 */
export async function refuseFoundingBesideGrant(node: CadreNode, source: string): Promise<void> {
  const db = node.getControlDatabase();
  if (!db) throw new Error('Control database unavailable after start; cannot redeem the owner grant');
  if (!(await db.hasOwnerKey())) {
    throw new Error(`${source} and --owner cannot be combined on a node that holds no owner of party ${node.partyId}: `
      + `--owner would found the party here, and an owner grant joins one. Start with ${source} alone.`);
  }
}

/**
 * Make the owner key file's key an owner of the node's party with an owner grant and wire it, and
 * say how it ended, on the console and as the `/status` answer. Never throws: a failure is reported
 * and the node keeps running, as a failed `--invitation` leaves it, and the operator starts again
 * with the same grant or a fresh one.
 *
 * - A key that is already an owner here is wired and spends nothing: a restart with the flag still
 *   in the service file. Asked first because the grant's local path refuses `alone` before it asks,
 *   and a node just started may have no connection yet.
 * - A member of the party redeems in its own store (`CadreNode.redeemOwnerGrant`'s local path).
 * - Any other node joins the cadre as a machine and an owner (`CadreNode.joinWithOwnerGrant`).
 *
 * The key may own other cadres already; it becomes an owner of this one too.
 */
export async function redeemStartupOwnerGrant(node: CadreNode, owner: ServerOwnerKey, grant: OwnerGrantBundle): Promise<OwnerGrantRedemptionStatus> {
  try {
    return await redeemForServerKey(node, owner, grant);
  } catch (err) {
    const failure = describeRedemptionFailure(err);
    console.error(`✗ Failed to redeem the owner grant: ${failure.error}`);
    return { state: 'failed', ...failure };
  }
}

async function redeemForServerKey(node: CadreNode, owner: ServerOwnerKey, grant: OwnerGrantBundle): Promise<OwnerGrantRedemptionStatus> {
  const { signer } = owner;
  if (await node.wireOwnKeyIfOwner(signer)) {
    console.log(`• Owner key ${ownerKeyFingerprint(signer.publicKey)} is already an owner of party ${node.partyId}; the owner grant was not used. `
      + 'Start with --owner instead of --owner-grant from now on.');
    return { state: 'accepted', ownerKey: signer.publicKey, alreadyOwner: true, ownerWired: true };
  }
  const self = node.peerId?.toString();
  if (self !== undefined && await node.isMember(self)) {
    // The local path refuses `alone`, and a node that has just started has opened no control
    // connection yet: one dial pass first, so a member whose siblings answer is not refused for that.
    // A failed pass is only logged: the redemption then reports `alone` (retryable) itself, where
    // the pass's own error would be reported as final.
    await node.reconcileControlCohort().catch((err: unknown) => log('Dial pass before the owner grant redemption failed: %o', err));
    const { alreadyOwner } = await node.redeemOwnerGrant(grant, signer);
    return reportGrantRedeemed(node, owner, { alreadyOwner, ownerWired: await node.wireOwnKeyIfOwner(signer) });
  }
  const joined = await node.joinWithOwnerGrant(grant, signer);
  return reportGrantRedeemed(node, owner, { alreadyOwner: joined.alreadyOwner, ownerWired: joined.ownerWired, memberPeerId: joined.peerId });
}

/** Say what a redemption that went through did, and return it as `/status` reports it. `memberPeerId` is undefined when the node redeemed as a member. */
function reportGrantRedeemed(
  node: CadreNode,
  owner: ServerOwnerKey,
  outcome: { alreadyOwner: boolean; ownerWired: boolean; memberPeerId?: string | null },
): OwnerGrantRedemptionStatus {
  const { alreadyOwner, ownerWired, memberPeerId } = outcome;
  const fingerprint = ownerKeyFingerprint(owner.signer.publicKey);
  const joined = memberPeerId === undefined ? '' : `, and this node joined it, admitted by member ${memberPeerId ?? '(unnamed address)'}`;
  console.log(alreadyOwner
    ? `✓ Owner key ${fingerprint} (${owner.file}) was already an owner of party ${node.partyId}, so the grant spent no use${joined}`
    : `✓ Owner grant accepted: owner key ${fingerprint} (${owner.file}) is now an owner of party ${node.partyId}${joined}`);
  if (!ownerWired) {
    console.warn('⚠ The key\'s OwnerKey row has not reached this node yet, so the node does not sign as an owner in this run. '
      + 'Start it again once the row has synced, with --owner from then on.');
  }
  return {
    state: 'accepted',
    ownerKey: owner.signer.publicKey,
    alreadyOwner,
    ownerWired,
    ...(memberPeerId ? { memberPeerId } : {}),
  };
}

/**
 * Write a node's own signed `CadrePeer` row once it signs as an owner, before any seed can be
 * minted. The background heartbeat keeps it fresh, but it fires too late for the first invite or
 * seed: without this, `createSeed()` would omit this node, so a freshly-seeded node would have no
 * address for the seed's minter to dial (`applySeed` dials the seed's preferred peers) until the
 * heartbeat (about 7.5 minutes) first published the row.
 */
export async function registerOwnerNode(node: CadreNode): Promise<void> {
  console.log('✓ Owner seed-bootstrap initialized');
  const selfReg = await node.registerSelf();
  const selfRegMessage: Record<typeof selfReg, string> = {
    inserted: '✓ Owner self-registered into CadrePeer (row inserted)',
    refreshed: '✓ Owner CadrePeer record refreshed',
    skipped: '• Owner self-registration skipped (see logs for the reason; the heartbeat retries)',
  };
  console.log(selfRegMessage[selfReg]);
}
