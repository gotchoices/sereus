import { describe, it, expect, afterEach } from 'vitest';
import { generatePrivateKey, getPublicKey, sign as cryptoSign } from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import type { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { signSchema } from '../src/schema-verification.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import { newUnstartedNode, startSelfOwnerNode } from './self-owner-node-helpers.js';

/**
 * Exercises {@link CadreNode.publishStrand} — the node-level method the RN chat
 * demo calls (in `createChatStrand`) to make a newly-created strand discoverable
 * cadre-wide, the owner-signed `Strand` INSERT that `addStrand` deliberately
 * omits.
 *
 * The DB-level `insertStrand` happy path is covered by
 * `control-authorization-binding.spec.ts`; this pins the node wrapper end-to-end:
 * it self-signs with the node's own owner key (the `getSelfSigningKey` path)
 * and lands a real `Strand` row. Mirrors `publish-formation-invite.spec.ts`.
 *
 * Boots a self-signing node the way `seed-bootstrap.spec.ts` does: the node's
 * libp2p key IS its owner key (`ed25519KeyPairFromLibp2p`), enrolled in
 * `OwnerKey` so its self-signed control writes are authorised.
 */
describe('CadreNode.publishStrand (node-level discoverable-strand publish)', () => {
  let node: CadreNode | undefined;

  const rand = (): string => Math.random().toString(36).slice(2);

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('happy path: lands a Strand row queryable from the control DB', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-' + rand();

    await node.publishStrand(strandId, 'o');

    const row = await db.getDatabase().get(
      'select Id, Type from CadreControl.Strand where Id = ?',
      [strandId],
    );
    expect(row?.Id).toBe(strandId);
    expect(row?.Type).toBe('o');

    // And queryStrands (what the StrandWatcher reads) surfaces it too.
    const strands = await db.queryStrands();
    expect(strands.some((s) => s.Id === strandId && s.Type === 'o')).toBe(true);
  }, 60_000);

  it('closed strand: persists the member key so an invitee can later attach', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-c-' + rand();
    const memberKey = 'member-key-' + rand();

    await node.publishStrand(strandId, 'c', memberKey);

    const stored = await db.queryStrand(strandId);
    expect(stored?.Type).toBe('c');
    expect(stored?.MemberPrivateKey).toBe(memberKey);
  }, 60_000);

  it('closed strand: mints a StrandPartyKey row DISTINCT from the shared member key, stable on repeat', async () => {
    // The identity split (gotchoices/sereus#4): the party's own membership identity
    // must not be derivable from the strand-wide MemberPrivateKey every joiner holds.
    ({ node } = await startSelfOwnerNode('publish-strand-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-pk-' + rand();
    const memberKey = await generateStrandMemberKey();

    await node.publishStrand(strandId, 'c', memberKey);

    const partyKey = await db.queryStrandPartyKey(strandId);
    expect(partyKey).not.toBeNull();
    expect(partyKey).not.toBe(memberKey);
    expect(strandMemberKeyPair(partyKey!).publicKeyB64)
      .not.toBe(strandMemberKeyPair(memberKey).publicKeyB64);

    // Repeat publish keeps the SAME identity — a founding key that rotated per publish
    // would break every insert-if-absent bootstrap guard.
    await node.publishStrand(strandId, 'c', memberKey);
    expect(await db.queryStrandPartyKey(strandId)).toBe(partyKey);
  }, 60_000);

  it('open strand: mints NO StrandPartyKey row', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-o-' + rand();

    await node.publishStrand(strandId, 'o');

    expect(await db.queryStrandPartyKey(strandId)).toBeNull();
  }, 60_000);

  it('rejects when the node is not an enrolled owner (constraint propagates)', async () => {
    // Self-signing key is present (past the "no signing key" guard), but it is
    // not enrolled in OwnerKey, so the Strand.AuthorizedInsert gate rejects the
    // insert and the rejection must surface (no silent local-only strand).
    ({ node } = await startSelfOwnerNode('publish-strand-', { enrollOwner: false }));
    const db = node.getControlDatabase()!;
    const before = await db.getDatabase().get('select count(1) as c from CadreControl.Strand');

    await expect(node.publishStrand('strand-' + rand(), 'o')).rejects.toThrow();

    const after = await db.getDatabase().get('select count(1) as c from CadreControl.Strand');
    expect(Number(after?.c ?? 0)).toBe(Number(before?.c ?? 0));
  }, 60_000);

  it('throws if the node has not been started', async () => {
    const { node: stopped } = await newUnstartedNode('publish-strand-stopped-');
    await expect(stopped.publishStrand('strand-' + rand(), 'o')).rejects.toThrow(/must be started/i);
  });

  it('rejects an empty or whitespace-only id before any write', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;

    for (const blank of ['', '   ', '\t\n']) {
      await expect(node.publishStrand(blank, 'o')).rejects.toThrow(/required/i);
    }

    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);

  it('trims the id it stores, so unpublishStrand can round-trip the same string', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-pad-' + rand();

    await node.publishStrand(`  ${strandId}  `, 'o');

    expect((await db.queryStrands()).map((s) => s.Id)).toEqual([strandId]);

    await node.unpublishStrand(`  ${strandId}  `);

    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);
});

// ── publishStrand idempotency (founding is resumable) ────────────────────────
//
// Founding a strand is TWO writes — publishStrand then addStrand(founder) — and an app
// killed between them used to be stuck forever: every later attempt died on the half that
// had already succeeded (`UNIQUE constraint failed: Strand.Id`), with no way to tell "I
// already did this" from "this is a genuine conflict". These pin both readings.

/**
 * Make the NEXT `queryStrand(strandId)` on this database report the row as absent, then
 * restore the real read.
 *
 * Simulates the concurrent-founding race — two machines of one party founding the same id,
 * where the read-then-insert pair is not atomic — from a single node: publishStrand's
 * pre-read misses the row, so its insert genuinely collides against the live engine and the
 * catch/re-read branch runs. That also pins `isStrandIdConflict` against the REAL rejection
 * text, which is the one thing a reworded storage-layer error would silently break.
 *
 * @returns A probe reporting whether the blinded read actually fired. Assert it: without
 *   the blinding the pre-read short-circuit handles the repeat and a no-op assertion goes
 *   green having never reached the race branch at all.
 */
function blindOneStrandRead(db: ControlDatabase, strandId: string): () => boolean {
  const realQueryStrand = db.queryStrand.bind(db);
  let blinded = false;
  db.queryStrand = async (id: string) => {
    if (id === strandId) {
      db.queryStrand = realQueryStrand;
      blinded = true;
      return null;
    }
    return await realQueryStrand(id);
  };
  return () => blinded;
}

describe('CadreNode.publishStrand (repeat publish / founding resume)', () => {
  let node: CadreNode | undefined;
  let ownerKey: { publicKeyB64: string } | undefined;

  const rand = (): string => Math.random().toString(36).slice(2);

  afterEach(async () => {
    await node?.stop();
    node = undefined;
    ownerKey = undefined;
  });

  it('returns the row it published, so a caller can carry the resolved content forward', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('publish-strand-repeat-', { enrollOwner: true }));
    const strandId = 'strand-' + rand();

    // FounderOwnerKey records THIS machine (its owner key) as the row's publisher —
    // the durable representation founder derivation reads.
    expect(await node.publishStrand(strandId, 'o')).toEqual({
      Id: strandId,
      Type: 'o',
      MemberPrivateKey: null,
      FounderOwnerKey: ownerKey.publicKeyB64,
    });
  }, 60_000);

  it('repeat publish of identical OPEN content is a no-op and leaves exactly one row', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('publish-strand-repeat-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-' + rand();

    await node.publishStrand(strandId, 'o');
    const second = await node.publishStrand(strandId, 'o');

    expect(second).toEqual({
      Id: strandId, Type: 'o', MemberPrivateKey: null, FounderOwnerKey: ownerKey.publicKeyB64,
    });
    expect((await db.queryStrands()).filter((s) => s.Id === strandId)).toHaveLength(1);
  }, 60_000);

  it('repeat publish of identical CLOSED content is a no-op and keeps the stored key', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('publish-strand-repeat-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-c-' + rand();
    const memberKey = 'member-key-' + rand();

    await node.publishStrand(strandId, 'c', memberKey);
    const second = await node.publishStrand(strandId, 'c', memberKey);

    expect(second).toEqual({
      Id: strandId, Type: 'c', MemberPrivateKey: memberKey, FounderOwnerKey: ownerKey.publicKeyB64,
    });
    expect((await db.queryStrands()).filter((s) => s.Id === strandId)).toHaveLength(1);
    expect((await db.queryStrand(strandId))?.MemberPrivateKey).toBe(memberKey);
  }, 60_000);

  it('repeat publish with a DIFFERENT Type throws naming the mismatch and leaves the row intact', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('publish-strand-repeat-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-' + rand();

    await node.publishStrand(strandId, 'o');

    // Accepting this would let a retry close a strand the party published as open.
    await expect(node.publishStrand(strandId, 'c')).rejects.toThrow(
      /Type is 'o', not the requested 'c'/,
    );
    expect(await db.queryStrand(strandId)).toEqual({
      Id: strandId, Type: 'o', MemberPrivateKey: null, FounderOwnerKey: ownerKey.publicKeyB64,
    });
  }, 60_000);

  it('repeat publish with a DIFFERENT memberPrivateKey throws and keeps the stored key', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-repeat-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-c-' + rand();
    const stored = 'member-key-' + rand();

    await node.publishStrand(strandId, 'c', stored);

    // Accepting this would swap the key gating the strand's reads out from under the
    // membership already seated in it.
    await expect(node.publishStrand(strandId, 'c', 'member-key-' + rand())).rejects.toThrow(
      /MemberPrivateKey differs from the one supplied/,
    );
    expect((await db.queryStrand(strandId))?.MemberPrivateKey).toBe(stored);
  }, 60_000);

  it('the mismatch error never leaks the stored MemberPrivateKey', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-repeat-', { enrollOwner: true }));
    const strandId = 'strand-c-' + rand();
    const stored = 'secret-member-key-' + rand();

    await node.publishStrand(strandId, 'c', stored);
    const rejection = await node.publishStrand(strandId, 'c', 'other-' + rand()).catch(
      (error: unknown) => String(error),
    );

    expect(rejection).not.toContain(stored);
  }, 60_000);

  it('unpublish then republish still re-seats the strand (the no-op branch cannot resurrect it)', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-repeat-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-' + rand();

    await node.publishStrand(strandId, 'o');
    await node.unpublishStrand(strandId);
    expect(await db.queryStrand(strandId)).toBeNull();

    // Row absent → the ordinary publish path runs, exactly as unpublishStrand documents.
    await node.publishStrand(strandId, 'o');
    expect((await db.queryStrands()).filter((s) => s.Id === strandId)).toHaveLength(1);
  }, 60_000);

  it('losing a concurrent founding race on identical content re-reads and no-ops', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('publish-strand-race-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-race-' + rand();

    await node.publishStrand(strandId, 'o');
    const blinded = blindOneStrandRead(db, strandId);

    // The insert really collides here — this is the catch/re-read branch, not the
    // pre-read short-circuit.
    expect(await node.publishStrand(strandId, 'o')).toEqual({
      Id: strandId,
      Type: 'o',
      MemberPrivateKey: null,
      FounderOwnerKey: ownerKey.publicKeyB64,
    });
    expect(blinded()).toBe(true);
    expect((await db.queryStrands()).filter((s) => s.Id === strandId)).toHaveLength(1);
  }, 60_000);

  it('losing that race onto DIFFERENT content throws the mismatch, not the raw uniqueness error', async () => {
    ({ node } = await startSelfOwnerNode('publish-strand-race-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'strand-race-' + rand();
    const stored = 'member-key-' + rand();

    await node.publishStrand(strandId, 'c', stored);
    const blinded = blindOneStrandRead(db, strandId);

    await expect(node.publishStrand(strandId, 'c', 'member-key-' + rand())).rejects.toThrow(
      /landed concurrently from another founder with DIFFERENT content/,
    );
    expect(blinded()).toBe(true);
    expect((await db.queryStrand(strandId))?.MemberPrivateKey).toBe(stored);
  }, 60_000);
});

// ── CadreNode.addStrand founder bootstrap (node-level seam) ──────────────────

const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

function signedSApp() {
  const priv = generatePrivateKey('ed25519', 'base64url') as string;
  const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
  return { id: pub, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, priv) };
}

async function countRow(db: Database, table: 'Header' | 'Member' | 'Manager'): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

describe('CadreNode.addStrand founder bootstrap (node-level seam)', () => {
  let node: CadreNode | undefined;

  const rand2 = (): string => Math.random().toString(36).slice(2);

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('founder of a closed strand: Header=1, Member=1, Manager=1 keyed by the PARTY key', async () => {
    ({ node } = await startSelfOwnerNode('addstrand-founder-', { enrollOwner: true }));
    const strandId = 'addstrand-closed-' + rand2();
    const memberPrivateKey = await generateStrandMemberKey();
    const partyMemberPrivateKey = await generateStrandMemberKey();

    // A hand-built row (null FounderOwnerKey) carries no provenance to heal a party
    // key against, so the explicit founder supplies its identity explicitly — the
    // shape the integration harness uses.
    const instance = await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: memberPrivateKey, Type: 'c', FounderOwnerKey: null },
      sAppConfig: signedSApp(),
      founder: true,
      partyMemberPrivateKey,
    });

    expect(instance.status).toBe('active');
    const db = instance.database!.getDatabase();
    expect(await countRow(db, 'Header')).toBe(1);
    expect(await countRow(db, 'Member')).toBe(1);
    expect(await countRow(db, 'Manager')).toBe(1);

    const expectedKey = strandMemberKeyPair(partyMemberPrivateKey).publicKeyB64;
    const member = await db.get('select Key from Strand.Member');
    const manager = await db.get('select MemberKey from Strand.Manager');
    expect(member?.Key).toBe(expectedKey);
    expect(manager?.MemberKey).toBe(expectedKey);
    // The shared read key must not be the identity source any more.
    expect(member?.Key).not.toBe(strandMemberKeyPair(memberPrivateKey).publicKeyB64);
  }, 60_000);

  it('founder of an open strand: Header=1, Member=0, Manager=0, Header.Type=o', async () => {
    ({ node } = await startSelfOwnerNode('addstrand-founder-', { enrollOwner: true }));
    const strandId = 'addstrand-open-' + rand2();

    const instance = await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
      sAppConfig: signedSApp(),
      founder: true,
    });

    expect(instance.status).toBe('active');
    const db = instance.database!.getDatabase();
    expect(await countRow(db, 'Header')).toBe(1);
    expect(await countRow(db, 'Member')).toBe(0);
    expect(await countRow(db, 'Manager')).toBe(0);

    const header = await db.get('select Type from Strand.Header');
    expect(header?.Type).toBe('o');
  }, 60_000);

  it('closed founder with no party key rejects (the shared MemberPrivateKey is no substitute)', async () => {
    ({ node } = await startSelfOwnerNode('addstrand-founder-', { enrollOwner: true }));
    const strandId = 'addstrand-closed-nokey-' + rand2();

    // Null FounderOwnerKey → no heal (this machine has no provenance claim on the
    // row), no explicit partyMemberPrivateKey, no StrandPartyKey row: the founder
    // bootstrap must throw rather than fall back to the shared member key.
    await expect(
      node.addStrand({
        strandRow: { Id: strandId, MemberPrivateKey: await generateStrandMemberKey(), Type: 'c', FounderOwnerKey: null },
        sAppConfig: signedSApp(),
        founder: true,
      }),
    ).rejects.toThrow(/StrandPartyKey/i);
  }, 60_000);
});

// ── CadreNode.foundStrand (the resumable one-call founding path) ─────────────
//
// The single entry point callers should use to create a strand: publish the control row AND
// attach as founder. Hand-rolling the pair left two failure modes when an app died between
// the writes — a bricked strand id (the publish half already landed) and a HEADERLESS strand
// (the app resumed by attaching as a joiner, so the founder bootstrap never ran and
// `Strand.Header` stayed empty). Both are pinned here.

describe('CadreNode.foundStrand (publish + found in one resumable call)', () => {
  let node: CadreNode | undefined;
  let ownerKey: { publicKeyB64: string } | undefined;

  const rand3 = (): string => Math.random().toString(36).slice(2);

  afterEach(async () => {
    await node?.stop();
    node = undefined;
    ownerKey = undefined;
  });

  it('open strand: publishes the row and seats the Header in one call', async () => {
    ({ node, ownerKey } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const controlDb = node.getControlDatabase()!;
    const strandId = 'found-open-' + rand3();

    const { instance, strandRow, founded } = await node.foundStrand({
      strandId,
      type: 'o',
      sAppConfig: signedSApp(),
    });

    expect(instance.status).toBe('active');
    expect(founded).toBe(true);
    expect(strandRow).toEqual({
      Id: strandId, Type: 'o', MemberPrivateKey: null, FounderOwnerKey: ownerKey.publicKeyB64,
    });
    expect(await controlDb.queryStrand(strandId)).toEqual(strandRow);
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(1);
  }, 60_000);

  it('founding twice leaves one control row and one Header', async () => {
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const controlDb = node.getControlDatabase()!;
    const strandId = 'found-twice-' + rand3();
    const sAppConfig = signedSApp();

    await node.foundStrand({ strandId, type: 'o', sAppConfig });
    // Detach locally, as an app restart would, so the second call really re-founds
    // rather than returning the already-tracked instance.
    await node.stopStrand(strandId);

    const { instance } = await node.foundStrand({ strandId, type: 'o', sAppConfig });

    expect(instance.status).toBe('active');
    expect((await controlDb.queryStrands()).filter((s) => s.Id === strandId)).toHaveLength(1);
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(1);
  }, 60_000);

  it('resumes an interrupted founding: a published-but-never-founded strand gets its Header', async () => {
    // The exact interruption from the field: publishStrand committed, then the app died
    // before addStrand. Re-founding must NOT die on the publish half, and must found rather
    // than merely attach — attaching leaves the strand active with an empty Header, so its
    // sApp provenance is never recorded.
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const strandId = 'found-resume-' + rand3();

    await node.publishStrand(strandId, 'o');

    const { instance } = await node.foundStrand({
      strandId,
      type: 'o',
      sAppConfig: signedSApp(),
    });

    expect(instance.status).toBe('active');
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(1);
  }, 60_000);

  it('closed strand: founds under the publish-minted PARTY key and seats Header/Member/Manager', async () => {
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const controlDb = node.getControlDatabase()!;
    const strandId = 'found-closed-' + rand3();
    const memberPrivateKey = await generateStrandMemberKey();

    const { instance, strandRow } = await node.foundStrand({
      strandId,
      type: 'c',
      memberPrivateKey,
      sAppConfig: signedSApp(),
    });

    expect(strandRow.MemberPrivateKey).toBe(memberPrivateKey);
    const db = instance.database!.getDatabase();
    expect(await countRow(db, 'Header')).toBe(1);
    expect(await countRow(db, 'Member')).toBe(1);
    expect(await countRow(db, 'Manager')).toBe(1);

    // The founding identity is the publish-minted party key, never the shared secret.
    const partyKey = await controlDb.queryStrandPartyKey(strandId);
    expect(partyKey).not.toBeNull();
    const member = await db.get('select Key from Strand.Member');
    expect(member?.Key).toBe(strandMemberKeyPair(partyKey!).publicKeyB64);
    expect(member?.Key).not.toBe(strandMemberKeyPair(memberPrivateKey).publicKeyB64);
  }, 60_000);

  it('closed strand resume: adopts the STORED member key and discards the freshly minted one', async () => {
    // The reference apps mint a key per attempt. On a resume the stored key is the one the
    // seated membership was derived from, so a fresh key must lose — otherwise the strand
    // runs (and mints invitations) under a key that cannot read it.
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const controlDb = node.getControlDatabase()!;
    const strandId = 'found-closed-resume-' + rand3();
    const stored = await generateStrandMemberKey();
    const minted = await generateStrandMemberKey();
    expect(minted).not.toBe(stored);

    await node.publishStrand(strandId, 'c', stored);
    const partyKey = await controlDb.queryStrandPartyKey(strandId);
    expect(partyKey).not.toBeNull();

    const { instance, strandRow } = await node.foundStrand({
      strandId,
      type: 'c',
      memberPrivateKey: minted,
      sAppConfig: signedSApp(),
    });

    expect(strandRow.MemberPrivateKey).toBe(stored);
    // The resume founds under the SAME party identity the publish minted — a fresh
    // identity per resume would orphan the membership already seated.
    expect(await controlDb.queryStrandPartyKey(strandId)).toBe(partyKey);
    const db = instance.database!.getDatabase();
    const member = await db.get('select Key from Strand.Member');
    expect(member?.Key).toBe(strandMemberKeyPair(partyKey!).publicKeyB64);
  }, 60_000);

  it('refuses to found a published strand as the other Type', async () => {
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const strandId = 'found-type-clash-' + rand3();

    await node.publishStrand(strandId, 'o');

    await expect(
      node.foundStrand({
        strandId,
        type: 'c',
        memberPrivateKey: await generateStrandMemberKey(),
        sAppConfig: signedSApp(),
      }),
    ).rejects.toThrow(/already published as type 'o'/);
  }, 60_000);

  it('rejects an empty or whitespace-only id before any write', async () => {
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const controlDb = node.getControlDatabase()!;

    await expect(
      node.foundStrand({ strandId: '   ', type: 'o', sAppConfig: signedSApp() }),
    ).rejects.toThrow(/required/i);
    expect(await controlDb.queryStrands()).toEqual([]);
  }, 60_000);

  it('throws if the node has not been started', async () => {
    const { node: stopped } = await newUnstartedNode('found-strand-stopped-');
    await expect(
      stopped.foundStrand({ strandId: 'found-' + rand3(), type: 'o', sAppConfig: signedSApp() }),
    ).rejects.toThrow(/must be started/i);
  });

  // Guards the FIX for what used to be a known gap: `launchStrand` used to return an
  // already-tracked instance and silently drop the `founder` flag, so whoever launched
  // the strand first decided whether the bootstrap ran. Now a founder request against a
  // tracked instance runs the (idempotent) bootstrap in place
  // (`StrandInstanceManager.foundExistingStrand`), so founding after an attach still
  // seats the `Strand.Header`. The attach below hand-builds a row with a null
  // `FounderOwnerKey` — the shape of a joiner-side constructed row — which is what makes
  // the first launch a genuine joiner launch rather than a derived founding.
  it('founding a strand already ATTACHED as a joiner runs the bootstrap on the tracked instance', async () => {
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const strandId = 'found-attached-' + rand3();
    const sAppConfig = signedSApp();

    await node.publishStrand(strandId, 'o');
    // An app attaching from a hand-built row (no founder knowledge): launches as a joiner.
    await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
      sAppConfig,
    });

    const { instance, founded } = await node.foundStrand({ strandId, type: 'o', sAppConfig });

    expect(instance.status).toBe('active');
    expect(founded).toBe(true);
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(1);
  }, 60_000);

  it('closed strand attached first as a joiner: a later founding seats Header/Member/Manager', async () => {
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const strandId = 'found-attached-closed-' + rand3();
    const sAppConfig = signedSApp();
    const memberPrivateKey = await generateStrandMemberKey();

    await node.publishStrand(strandId, 'c', memberPrivateKey);
    // The joiner-shaped attach (id + key from an invitation, no founder knowledge).
    await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: memberPrivateKey, Type: 'c', FounderOwnerKey: null },
      sAppConfig,
    });

    const { instance, founded } = await node.foundStrand({
      strandId, type: 'c', memberPrivateKey, sAppConfig,
    });

    expect(founded).toBe(true);
    const db = instance.database!.getDatabase();
    expect(await countRow(db, 'Header')).toBe(1);
    expect(await countRow(db, 'Member')).toBe(1);
    expect(await countRow(db, 'Manager')).toBe(1);
    // The flip founds under the PUBLISH-minted party key that the joiner launch already
    // resolved — not the shared read secret, and not a second freshly minted identity.
    const partyKey = await node.getControlDatabase()!.queryStrandPartyKey(strandId);
    expect(partyKey).not.toBeNull();
    const member = await db.get('select Key from Strand.Member');
    expect(member?.Key).toBe(strandMemberKeyPair(partyKey!).publicKeyB64);
    expect(member?.Key).not.toBe(strandMemberKeyPair(memberPrivateKey).publicKeyB64);
  }, 60_000);

  it('foundStrand adopting a row published by a DIFFERENT machine attaches instead of founding', async () => {
    ({ node } = await startSelfOwnerNode('found-strand-', { enrollOwner: true }));
    const controlDb = node.getControlDatabase()!;
    const strandId = 'found-foreign-' + rand3();

    // Simulate a sibling machine having won the founding race: hand foundStrand's
    // pre-read a row carrying ANOTHER machine's owner key. (Seating such a row for
    // real needs a second enrolled owner; the read stub isolates the derivation.)
    const realQueryStrand = controlDb.queryStrand.bind(controlDb);
    controlDb.queryStrand = async (id: string) => id === strandId
      ? { Id: strandId, Type: 'o' as const, MemberPrivateKey: null, FounderOwnerKey: 'sibling-owner-key-' + rand3() }
      : await realQueryStrand(id);

    const { instance, founded } = await node.foundStrand({
      strandId, type: 'o', sAppConfig: signedSApp(),
    });

    // Attached, did not bootstrap: two machines founding one strand on separate
    // replicas is the double-Header hazard the derivation exists to prevent.
    expect(instance.status).toBe('active');
    expect(founded).toBe(false);
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(0);
  }, 60_000);
});

// ── founder derivation from the row (no explicit flag anywhere) ──────────────
//
// The representation fix: `Strand.FounderOwnerKey` records the publishing machine, so a
// plain `addStrand` — the reference RN app's restart-orphan shape, and the same code path
// the node's own `StrandWatcher` takes via `handleStrandAdded` — founds this machine's own
// strands and joins everyone else's, with no caller passing any flag.

describe('CadreNode.addStrand founder derivation from Strand.FounderOwnerKey', () => {
  let node: CadreNode | undefined;

  const rand4 = (): string => Math.random().toString(36).slice(2);

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('plain addStrand (no flag) on a row this node published founds it (Header written)', async () => {
    ({ node } = await startSelfOwnerNode('derive-founder-', { enrollOwner: true }));
    const controlDb = node.getControlDatabase()!;
    const strandId = 'derive-own-' + rand4();

    const published = await node.publishStrand(strandId, 'o');
    // Read the row back the way a discovery handler would — it carries our owner key.
    const row = await controlDb.queryStrand(strandId);
    expect(row).toEqual(published);

    const instance = await node.addStrand({ strandRow: row!, sAppConfig: signedSApp() });

    expect(instance.status).toBe('active');
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(1);
  }, 60_000);

  it('plain addStrand on a row carrying ANOTHER machine\'s key stays a joiner (no Header)', async () => {
    ({ node } = await startSelfOwnerNode('derive-founder-', { enrollOwner: true }));
    const strandId = 'derive-foreign-' + rand4();

    const instance = await node.addStrand({
      strandRow: {
        Id: strandId, MemberPrivateKey: null, Type: 'o',
        FounderOwnerKey: 'some-other-machine-owner-key-' + rand4(),
      },
      sAppConfig: signedSApp(),
    });

    expect(instance.status).toBe('active');
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(0);
  }, 60_000);

  it('a null FounderOwnerKey (consent-seated shape) stays a joiner without an explicit flag', async () => {
    ({ node } = await startSelfOwnerNode('derive-founder-', { enrollOwner: true }));
    const strandId = 'derive-null-' + rand4();

    const instance = await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
      sAppConfig: signedSApp(),
    });

    expect(instance.status).toBe('active');
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(0);
  }, 60_000);
});

// ── StrandPartyKey heal at launch (strands published before the key split) ───
//
// A closed strand published straight through ControlDatabase.insertStrand — the shape
// every strand published BEFORE the identity/read-secret split has — carries no
// StrandPartyKey row. The FOUNDING machine (row's FounderOwnerKey is its own owner key)
// heals at launch: mint once, stable thereafter. Everyone else never mints.

describe('CadreNode.addStrand party-key heal at launch', () => {
  let node: CadreNode | undefined;

  const rand5 = (): string => Math.random().toString(36).slice(2);

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  /** Seat a closed Strand row via the DB writer alone — no publish-time party-key mint. */
  async function seedPreSplitClosedStrand(
    db: ControlDatabase,
    ownerKey: { privateKeyB64: string; publicKeyB64: string },
    strandId: string,
  ): Promise<void> {
    const signAsOwner = (message: Uint8Array): string =>
      cryptoSign(message, ownerKey.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
    await db.insertStrand(strandId, 'c', ownerKey.publicKeyB64, signAsOwner, await generateStrandMemberKey());
  }

  it('the founding machine heals a keyless closed strand: mints once, stable across relaunch', async () => {
    let ownerKey: { privateKeyB64: string; publicKeyB64: string };
    ({ node, ownerKey } = await startSelfOwnerNode('party-key-heal-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'heal-closed-' + rand5();
    const sAppConfig = signedSApp();

    await seedPreSplitClosedStrand(db, ownerKey, strandId);
    expect(await db.queryStrandPartyKey(strandId)).toBeNull();

    const row = await db.queryStrand(strandId);
    const first = await node.addStrand({ strandRow: row!, sAppConfig });
    expect(first.status).toBe('active');

    const healed = await db.queryStrandPartyKey(strandId);
    expect(healed).not.toBeNull();
    const member = await first.database!.getDatabase().get('select Key from Strand.Member');
    expect(member?.Key).toBe(strandMemberKeyPair(healed!).publicKeyB64);

    // Relaunch finds the row and reuses it — the founding Member.Key must be stable
    // across restarts or the bootstrap's insert-if-absent guards stop matching.
    await node.stopStrand(strandId);
    const second = await node.addStrand({ strandRow: row!, sAppConfig });
    expect(second.status).toBe('active');
    expect(await db.queryStrandPartyKey(strandId)).toBe(healed);
    const memberAfter = await second.database!.getDatabase().get('select Key from Strand.Member');
    expect(memberAfter?.Key).toBe(strandMemberKeyPair(healed!).publicKeyB64);
  }, 60_000);

  it('a non-founder launch never mints a party key', async () => {
    ({ node } = await startSelfOwnerNode('party-key-heal-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'heal-foreign-' + rand5();

    // A closed row published by a DIFFERENT machine (foreign owner key): this node
    // attaches as a joiner and must leave the party-key table alone — minting here
    // would be the mint race between a party's machines the heal is scoped to avoid.
    const instance = await node.addStrand({
      strandRow: {
        Id: strandId, MemberPrivateKey: await generateStrandMemberKey(), Type: 'c',
        FounderOwnerKey: 'foreign-owner-key-' + rand5(),
      },
      sAppConfig: signedSApp(),
    });

    expect(instance.status).toBe('active');
    expect(await countRow(instance.database!.getDatabase(), 'Header')).toBe(0);
    expect(await db.queryStrandPartyKey(strandId)).toBeNull();
  }, 60_000);

  it('a closed strand flipped to founder with NO party key throws rather than seating a wrong identity', async () => {
    // The joiner→founder flip edge: the instance launched as a joiner (hand-built row,
    // null FounderOwnerKey) against a strand that was NEVER published, so neither the
    // launch nor the flip's re-read finds a StrandPartyKey row and no heal applies. The
    // founding must fail loudly — seating Member/Manager under the shared read secret is
    // exactly what the split removed.
    ({ node } = await startSelfOwnerNode('party-key-heal-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'flip-nokey-' + rand5();
    const sAppConfig = signedSApp();
    const strandRow = {
      Id: strandId, MemberPrivateKey: await generateStrandMemberKey(), Type: 'c' as const,
      FounderOwnerKey: null,
    };

    const joined = await node.addStrand({ strandRow, sAppConfig });
    expect(joined.status).toBe('active');
    expect(await countRow(joined.database!.getDatabase(), 'Member')).toBe(0);

    await expect(node.addStrand({ strandRow, sAppConfig, founder: true }))
      .rejects.toThrow(/StrandPartyKey/i);
    expect(await db.queryStrandPartyKey(strandId)).toBeNull();
  }, 60_000);
});

describe('CadreNode.ensureStrandPartyKey (public mint-or-adopt seam)', () => {
  let node: CadreNode | undefined;

  const rand6 = (): string => Math.random().toString(36).slice(2);

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('adopts the stored key on a repeat, and refuses a CONFLICTING supplied key', async () => {
    ({ node } = await startSelfOwnerNode('ensure-party-key-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const strandId = 'ensure-' + rand6();
    const mine = await generateStrandMemberKey();
    const other = await generateStrandMemberKey();

    expect(await node.ensureStrandPartyKey(strandId, mine)).toBe(mine);
    // Idempotent for the SAME key, and a bare call adopts what is stored.
    expect(await node.ensureStrandPartyKey(strandId, mine)).toBe(mine);
    expect(await node.ensureStrandPartyKey(strandId)).toBe(mine);

    // A party has ONE identity per strand: a silent swap would orphan the membership
    // already seated under the stored key, so rotation must be deliberate.
    await expect(node.ensureStrandPartyKey(strandId, other)).rejects.toThrow(/already has a party key/i);
    expect(await db.queryStrandPartyKey(strandId)).toBe(mine);
  }, 60_000);

  it('addStrand refuses a party key on an OPEN strand rather than dropping it silently', async () => {
    ({ node } = await startSelfOwnerNode('ensure-party-key-', { enrollOwner: true }));
    await expect(node.addStrand({
      strandRow: { Id: 'open-with-key-' + rand6(), MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
      sAppConfig: signedSApp(),
      partyMemberPrivateKey: await generateStrandMemberKey(),
    })).rejects.toThrow(/partyMemberPrivateKey belongs to a CLOSED strand/i);
  }, 60_000);
});
