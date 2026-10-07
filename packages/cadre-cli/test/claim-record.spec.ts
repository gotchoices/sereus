import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIM_RECORD_FILE, partyOnRecord, readClaimRecord, writeClaimRecord } from '../src/commands/claim-record.js';

/** A well-formed base64url 32-byte Ed25519 public key; the record checks the shape, not the curve. */
const OWNER_KEY = Buffer.alloc(32, 7).toString('base64url');
const PARTY = 'party-claimed';
const PLACEHOLDER_CONFIG = { controlNetwork: { partyId: 'unclaimed', bootstrapNodes: [] } };

describe('the claim on record (claim.json)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claim-record-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is absent on a node never claimed, and once written names the party the node serves', async () => {
    expect(await readClaimRecord(dir)).toBeUndefined();
    expect((await partyOnRecord({ nodeStateDir: dir, ...PLACEHOLDER_CONFIG })).partyId).toBe('unclaimed');

    const written = await writeClaimRecord(dir, { partyId: PARTY, ownerKey: OWNER_KEY }, () => new Date('2026-10-07T00:00:00Z'));
    expect(await readClaimRecord(dir)).toEqual({ version: 1, partyId: PARTY, ownerKey: OWNER_KEY, claimedAt: '2026-10-07T00:00:00.000Z' });
    expect(await readClaimRecord(dir)).toEqual(written);
    expect((await partyOnRecord({ nodeStateDir: dir, ...PLACEHOLDER_CONFIG })).partyId).toBe(PARTY);
    // The write leaves no temp file behind.
    expect(readdirSync(dir)).toEqual([CLAIM_RECORD_FILE]);
  });

  it('refuses a present but malformed file, naming it, rather than reading as unclaimed', async () => {
    const path = join(dir, CLAIM_RECORD_FILE);
    writeFileSync(path, '{ not json');
    await expect(readClaimRecord(dir)).rejects.toThrow(path);

    writeFileSync(path, JSON.stringify({ version: 2, partyId: PARTY, ownerKey: OWNER_KEY, claimedAt: 'x' }));
    await expect(readClaimRecord(dir)).rejects.toThrow(/version 2/);

    writeFileSync(path, JSON.stringify({ version: 1, partyId: PARTY, ownerKey: 'not-a-key', claimedAt: 'x' }));
    await expect(readClaimRecord(dir)).rejects.toThrow(/owner key/);

    writeFileSync(path, JSON.stringify({ version: 1, partyId: '', ownerKey: OWNER_KEY, claimedAt: 'x' }));
    await expect(readClaimRecord(dir)).rejects.toThrow(/names no party/);
  });
});
