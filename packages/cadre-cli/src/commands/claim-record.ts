/**
 * The claim on record: `<nodeStateDir>/claim.json`, what `cadre start` keeps of the claim that
 * gave this node its party and its owner.
 *
 * A node started with `CADRE_CLAIM_SECRET` serves a placeholder party until it is claimed; the
 * claim seed is the first thing to name the real one (cadre-core's `CadreNodeConfig.claim`).
 * cadre-core keys every node-local file on the party (`trusted-owners.<party>.json` and the
 * rest), so on the next start the party has to come from a file whose name does not depend on
 * it — this one, under a fixed name on purpose.
 *
 * Written by the node's claim policy BEFORE it anchors the claimant (record first, anchor
 * second: `CadreNodeConfig.claim.record` says why), and read at every start. A present but
 * malformed file refuses the start rather than starting the node unclaimed: an unclaimed node
 * is claimable by anyone holding the secret, while its owner's cadre has lost it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireEd25519PublicKeyB64, type NodeClaimRecord } from '@serfab/cadre-core';
import type { ResolvedConfig } from '../config/index.js';
import { writePrivateFileAtomically } from './private-file.js';

export const CLAIM_RECORD_FILE = 'claim.json';
const RECORD_VERSION = 1;

/** What `claim.json` holds. The secret is never in it. */
export interface ClaimRecord extends NodeClaimRecord {
  version: typeof RECORD_VERSION;
  /** When the claim was accepted, ISO 8601. */
  claimedAt: string;
}

export function claimRecordPath(nodeStateDir: string): string {
  return join(nodeStateDir, CLAIM_RECORD_FILE);
}

/**
 * The record in `nodeStateDir`, or `undefined` when there is none. A file that is present but
 * unreadable or malformed throws, naming the file: see the module comment for why that must
 * not be a cold start.
 */
export async function readClaimRecord(nodeStateDir: string): Promise<ClaimRecord | undefined> {
  const path = claimRecordPath(nodeStateDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return undefined;
    throw new Error(`The claim record ${path} is present but unreadable`, { cause: err });
  }
  return parseClaimRecord(text, path);
}

/** Shape-check the record's JSON; the owner key is checked as an ed25519 public key. */
export function parseClaimRecord(text: string, path: string): ClaimRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`The claim record ${path} is not valid JSON; this node was claimed and must not start unclaimed. Restore the file or remove it deliberately`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The claim record ${path} is not a JSON object`);
  }
  const { version, partyId, ownerKey, claimedAt } = parsed as Record<string, unknown>;
  if (version !== RECORD_VERSION) {
    throw new Error(`The claim record ${path} has version ${String(version)}; this build reads version ${RECORD_VERSION}`);
  }
  if (typeof partyId !== 'string' || partyId.length === 0) {
    throw new Error(`The claim record ${path} names no party`);
  }
  if (typeof ownerKey !== 'string') {
    throw new Error(`The claim record ${path} names no owner key`);
  }
  if (typeof claimedAt !== 'string') {
    throw new Error(`The claim record ${path} has no claimedAt`);
  }
  return { version: RECORD_VERSION, partyId, ownerKey: requireEd25519PublicKeyB64(ownerKey, `owner key in ${path}`), claimedAt };
}

/**
 * Write the record atomically and durably (`writePrivateFileAtomically`), so a crash leaves
 * either the previous file or the complete new one. Returns what was written.
 */
export async function writeClaimRecord(nodeStateDir: string, claim: NodeClaimRecord, now: () => Date = () => new Date()): Promise<ClaimRecord> {
  const record: ClaimRecord = { version: RECORD_VERSION, partyId: claim.partyId, ownerKey: claim.ownerKey, claimedAt: now().toISOString() };
  await writePrivateFileAtomically(claimRecordPath(nodeStateDir), JSON.stringify(record, null, 2));
  return record;
}

/**
 * The party a node in `config.nodeStateDir` serves, and the claim it serves it for: the claim
 * on record's party when there is one, else the config's `controlNetwork.partyId`, which on a
 * node waiting to be claimed is a placeholder. Every command that builds a node from a config
 * goes through here, so a claimed node's one-shot commands reach its real party too.
 */
export async function partyOnRecord(config: Pick<ResolvedConfig, 'nodeStateDir' | 'controlNetwork'>): Promise<{ partyId: string; claim: ClaimRecord | undefined }> {
  const claim = await readClaimRecord(config.nodeStateDir);
  return { partyId: claim?.partyId ?? config.controlNetwork.partyId, claim };
}
