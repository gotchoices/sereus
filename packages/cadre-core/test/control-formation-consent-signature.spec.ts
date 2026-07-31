import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { generateStampId } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { signFormationApproval } from '../src/formation-approval.js';
import { verifyFormationConsent } from '../src/peer-authorization.js';
import { expectConstraintFailure, expectUniqueViolation } from './control-constraint-helpers.js';
import { mintJoiner, mintConsent, signJoinerConsent } from './formation-consent-helper.js';
import type { TestJoiner } from './formation-consent-helper.js';

/**
 * The negative-case matrix for `FormationUsage.PeerConsented` — the schema CHECK that
 * re-verifies the JOINING peer's own signature on every usage insert.
 *
 * Two digests exist over this one table and must never stand in for one another:
 *
 *   | digest  | tag         | fields, in order                                    | signed by            |
 *   |---------|-------------|-----------------------------------------------------|----------------------|
 *   | vouch   | `'vouch'`   | token, usageStampId, strandId, peerKey, disclosure  | an enrolled approver |
 *   | consent | `'consent'` | token, usageStampId, peerKey, disclosure            | the joining peer     |
 *
 * `strandId` is deliberately absent from the consent digest: the joiner cannot know the
 * strand when it signs (see the NOTE on `FormationUsage.PeerConsented` in control-schema.ts).
 *
 * CONSTRAINT FIRING ORDER, which every case here is arranged around: `PeerConsented` is
 * `check on insert` and carries no subquery, so it evaluates AT the insert; `Authorized` is
 * also `check on insert` but carries a subquery, so Quereus auto-defers it to commit. When
 * both would fail, `PeerConsented` is the one that surfaces. `expectConstraintFailure`
 * matches ONE name, so each case is set up so exactly one constraint CAN fail:
 *
 *  - `PeerConsented` cases pre-insert an owner-signed strand and use `recordFormationUsage`
 *    (never `redeemInvitation`) against an invite with NO `ValidationUrl`. That satisfies
 *    `StrandExists` and disarms `Authorized`'s vouch branch.
 *  - `Authorized` cases supply a consent signature that is valid over the row's ACTUAL
 *    fields, so `PeerConsented` passes and only the vouch check is left to fail.
 *
 * Lives in its own file rather than in control-formation-invite.spec.ts (already ~1.5k
 * lines) so this constraint's whole coverage sits in one place; the three original
 * `PeerConsented` cases moved here from that spec and open the suite below.
 */
describe('FormationUsage joiner-consent signature matrix', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let ownerPrivateKey: string;
  let ownerPublicKey: string;

  // ed25519-sign the raw message bytes (no pre-hash), matching the ControlDatabase writers.
  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);

  async function strandCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.Strand');
    return Number(row?.c ?? 0);
  }
  async function usageCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.FormationUsage');
    return Number(row?.c ?? 0);
  }

  /**
   * An owner-signed host strand plus an approver-FREE invite against it — the setup every
   * `PeerConsented` case needs: `StrandExists` is satisfied by the committed strand and
   * `Authorized`'s vouch branch cannot fire on an invite with no `ValidationUrl`, so the
   * joiner's own signature is the only thing left that can refuse the write.
   */
  async function plainInvite(tag: string): Promise<{ token: string; strandId: string }> {
    const token = `invite-${tag}-` + rand();
    const strandId = `strand-${tag}-` + rand();
    await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
    await db.insertFormationInvite(token, 'sapp-' + tag, ownerPublicKey, signMessage);
    return { token, strandId };
  }

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: {
        partyId: 'formation-consent-sig-' + rand(),
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

  /**
   * The three cases that shipped with the constraint, moved here unchanged apart from
   * harness plumbing: the positive path, a signature from the wrong key, and the rollback
   * of a whole consent-seating transaction when the joiner's signature fails.
   */
  describe('the constraint itself (key ↔ signature)', () => {
    it('lands a consent whose signature matches the presented joiner key, and stores both', async () => {
      const { token, strandId } = await plainInvite('consent-ok');

      const consent = mintConsent(token);
      expect((await db.recordFormationUsage({ token, strandId, ...consent })).useNumber).toBe(1);

      const row = await rawDb.get(
        'select PeerKey, PeerSig from CadreControl.FormationUsage where Token = ?',
        [token],
      );
      expect(row?.PeerKey).toBe(consent.peerKey);
      expect(row?.PeerSig).toBe(consent.peerSignature);
    });

    it('refuses a consent signed by a DIFFERENT joiner than the key presented', async () => {
      const { token, strandId } = await plainInvite('consent-forged');

      const presented = mintConsent(token);
      const before = await usageCount();
      // A perfectly valid signature — from the WRONG key: a second joiner signs over the
      // same token and nonce, and its consent is filed under the first joiner's PeerKey.
      // The pre-existing owner-signed strand keeps StrandExists and Authorized satisfied,
      // so PeerConsented is the single rejector.
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId,
          peerKey: presented.peerKey,
          usageStampId: presented.usageStampId,
          peerSignature: signJoinerConsent(mintJoiner(), { token, usageStampId: presented.usageStampId }),
        }),
        'PeerConsented',
      );
      expect(await usageCount()).toBe(before);
    });

    it('rolls back the whole consent-seating transaction when the joiner signature fails', async () => {
      const token = 'invite-consent-seatfail-' + rand();
      await db.insertFormationInvite(token, 'sapp-consent-seatfail', ownerPublicKey, signMessage);

      const presented = mintConsent(token);
      const strandsBefore = await strandCount();
      const usageBefore = await usageCount();
      // Same wrong-key shape on an unbound invite with NO strand pre-inserted.
      // PeerConsented is check-on-insert: it fires at the usage insert inside the seating
      // transaction, and the strand insert that preceded it rolls back with it.
      await expectConstraintFailure(
        db.redeemInvitation({
          token, strandId: 'strand-consent-seatfail-' + rand(),
          peerKey: presented.peerKey,
          usageStampId: presented.usageStampId,
          peerSignature: signJoinerConsent(mintJoiner(), { token, usageStampId: presented.usageStampId }),
        }),
        'PeerConsented',
      );
      expect(await strandCount()).toBe(strandsBefore);
      expect(await usageCount()).toBe(usageBefore);
    });
  });

  /**
   * Lifting one genuine consent onto ANOTHER row. Each case keeps the signature intact and
   * moves exactly ONE field of the consent digest, so dropping any single field from both
   * sides of the digest (the SQL in control-schema.ts and `formationConsentMessage`) turns
   * exactly one of these red — a suite whose cases each varied two fields would stay green
   * when the weaker of the pair was dropped.
   *
   * Mutation-verified, not merely argued: dropping `Token`, then `UsageStampId`, then
   * `Disclosure` from both sides of the digest each turned exactly ONE case in this block
   * red (`DIFFERENT token`, `SIGNED nonce`, `DIFFERENT disclosure text` respectively) and
   * left the other three green. `PeerKey` is the fourth digest field and is deliberately
   * NOT claimed here — nothing can pin it; see the note in the `verifyFormationConsent`
   * block below for why.
   *
   * The nonce appears TWICE below, refused by two INDEPENDENT mechanisms: a nonce SIGNED but
   * not presented fails `PeerConsented`, while a nonce presented a second time VERBATIM is
   * refused by `UsageStampId`'s `unique` before any digest is consulted. Keeping those
   * distinct is the point — a case refusable by either would go green after a refactor that
   * dropped one of them.
   */
  describe('one-field mutations of the consent digest', () => {
    it('refuses a consent minted over a DIFFERENT token', async () => {
      const { token, strandId } = await plainInvite('consent-token');
      const joiner = mintJoiner();
      const usageStampId = generateStampId(joiner.peerKey);

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId,
          peerKey: joiner.peerKey,
          usageStampId,
          // Signed for a different invitation entirely, then filed under this one.
          peerSignature: signJoinerConsent(joiner, { token: token + '-other', usageStampId }),
        }),
        'PeerConsented',
      );
      expect(await usageCount()).toBe(before);

      // Same joiner, same nonce, the token it actually signed for: lands. So the refusal
      // above was about the token and nothing else.
      expect((await db.recordFormationUsage({
        token, strandId,
        peerKey: joiner.peerKey,
        usageStampId,
        peerSignature: signJoinerConsent(joiner, { token, usageStampId }),
      })).useNumber).toBe(1);
      expect(await usageCount()).toBe(before + 1);
    });

    it('refuses a consent whose SIGNED nonce is not the nonce presented', async () => {
      const { token, strandId } = await plainInvite('consent-nonce');
      const joiner = mintJoiner();
      const signedNonce = generateStampId(joiner.peerKey);
      const presentedNonce = generateStampId(joiner.peerKey);

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId,
          peerKey: joiner.peerKey,
          usageStampId: presentedNonce,
          peerSignature: signJoinerConsent(joiner, { token, usageStampId: signedNonce }),
        }),
        'PeerConsented',
      );
      expect(await usageCount()).toBe(before);

      // The nonce that WAS signed, presented as itself: lands. Neither nonce had ever been
      // spent, so `unique` could not have been what refused the write above.
      expect((await db.recordFormationUsage({
        token, strandId,
        peerKey: joiner.peerKey,
        usageStampId: signedNonce,
        peerSignature: signJoinerConsent(joiner, { token, usageStampId: signedNonce }),
      })).useNumber).toBe(1);
      expect(await usageCount()).toBe(before + 1);
    });

    it('refuses a SPENT nonce re-presented verbatim on `unique`, NOT on PeerConsented', async () => {
      const { token, strandId } = await plainInvite('consent-replay');
      // One consent object, presented twice. Every signed field matches on the second
      // presentation, so the digest verify passes and cannot be what refuses it. The invite
      // is uncapped, so `recordFormationUsage` derives UseNumber 2 for the replay and the
      // (Token, UseNumber) primary key does not collide either — leaving the nonce column's
      // `unique`, which is enforced on the insert rather than as a named deferred CHECK.
      const consent = mintConsent(token);
      expect((await db.recordFormationUsage({ token, strandId, ...consent })).useNumber).toBe(1);

      const before = await usageCount();
      await expectUniqueViolation(
        db.recordFormationUsage({ token, strandId, ...consent }),
        'FormationUsage.UsageStampId',
      );
      expect(await usageCount()).toBe(before);
    });

    it('refuses a consent minted over DIFFERENT disclosure text than the row carries', async () => {
      const { token, strandId } = await plainInvite('consent-disclosure');
      const joiner = mintJoiner();
      const usageStampId = generateStampId(joiner.peerKey);
      const disclosure = 'joining as a household device';

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId, disclosure,
          peerKey: joiner.peerKey,
          usageStampId,
          // The joiner agreed to one disclosure; a different one is filed against its name.
          peerSignature: signJoinerConsent(joiner, { token, usageStampId, disclosure: disclosure + ' — and one more thing' }),
        }),
        'PeerConsented',
      );
      expect(await usageCount()).toBe(before);

      // Same nonce and key, the disclosure it actually signed: lands.
      expect((await db.recordFormationUsage({
        token, strandId, disclosure,
        peerKey: joiner.peerKey,
        usageStampId,
        peerSignature: signJoinerConsent(joiner, { token, usageStampId, disclosure }),
      })).useNumber).toBe(1);
      expect(await usageCount()).toBe(before + 1);
    });
  });

  /**
   * The `'vouch'` and `'consent'` action tags make the two digests over this table disjoint,
   * so neither signature is usable in the other's slot. Both cases hold the KEY constant —
   * the joiner signs both digests itself — so the action tag plus the field list is the ONLY
   * difference. A case that let the key differ too would prove nothing about tagging: it
   * would be refused for the wrong reason.
   */
  describe('action-tag disjointness (vouch ⇎ consent)', () => {
    it('refuses the vouch digest, signed by the joiner itself, presented as PeerSig', async () => {
      const { token, strandId } = await plainInvite('tag-vouch-as-consent');
      const joiner = mintJoiner();
      const usageStampId = generateStampId(joiner.peerKey);

      // A real 'vouch' signature over this exact redemption, from the joiner's OWN key —
      // so `verify(..., new.PeerSig, new.PeerKey, ...)` has the right key and fails purely
      // on the bytes: a different action tag and an extra signed field (strandId).
      const vouchSignature = signFormationApproval(
        { token, usageStampId, strandId, peerKey: joiner.peerKey, disclosure: '' },
        joiner.peerKey,
        joiner.privateKey,
      ).validationSignature;

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId,
          peerKey: joiner.peerKey,
          usageStampId,
          peerSignature: vouchSignature,
        }),
        'PeerConsented',
      );
      expect(await usageCount()).toBe(before);

      // The same key over the same redemption, signing the CONSENT digest: lands.
      expect((await db.recordFormationUsage({
        token, strandId,
        peerKey: joiner.peerKey,
        usageStampId,
        peerSignature: signJoinerConsent(joiner, { token, usageStampId }),
      })).useNumber).toBe(1);
      expect(await usageCount()).toBe(before + 1);
    });

    it('refuses the consent signature presented as the approver sign-off', async () => {
      // The mirror case, and the sharper one: the joiner's own public key is ENROLLED as a
      // ValidationKey first, so `Authorized`'s enrolled-row lookup succeeds and the vouch
      // `verify` is the only thing left that can fail. The SAME signature bytes are then
      // simultaneously valid as PeerSig and rejected as a sign-off.
      const strandId = 'strand-tag-consent-as-vouch-' + rand();
      const token = 'invite-tag-consent-as-vouch-' + rand();
      await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
      await db.insertFormationInvite(token, 'sapp-tag-cav', ownerPublicKey, signMessage, {
        validationUrl: 'https://validate.example/tag-cav',
      });

      const joiner = mintJoiner();
      await db.insertValidationKey(joiner.peerKey, ownerPublicKey, signMessage);
      const usageStampId = generateStampId(joiner.peerKey);
      const consentSignature = signJoinerConsent(joiner, { token, usageStampId });

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          token, strandId,
          peerKey: joiner.peerKey,
          usageStampId,
          peerSignature: consentSignature,
          validationKey: joiner.peerKey,
          validationSignature: consentSignature,
        }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);

      // Same enrolled key, same nonce, signing the VOUCH digest this time: lands. So the
      // refusal above was about which digest was signed, not about the key or the enrolment.
      expect((await db.recordFormationUsage({
        token, strandId,
        peerKey: joiner.peerKey,
        usageStampId,
        peerSignature: consentSignature,
        validationKey: joiner.peerKey,
        validationSignature: signFormationApproval(
          { token, usageStampId, strandId, peerKey: joiner.peerKey, disclosure: '' },
          joiner.peerKey,
          joiner.privateKey,
        ).validationSignature,
      })).useNumber).toBe(1);
      expect(await usageCount()).toBe(before + 1);
    });
  });

  /**
   * A `ValidationUrl` invite demands BOTH signatures, and they must agree with the row and
   * with each other: the approver vouched for a redemption and the joiner consented to one,
   * so a redemption where those are not the SAME redemption must not land.
   *
   * Each mismatch below is run in both directions, which is what proves the two checks are
   * independent rather than one standing in for the other: a stale VOUCH (consent fresh)
   * must be refused by `Authorized`, and a stale CONSENT (vouch fresh) by `PeerConsented`.
   */
  describe('ValidationUrl invites: both signatures, one redemption', () => {
    let approverPrivateKey: string;
    let approverPublicKey: string;

    /** A redemption of a `ValidationUrl` invite: the row's fields plus the joiner that signs. */
    interface Redemption {
      token: string;
      strandId: string;
      usageStampId: string;
      disclosure: string;
      joiner: TestJoiner;
    }

    /** The enrolled approver's sign-off over an arbitrary field tuple. */
    const vouch = (fields: Omit<Redemption, 'joiner'> & { peerKey: string }): string =>
      signFormationApproval(fields, approverPublicKey, approverPrivateKey).validationSignature;

    /** Spread straight into `recordFormationUsage`: the row as `redemption` describes it. */
    const rowOf = (r: Redemption) => ({
      token: r.token, strandId: r.strandId, disclosure: r.disclosure,
      peerKey: r.joiner.peerKey, usageStampId: r.usageStampId,
    });

    async function validatingInvite(tag: string): Promise<Redemption> {
      const token = `invite-${tag}-` + rand();
      const strandId = `strand-${tag}-` + rand();
      await db.insertStrand(strandId, 'o', ownerPublicKey, signMessage);
      await db.insertFormationInvite(token, 'sapp-' + tag, ownerPublicKey, signMessage, {
        validationUrl: `https://validate.example/${tag}`,
      });
      return { token, strandId, usageStampId: generateStampId(tag + rand()), disclosure: `${tag}-disclosure`, joiner: mintJoiner() };
    }

    beforeAll(async () => {
      // ONE enrolled approver for the whole block, so every refusal below is about the
      // signature presented rather than about the party having no approver at all.
      approverPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
      approverPublicKey = getPublicKey(approverPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
      await db.insertValidationKey(approverPublicKey, ownerPublicKey, signMessage);
    });

    it('lands when both signatures cover the redemption being written', async () => {
      const r = await validatingInvite('both-ok');
      const row = rowOf(r);

      const before = await usageCount();
      expect((await db.recordFormationUsage({
        ...row,
        peerSignature: signJoinerConsent(r.joiner, r),
        validationKey: approverPublicKey,
        validationSignature: vouch({ ...row, peerKey: r.joiner.peerKey }),
      })).useNumber).toBe(1);
      expect(await usageCount()).toBe(before + 1);

      const stored = await rawDb.get(
        'select UsageStampId, PeerKey, Disclosure from CadreControl.FormationUsage where Token = ?',
        [r.token],
      );
      expect(stored?.UsageStampId).toBe(r.usageStampId);
      expect(stored?.PeerKey).toBe(r.joiner.peerKey);
      expect(stored?.Disclosure).toBe(r.disclosure);
    });

    it('refuses a vouch over nonce A when the row (and the consent) carry nonce B', async () => {
      const r = await validatingInvite('vouch-nonce');
      const row = rowOf(r);
      const otherNonce = generateStampId('vouch-nonce-other-' + rand());

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          ...row,
          // Consent is valid over the row's OWN nonce, so PeerConsented passes and the
          // approver's stale sign-off is the single rejector.
          peerSignature: signJoinerConsent(r.joiner, r),
          validationKey: approverPublicKey,
          validationSignature: vouch({ ...row, usageStampId: otherNonce, peerKey: r.joiner.peerKey }),
        }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);
    });

    it('refuses a consent over nonce A when the row (and the vouch) carry nonce B', async () => {
      const r = await validatingInvite('consent-nonce');
      const row = rowOf(r);
      const otherNonce = generateStampId('consent-nonce-other-' + rand());

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          ...row,
          peerSignature: signJoinerConsent(r.joiner, { ...r, usageStampId: otherNonce }),
          validationKey: approverPublicKey,
          validationSignature: vouch({ ...row, peerKey: r.joiner.peerKey }),
        }),
        'PeerConsented',
      );
      expect(await usageCount()).toBe(before);
    });

    it('refuses a vouch over disclosure A when the row (and the consent) carry disclosure B', async () => {
      const r = await validatingInvite('vouch-disclosure');
      const row = rowOf(r);

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          ...row,
          peerSignature: signJoinerConsent(r.joiner, r),
          validationKey: approverPublicKey,
          validationSignature: vouch({ ...row, disclosure: r.disclosure + ' (as amended)', peerKey: r.joiner.peerKey }),
        }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);
    });

    it('refuses a consent over disclosure A when the row (and the vouch) carry disclosure B', async () => {
      const r = await validatingInvite('consent-disclosure');
      const row = rowOf(r);

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({
          ...row,
          peerSignature: signJoinerConsent(r.joiner, { ...r, disclosure: r.disclosure + ' (as amended)' }),
          validationKey: approverPublicKey,
          validationSignature: vouch({ ...row, peerKey: r.joiner.peerKey }),
        }),
        'PeerConsented',
      );
      expect(await usageCount()).toBe(before);
    });

    it('refuses a fully-consented redemption with no approver sign-off at all', async () => {
      // The consent-present half of "both are required": everything the JOINER owes is in
      // order, and the write is still refused because the approver never signed.
      const r = await validatingInvite('no-vouch');

      const before = await usageCount();
      await expectConstraintFailure(
        db.recordFormationUsage({ ...rowOf(r), peerSignature: signJoinerConsent(r.joiner, r) }),
        'Authorized',
      );
      expect(await usageCount()).toBe(before);
    });
  });

  /**
   * `verifyFormationConsent` is the READ-side mirror of the `PeerConsented` CHECK: any later
   * reader of a replicated `FormationUsage` row can re-establish that the named joiner
   * really consented, without trusting the node that wrote the row. These cases feed it
   * columns read straight back out of the table, so a drift between the SQL digest and the
   * TypeScript one shows up as a landed row that fails its own re-check.
   */
  describe('verifyFormationConsent re-checks a stored row', () => {
    interface StoredConsent {
      token: string; usageStampId: string; peerKey: string; disclosure: string; peerSig: string;
    }

    async function landAndReadBack(tag: string, disclosure: string): Promise<StoredConsent> {
      const { token, strandId } = await plainInvite(tag);
      await db.recordFormationUsage({ token, strandId, disclosure, ...mintConsent(token, disclosure) });
      const row = await rawDb.get(
        'select Token, UsageStampId, PeerKey, PeerSig, Disclosure from CadreControl.FormationUsage where Token = ?',
        [token],
      );
      expect(row).toBeTruthy();
      return {
        token: row!.Token as string,
        usageStampId: row!.UsageStampId as string,
        peerKey: row!.PeerKey as string,
        disclosure: (row!.Disclosure ?? '') as string,
        peerSig: row!.PeerSig as string,
      };
    }

    it('verifies a row read back out of CadreControl.FormationUsage', async () => {
      expect(verifyFormationConsent(await landAndReadBack('recheck-ok', 'joining a household'))).toBe(true);
    });

    it('fails once ANY signed field of the stored row is altered', async () => {
      const stored = await landAndReadBack('recheck-mutate', 'joining a household');
      expect(verifyFormationConsent(stored)).toBe(true);

      // One field at a time, so a digest that stopped covering a field turns exactly one red —
      // with ONE exception, confirmed by mutation: removing `peerKey` from the digest breaks
      // NOTHING here or in peer-authorization.spec.ts. It cannot: `verify` checks the signature
      // against the row's own `peerKey`, so swapping that field swaps the VERIFYING key and the
      // check fails whether or not the digest also covers it. The digest's copy of `peerKey` is
      // redundant belt-and-braces today and is unpinnable by construction.
      // NOTE: it stops being redundant the moment any caller verifies a consent against a key
      // that is NOT the row's `peerKey` (e.g. a key resolved from a peer id or an enrolled row);
      // at that point add a case that pins the binding, because none exists.
      // Pure-unit siblings of these mutations — synthetic rows, no database — are in
      // peer-authorization.spec.ts → `verifyFormationConsent`; this block exists to catch the
      // SQL-digest ⇄ TypeScript-digest drift those cannot see.
      expect(verifyFormationConsent({ ...stored, token: stored.token + '-other' })).toBe(false);
      expect(verifyFormationConsent({ ...stored, usageStampId: generateStampId('recheck-other-' + rand()) })).toBe(false);
      expect(verifyFormationConsent({ ...stored, peerKey: mintJoiner().peerKey })).toBe(false);
      expect(verifyFormationConsent({ ...stored, disclosure: stored.disclosure + '!' })).toBe(false);
      // The signature itself, corrupted in its leading base64url character.
      expect(verifyFormationConsent({ ...stored, peerSig: (stored.peerSig[0] === 'A' ? 'B' : 'A') + stored.peerSig.slice(1) })).toBe(false);
    });

    it('answers false on garbage rather than throwing', async () => {
      const stored = await landAndReadBack('recheck-garbage', '');

      // A caller re-checking a REPLICATED row holds whatever the wire delivered, so the
      // verdict has to survive input that is not a key or a signature at all.
      expect(verifyFormationConsent({ ...stored, peerKey: 'not base64url!!' })).toBe(false);
      expect(verifyFormationConsent({ ...stored, peerSig: 'not base64url!!' })).toBe(false);
      expect(verifyFormationConsent({ ...stored, peerKey: '' })).toBe(false);
      expect(verifyFormationConsent({ ...stored, peerSig: '' })).toBe(false);
      expect(verifyFormationConsent({ token: '', usageStampId: '', peerKey: '', disclosure: '', peerSig: '' })).toBe(false);
      // Right shape, wrong length: 32 base64url characters is a well-formed string but not
      // a 32-BYTE ed25519 key, which is a different failure path inside the verifier.
      expect(verifyFormationConsent({ ...stored, peerKey: 'A'.repeat(32) })).toBe(false);
    });
  });
});
