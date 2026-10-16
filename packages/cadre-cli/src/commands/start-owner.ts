/**
 * `cadre start --owner`: this server deliberately holds an owner key for its party
 * (`docs/architecture.md` → Owner Keys), kept in the owner key file (`owner-key-file.ts`), never
 * derived from the node identity.
 *
 * The key is loaded, or created, before the node is built, so a file that cannot be read fails the
 * start before any port is bound; it is wired once the control database is up, by where it
 * stands in the party's `OwnerKey` table ({@link ownerKeyStanding}).
 */
import os from 'node:os';
import { OWNER_KEY_MAX_LABEL, type CadreNode, type ControlDatabase, type OwnerSigner } from '@serfab/cadre-core';
import { loadOrCreateOwnerKeyFile, ownerKeyFingerprint } from './owner-key-file.js';
import { modeOpenToOtherAccounts } from './private-file.js';

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
      + 'or import one of the party\'s owner keys here with `cadre owner-key import`; then start again with --owner.',
    );
  }
  console.log(standing === 'founding'
    ? `✓ Genesis: founded party ${node.partyId} with owner key ${fingerprint} ("${label}")`
    : `• Owner key ${fingerprint} is an owner of party ${node.partyId}; no genesis`);
  await node.useOwnerSigner(owner.signer);
}
