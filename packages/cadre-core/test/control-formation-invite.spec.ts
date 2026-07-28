import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { ControlFormationUsageRecorder } from '../src/control-formation-recorder.js';

/**
 * Exercises the FormationInvite / FormationUsage consent path:
 *
 *  1. An owner-signed `FormationInvite` insert. The schema verifies the
 *     owner signature with `verify(digest(...), Sig, Key, 'ed25519')` over the
 *     row-bound field tuple. Before the Phase-1 curve fix the verify defaulted to
 *     secp256k1 and swallowed the curve-mismatch (returning false), so a real
 *     ed25519 owner signature was ALWAYS rejected — this happy-path insert
 *     therefore FAILS against the pre-fix schema and PASSES after it, pinning the
 *     bug.
 *  2. Redemption: inserting the `Strand` row + its `FormationUsage` row in ONE
 *     transaction so the mutually-circular deferred CHECKs (`Strand.Authorized`'s
 *     consent branch ↔ `FormationUsage.StrandExists`) both see both rows at
 *     commit. The strand carries NO owner signature — it is authorised purely
 *     by the FormationUsage branch of `Strand.Authorized`.
 *  3. Rejection of redemptions against a non-existent or expired invite.
 *
 * Boots a real CadreNode (empty bootstrap, transaction profile — no network
 * peers), the same harness the genesis / authorization-binding specs use.
 */
describe('control formation invite (consent path: FormationInvite + FormationUsage)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let ownerPrivateKey: string;
  let ownerPublicKey: string;

  // ed25519-sign the raw message bytes (no pre-hash), matching insertFormationInvite.
  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);

  async function inviteCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.FormationInvite');
    return Number(row?.c ?? 0);
  }
  async function strandCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.Strand');
    return Number(row?.c ?? 0);
  }
  async function usageCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.FormationUsage');
    return Number(row?.c ?? 0);
  }

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: {
        partyId: 'formation-invite-' + rand(),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();

    // Bootstrap founding owner (unsigned branch).
    expect(await db.ensureOwnerKey(ownerPublicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('happy path: an owner-signed FormationInvite inserts (pins the curve fix)', async () => {
    const before = await inviteCount();
    const token = 'invite-' + rand();

    await db.insertFormationInvite(token, 'sapp-test', ownerPublicKey, signMessage);

    expect(await inviteCount()).toBe(before + 1);
    const row = await rawDb.get(
      'select Token, sAppId from CadreControl.FormationInvite where Token = ?',
      [token],
    );
    expect(row?.Token).toBe(token);
    expect(row?.sAppId).toBe('sapp-test');
  });

  it('rejects a FormationInvite whose signature is from a non-owner key', async () => {
    const strangerKey = generatePrivateKey('ed25519', 'base64url') as string;
    const strangerPub = getPublicKey(strangerKey, 'ed25519', 'base64url', 'base64url') as string;
    const signStranger = (message: Uint8Array): string =>
      cryptoSign(message, strangerKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

    const before = await inviteCount();
    // Signed correctly, but `strangerPub` is not enrolled in OwnerKey, so the
    // `exists (select 1 from OwnerKey ...)` gate fails.
    await expect(
      db.insertFormationInvite('invite-' + rand(), 'sapp-x', strangerPub, signStranger),
    ).rejects.toThrow();
    expect(await inviteCount()).toBe(before);
  });

  it('redeems an invite by inserting Strand + FormationUsage atomically (consent branch, no owner sig)', async () => {
    const token = 'invite-' + rand();
    const strandId = 'strand-' + rand();
    // Far-future expiry so `FI.ExpiresAt > context.Now` holds.
    await db.insertFormationInvite(token, 'sapp-redeem', ownerPublicKey, signMessage, {
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await db.redeemInvitation({ token, strandId, type: 'o', disclosure: 'hello' });

    expect(await strandCount()).toBe(strandsBefore + 1);
    expect(await usageCount()).toBe(usageBefore + 1);

    // The strand exists purely via the FormationUsage branch — no owner sig
    // was supplied on its insert.
    const strand = await rawDb.get('select Id, Type from CadreControl.Strand where Id = ?', [strandId]);
    expect(strand?.Id).toBe(strandId);
    expect(strand?.Type).toBe('o');

    const usage = await rawDb.get(
      'select Token, UseNumber, StrandId from CadreControl.FormationUsage where StrandId = ?',
      [strandId],
    );
    expect(usage?.Token).toBe(token);
    expect(usage?.UseNumber).toBe(1);
    expect(usage?.StrandId).toBe(strandId);
  });

  it('rejects redemption against a non-existent token (nothing lands)', async () => {
    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await expect(
      db.redeemInvitation({ token: 'no-such-' + rand(), strandId: 'strand-' + rand() }),
    ).rejects.toThrow();

    expect(await strandCount()).toBe(strandsBefore);
    expect(await usageCount()).toBe(usageBefore);
  });

  it('rejects redemption against an expired invite (nothing lands)', async () => {
    const token = 'invite-expired-' + rand();
    const strandId = 'strand-' + rand();
    // Expiry far in the past: `FI.ExpiresAt > context.Now` is false.
    await db.insertFormationInvite(token, 'sapp-expired', ownerPublicKey, signMessage, {
      expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await expect(db.redeemInvitation({ token, strandId })).rejects.toThrow();

    expect(await strandCount()).toBe(strandsBefore);
    expect(await usageCount()).toBe(usageBefore);
  });

  it('admits redemption when the invite expires later on the same UTC day (same-day future expiry)', async () => {
    const token = 'invite-sameday-' + rand();
    const strandId = 'strand-sameday-' + rand();
    // base = noon UTC on a fixed date; expiry = one hour later (same calendar day).
    // Guards that a same-UTC-day future expiry is admitted: the deferred CHECK
    // compares `FI.ExpiresAt > context.Now` lexically, and both operands are the
    // engine `datetime()` form via canonicalDatetime, so the time-of-day decides.
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    await db.insertFormationInvite(token, 'sapp-sameday', ownerPublicKey, signMessage, {
      expiresAtMs: base + 3_600_000,
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await db.redeemInvitation({ token, strandId, nowMs: base });

    expect(await strandCount()).toBe(strandsBefore + 1);
    expect(await usageCount()).toBe(usageBefore + 1);
  }, 30_000);

  it('rejects redemption when the invite expired earlier on the same UTC day (same-day past expiry)', async () => {
    const token = 'invite-sameday-past-' + rand();
    const strandId = 'strand-sameday-past-' + rand();
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    // ExpiresAt one hour BEFORE nowMs — same calendar day but already past.
    await db.insertFormationInvite(token, 'sapp-sameday-past', ownerPublicKey, signMessage, {
      expiresAtMs: base - 3_600_000,
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await expect(db.redeemInvitation({ token, strandId, nowMs: base })).rejects.toThrow();

    expect(await strandCount()).toBe(strandsBefore);
    expect(await usageCount()).toBe(usageBefore);
  }, 30_000);

  it('rejects redemption at the exact expiry instant (> is strict, boundary is exclusive)', async () => {
    const token = 'invite-boundary-' + rand();
    const strandId = 'strand-boundary-' + rand();
    const base = Date.UTC(2031, 2, 4, 12, 0, 0);
    // nowMs == expiresAtMs: ExpiresAt > Now is false (strict inequality).
    await db.insertFormationInvite(token, 'sapp-boundary', ownerPublicKey, signMessage, {
      expiresAtMs: base,
    });

    const strandsBefore = await strandCount();
    const usageBefore = await usageCount();

    await expect(db.redeemInvitation({ token, strandId, nowMs: base })).rejects.toThrow();

    expect(await strandCount()).toBe(strandsBefore);
    expect(await usageCount()).toBe(usageBefore);
  }, 30_000);

  it('recordFormationUsage adds usage rows against a pre-existing (owner-signed) strand, monotonically', async () => {
    const token = 'invite-rec-' + rand();
    const strandId = 'strand-authsigned-' + rand();
    await db.insertFormationInvite(token, 'sapp-rec', ownerPublicKey, signMessage);
    // Strand created the normal way (owner signature), NOT via consent.
    await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);

    expect(await db.recordFormationUsage({ token, strandId })).toBe(1);
    expect(await db.recordFormationUsage({ token, strandId })).toBe(2);

    const row = await rawDb.get(
      'select count(1) as c from CadreControl.FormationUsage where Token = ?',
      [token],
    );
    expect(Number(row?.c)).toBe(2);
  });

  describe('MemberKeyClosedOnly constraint', () => {
    it('rejects an open strand with a non-null MemberPrivateKey', async () => {
      const before = await strandCount();
      await expect(
        db.insertStrand('strand-' + rand(), 'o', ownerPublicKey, signMessage, 'memkey-' + rand()),
      ).rejects.toThrow();
      expect(await strandCount()).toBe(before);
    });

    it('admits a closed strand with a MemberPrivateKey', async () => {
      const strandId = 'strand-closed-' + rand();
      const before = await strandCount();
      await db.insertStrand(strandId, 'c', ownerPublicKey, signMessage, 'memkey-' + rand());
      expect(await strandCount()).toBe(before + 1);
      const row = await rawDb.get('select Type from CadreControl.Strand where Id = ?', [strandId]);
      expect(row?.Type).toBe('c');
    });

    it('admits an open strand with a null MemberPrivateKey', async () => {
      const strandId = 'strand-open-' + rand();
      const before = await strandCount();
      await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
      expect(await strandCount()).toBe(before + 1);
      const row = await rawDb.get('select Type from CadreControl.Strand where Id = ?', [strandId]);
      expect(row?.Type).toBe('o');
    });
  });

  describe('ControlFormationUsageRecorder (DB-backed)', () => {
    it('isTokenValid: true for a known unexpired token, false for unknown or expired', async () => {
      const recorder = new ControlFormationUsageRecorder(db);

      const token = 'invite-rv-' + rand();
      await db.insertFormationInvite(token, 'sapp-rv', ownerPublicKey, signMessage, {
        expiresAtMs: Date.now() + 60_000,
      });
      const ok = await recorder.isTokenValid(token);
      expect(ok.valid).toBe(true);
      expect(ok.invitation?.sAppId).toBe('sapp-rv');

      expect((await recorder.isTokenValid('nope-' + rand())).valid).toBe(false);

      const expired = 'invite-rv-exp-' + rand();
      await db.insertFormationInvite(expired, 'sapp-rv', ownerPublicKey, signMessage, {
        expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
      });
      expect((await recorder.isTokenValid(expired)).valid).toBe(false);
    });

    it('isTokenUsed: respects TotalUses, and recordUsage records consent against a pre-existing strand', async () => {
      const recorder = new ControlFormationUsageRecorder(db);

      // provision-then-record: the host strand is minted owner-signed UP FRONT, so
      // recordUsage is record-only (no Strand insert). Single-use invite: not used until
      // its one consent row lands.
      const single = 'invite-single-' + rand();
      const singleStrand = 'strand-su-' + rand();
      await db.insertStrand(singleStrand, 'o', ownerPublicKey, signMessage);
      await db.insertFormationInvite(single, 'sapp-su', ownerPublicKey, signMessage, { totalUses: 1 });
      expect(await recorder.isTokenUsed(single)).toBe(false);
      await recorder.recordUsage(single, 'peer-x', singleStrand);
      expect(await recorder.isTokenUsed(single)).toBe(true);

      // Unlimited invite (null TotalUses): never "used up".
      const unlimited = 'invite-unl-' + rand();
      const unlimitedStrand = 'strand-unl-' + rand();
      await db.insertStrand(unlimitedStrand, 'o', ownerPublicKey, signMessage);
      await db.insertFormationInvite(unlimited, 'sapp-unl', ownerPublicKey, signMessage);
      await recorder.recordUsage(unlimited, 'peer-y', unlimitedStrand);
      expect(await recorder.isTokenUsed(unlimited)).toBe(false);
    });

    it('resolveStrand: classifies bound (present) / unbound / missing host strands', async () => {
      const recorder = new ControlFormationUsageRecorder(db);

      // Bound + present closed strand: the invite names the pre-existing host strand →
      // kind 'bound', carrying that strand id + its MemberPrivateKey.
      const hostStrand = 'strand-bound-' + rand();
      const hostMemberKey = 'memkey-' + rand();
      await db.insertStrand(hostStrand, 'c', ownerPublicKey, signMessage, hostMemberKey);
      const bound = 'invite-bound-' + rand();
      await db.insertFormationInvite(bound, 'sapp-bound', ownerPublicKey, signMessage, {
        strandId: hostStrand,
      });
      expect(await recorder.resolveStrand(bound)).toEqual({
        kind: 'bound',
        strandId: hostStrand,
        memberPrivateKey: hostMemberKey,
      });

      // Unbound invite (legacy/open path): no StrandId → kind 'unbound'.
      const unbound = 'invite-unbound-' + rand();
      await db.insertFormationInvite(unbound, 'sapp-unbound', ownerPublicKey, signMessage);
      expect(await recorder.resolveStrand(unbound)).toEqual({ kind: 'unbound' });

      // Unknown token: no binding to act on → unbound.
      expect(await recorder.resolveStrand('nope-' + rand())).toEqual({ kind: 'unbound' });

      // Bound but the named Strand row was NEVER inserted (unconverged host) → kind 'missing'.
      const missingStrand = 'strand-missing-' + rand();
      const boundMissing = 'invite-bound-missing-' + rand();
      await db.insertFormationInvite(boundMissing, 'sapp-bm', ownerPublicKey, signMessage, {
        strandId: missingStrand,
      });
      expect(await recorder.resolveStrand(boundMissing)).toEqual({
        kind: 'missing',
        strandId: missingStrand,
      });
    });

    it('hasOutstandingInvitation: delegates to the DB-wide redeemable scan', async () => {
      const recorder = new ControlFormationUsageRecorder(db);
      // This shared DB has carried unexpired, unlimited-use invites since the
      // first test, so the delegate must report the node as stranger-expecting.
      expect(await recorder.hasOutstandingInvitation()).toBe(true);
    });

    it('provisionAndRecord: mints an open strand + records one usage atomically (single-use)', async () => {
      const recorder = new ControlFormationUsageRecorder(db);

      // UNBOUND single-use invite → provisionAndRecord mints a fresh open strand and
      // records its one consent row in a single transaction.
      const token = 'invite-par-' + rand();
      await db.insertFormationInvite(token, 'sapp-par', ownerPublicKey, signMessage, {
        totalUses: 1,
        expiresAtMs: Date.now() + 60_000,
      });

      const out = await recorder.provisionAndRecord(token, 'peer-par', 'sapp-par');
      expect(out.strandId.length).toBeGreaterThan('strand-'.length);
      // An unbound responder-provisioned strand is open → no membership key.
      expect(out.memberPrivateKey).toBeNull();

      // The minted strand exists, is open, and exactly one usage row was recorded → single-use.
      const strand = await rawDb.get('select Id, Type from CadreControl.Strand where Id = ?', [out.strandId]);
      expect(strand?.Id).toBe(out.strandId);
      expect(strand?.Type).toBe('o');
      expect(await db.countFormationUsage(token)).toBe(1);
      expect(await recorder.isTokenUsed(token)).toBe(true);
    });
  });
});

/**
 * `ControlDatabase.hasOutstandingFormationInvite` — the durable half of the
 * control-network connection gate's "does this node expect a stranger?"
 * question. Boots its OWN node because the answer is DB-WIDE: the suite above
 * leaves unexpired unlimited-use invites behind, which would make every
 * negative case unprovable on a shared database.
 */
describe('ControlDatabase.hasOutstandingFormationInvite (DB-wide redeemable scan)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let ownerPrivateKey: string;
  let ownerPublicKey: string;

  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: { partyId: 'formation-outstanding-' + rand(), bootstrapNodes: [] },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    expect(await db.ensureOwnerKey(ownerPublicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  // The predicate is DB-wide, so every invite inserted here stays visible to the
  // later tests. Anchoring every expiry to a FIXED future instant and passing an
  // explicit `nowMs` keeps each case decidable regardless of the real clock (which
  // still has to be before T0 for `recordFormationUsage`'s deferred expiry CHECK).
  const T0 = Date.UTC(2031, 0, 1);
  const MINUTE = 60_000;
  const HOUR = 3600_000;

  it('is false with no invites at all', async () => {
    expect(await db.hasOutstandingFormationInvite(T0)).toBe(false);
  });

  it('is true for an unexpired, unconsumed invite and false from its expiry instant on', async () => {
    const token = 'invite-out-' + rand();
    await db.insertFormationInvite(token, 'sapp-out', ownerPublicKey, signMessage, {
      expiresAtMs: T0 + MINUTE,
    });

    expect(await db.hasOutstandingFormationInvite(T0)).toBe(true);
    // Same `expiresAtMs <= now` boundary the recorder's isTokenValid applies: at
    // the exact expiry instant the invite no longer holds the gate open, so a
    // token the formation handler rejects can never keep the gate disarmed.
    expect(await db.hasOutstandingFormationInvite(T0 + MINUTE)).toBe(false);
    expect(await db.hasOutstandingFormationInvite(T0 + MINUTE + 1)).toBe(false);
  });

  it('is false once a single-use invite has recorded its one usage', async () => {
    const token = 'invite-out-single-' + rand();
    const strandId = 'strand-out-single-' + rand();
    await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
    await db.insertFormationInvite(token, 'sapp-out-single', ownerPublicKey, signMessage, {
      totalUses: 1,
      expiresAtMs: T0 + HOUR,
    });

    // At T0 + 2min the previous test's invite is expired, so this one decides.
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * MINUTE)).toBe(true);
    await db.recordFormationUsage({ token, strandId });
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * MINUTE)).toBe(false);
  });

  it('finds a live invite past the expired and consumed ones in the scan', async () => {
    const stale = 'invite-out-stale-' + rand();
    await db.insertFormationInvite(stale, 'sapp-out-stale', ownerPublicKey, signMessage, {
      expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
    });
    const live = 'invite-out-live-' + rand();
    await db.insertFormationInvite(live, 'sapp-out-live', ownerPublicKey, signMessage, {
      expiresAtMs: T0 + 2 * HOUR,
      totalUses: 2,
    });

    // Live one wins over one expired-long-ago, one expired-recently, one consumed.
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * MINUTE)).toBe(true);
    // …and once IT expires too, the whole set is dead again.
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * HOUR)).toBe(false);
  });

  it('is true for a never-expiring, unlimited-use invite (null ExpiresAt + null TotalUses)', async () => {
    const token = 'invite-out-forever-' + rand();
    await db.insertFormationInvite(token, 'sapp-out-forever', ownerPublicKey, signMessage);

    // Every other invite in this DB is expired or consumed by T0 + 2h; only the
    // unbounded one is left, and it has no wall clock of its own to lapse against.
    expect(await db.hasOutstandingFormationInvite(T0 + 2 * HOUR)).toBe(true);
    expect(await db.hasOutstandingFormationInvite(T0 + 365 * 24 * HOUR)).toBe(true);
  });
});
