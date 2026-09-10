import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { StrandInstanceManager, type StartStrandConfig } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
  addManager,
  addMemberByManager,
  bootstrapFounderMembership,
  PreSplitStrandIdentityError,
  removeManager,
} from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { StrandRow, SAppConfig } from '../src/types.js';

/**
 * A closed strand whose founding Member/Manager were seated BEFORE the per-party identity
 * split — under the key derived from the shared `MemberPrivateKey` every joiner holds — is
 * refused by every founder bootstrap (`PreSplitStrandIdentityError`) instead of being
 * silently skipped by the insert-if-absent guards. And the refusal fires only on that
 * fingerprint: a correctly founded strand, including one whose founder handed management
 * to a successor, re-bootstraps cleanly.
 *
 * Drives the real StrandInstanceManager solo. Pre-split rows are seated by launching as a
 * joiner (which writes nothing) and running the founding by hand under the shared-derived
 * key — what a pre-split founder did. Every launch shares one in-memory store and one
 * transport key, so a relaunch or resume hydrates the rows the earlier launch wrote.
 */

const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

function signedSApp(): SAppConfig {
  const priv = generatePrivateKey('ed25519', 'base64url') as string;
  const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
  return { id: pub, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, priv) };
}

interface Fixture {
  strandRow: StrandRow;
  sApp: SAppConfig;
  partyMemberPrivateKey: string;
  /** Derived from the SHARED read secret — the pre-split founding identity. */
  sharedKeyPair: Ed25519KeyPair;
  /** Derived from this party's own StrandPartyKey — the post-split founding identity. */
  partyKeyPair: Ed25519KeyPair;
  storage: MemoryRawStorage;
  transportKey: PrivateKey;
}

async function fixture(): Promise<Fixture> {
  const memberPrivateKey = await generateStrandMemberKey();
  const partyMemberPrivateKey = await generateStrandMemberKey();
  return {
    strandRow: { Id: `pre-split-${randomUUID()}`, MemberPrivateKey: memberPrivateKey, Type: 'c', FounderOwnerKey: null },
    sApp: signedSApp(),
    partyMemberPrivateKey,
    sharedKeyPair: strandMemberKeyPair(memberPrivateKey),
    partyKeyPair: strandMemberKeyPair(partyMemberPrivateKey),
    storage: new MemoryRawStorage(),
    transportKey: await generateKeyPair('Ed25519'),
  };
}

/**
 * A launch over the fixture's store. The background membership loops are disarmed: this
 * suite hand-drives every membership write and asserts exact manager sets.
 */
function launchConfig(f: Fixture, founder: boolean): StartStrandConfig {
  return {
    strandRow: f.strandRow,
    sAppConfig: f.sApp,
    profile: 'transaction',
    defaultLatencyHint: 'interactive',
    storage: { provider: () => f.storage },
    privateKey: f.transportKey,
    founder,
    partyMemberPrivateKey: founder ? f.partyMemberPrivateKey : undefined,
    membershipReconciliation: { enabled: false },
    revocationEnforcement: { enabled: false },
  };
}

/** The pre-split founding: Header/Member/Manager under the key derived from the SHARED secret. */
async function seatPreSplitFounding(db: Database, f: Fixture): Promise<void> {
  await bootstrapFounderMembership(db, { strandId: f.strandRow.Id, type: 'c', sApp: f.sApp, founderKeyPair: f.sharedKeyPair });
}

async function managerKeys(db: Database): Promise<string[]> {
  const keys: string[] = [];
  for await (const row of db.eval('select MemberKey from Strand.Manager')) {
    keys.push(row.MemberKey as string);
  }
  return keys;
}

describe('founder bootstrap on a pre-split closed strand', () => {
  let manager: StrandInstanceManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.stopAll();
      manager = null;
    }
  });

  it('founding in place is refused, re-seats nothing, and is refused again on retry', async () => {
    const f = await fixture();
    manager = new StrandInstanceManager();
    const instance = await manager.startStrand(launchConfig(f, false));
    const db = instance.database!.getDatabase();
    await seatPreSplitFounding(db, f);

    const found = () => manager!.foundExistingStrand(f.strandRow.Id, async () => f.partyMemberPrivateKey);
    const error = await found().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(PreSplitStrandIdentityError);
    expect((error as PreSplitStrandIdentityError).strandId).toBe(f.strandRow.Id);
    expect(await managerKeys(db)).toEqual([f.sharedKeyPair.publicKeyB64]);

    // The founder flip was withdrawn, so a retry re-runs the check instead of resolving
    // 'already-founder' over an instance that never founded.
    await expect(found()).rejects.toThrow(PreSplitStrandIdentityError);
    // The joiner runtime it was launched as stays up.
    expect(manager.getInstance(f.strandRow.Id)?.database).toBeDefined();
  }, 60_000);

  it('a fresh founder launch over pre-split rows rejects and tears the runtime down', async () => {
    const f = await fixture();
    manager = new StrandInstanceManager();
    const joined = await manager.startStrand(launchConfig(f, false));
    await seatPreSplitFounding(joined.database!.getDatabase(), f);
    await manager.stopStrand(f.strandRow.Id);

    // Rejecting at all proves the relaunch hydrated the rows: an empty strand would found.
    await expect(manager.startStrand(launchConfig(f, true))).rejects.toThrow(PreSplitStrandIdentityError);
    expect(manager.hasStrand(f.strandRow.Id)).toBe(false);
  }, 60_000);

  it('a quiesced instance founded in place fails its rebuild cleanly, and resumes as a joiner once withdrawn', async () => {
    const f = await fixture();
    manager = new StrandInstanceManager();
    const joined = await manager.startStrand(launchConfig(f, false));
    await seatPreSplitFounding(joined.database!.getDatabase(), f);
    await manager.quiesceStrand(f.strandRow.Id);

    expect(await manager.foundExistingStrand(f.strandRow.Id, async () => f.partyMemberPrivateKey)).toBe('needs-resume');
    // The wake CadreNode would run: the founding rebuild is refused and rolled back —
    // the instance stays tracked but holds no half-built runtime.
    await expect(manager.resumeStrand(f.strandRow.Id)).rejects.toThrow(PreSplitStrandIdentityError);
    const instance = manager.getInstance(f.strandRow.Id)!;
    expect(instance.status).toBe('error');
    expect(instance.database).toBeUndefined();
    expect(instance.libp2pNode).toBeUndefined();

    // CadreNode withdraws the flip on that failure; the instance then rebuilds as the joiner it was.
    manager.withdrawFounderRequest(f.strandRow.Id);
    await manager.resumeStrand(f.strandRow.Id);
    expect(manager.getInstance(f.strandRow.Id)?.database).toBeDefined();
  }, 60_000);

  it('a correctly founded strand re-bootstraps cleanly', async () => {
    const f = await fixture();
    manager = new StrandInstanceManager();
    const instance = await manager.startStrand(launchConfig(f, true));
    const db = instance.database!.getDatabase();
    expect(await managerKeys(db)).toEqual([f.partyKeyPair.publicKeyB64]);

    await expect(manager.ensureFounderBootstrap(f.strandRow.Id)).resolves.toBeUndefined();
    expect(await managerKeys(db)).toEqual([f.partyKeyPair.publicKeyB64]);
  }, 60_000);

  it('a founder who handed management to a successor and resigned still re-bootstraps (no false positive)', async () => {
    const f = await fixture();
    manager = new StrandInstanceManager();
    const instance = await manager.startStrand(launchConfig(f, true));
    const db = instance.database!.getDatabase();
    const successor = strandMemberKeyPair(await generateStrandMemberKey());
    await addMemberByManager(db, { managerKeyPair: f.partyKeyPair, memberKey: successor.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: f.partyKeyPair, newManagerKey: successor.publicKeyB64 });
    await removeManager(db, { byManagerKeyPair: f.partyKeyPair, targetManagerKey: f.partyKeyPair.publicKeyB64 });
    expect(await managerKeys(db)).toEqual([successor.publicKeyB64]);

    // The manager set no longer holds the party key, but it never held the shared-derived
    // one either — so this is not the pre-split fingerprint.
    await expect(manager.ensureFounderBootstrap(f.strandRow.Id)).resolves.toBeUndefined();
    expect(await managerKeys(db)).toEqual([successor.publicKeyB64]);
  }, 60_000);
});
