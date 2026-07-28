import { describe, it, expect, afterEach } from 'vitest';
import debug from 'debug';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
  bootstrapFounderMembership,
  addMemberByManager,
  registerMemberPeer,
  addManager,
  removeManager,
  signStrandPayload,
} from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { SAppConfig } from '../src/types.js';

/**
 * Component coverage for the two remaining founder-reachable writers:
 * `MemberPeer` registration (a member binds its own network nodes, self-signed) and
 * `Manager` rotation (an existing manager promotes/removes admins, or a
 * manager resigns itself). Every test runs against a REAL closed strand DB in
 * bootstrap mode (libp2p node + MemoryRawStorage + the optimystic local transactor)
 * via `connectToStrand` — the same path `StrandDatabase` uses — so the real
 * apply/DML/deferred-constraint path is exercised, not a fake.
 *
 * The founder is bootstrapped first (Member #1 + the sole founding Manager), so a
 * manager add genuinely runs past the `count(Manager) <= 1` bootstrap branch
 * (at commit the new row makes the count ≥ 2), exercising signature verification.
 */

const log = debug('sereus:cadre:test:strand-rotation');

function makeSAppConfig(overrides: Partial<SAppConfig> = {}): SAppConfig {
  return {
    id: 'sapp-author-pubkey',
    version: '1.2.3',
    schema: 'table Note (Id integer primary key, Body text not null)',
    signature: 'sapp-signature',
    ...overrides,
  };
}

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
function freshKeyPair(): Ed25519KeyPair {
  const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKeyB64, publicKeyB64 };
}

type StrandTable = 'Header' | 'Member' | 'MemberPeer' | 'Manager';

async function tableCount(db: Database, table: StrandTable): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

interface Strand {
  db: Database;
  strandId: string;
  /** The founder keypair — Member #1 and the sole founding Manager. */
  founder: Ed25519KeyPair;
  shutdown: () => Promise<void>;
}

const opened: Strand[] = [];

/** Open a strand DB in bootstrap mode and run the founder bootstrap for the type. */
async function openStrand(type: 'o' | 'c'): Promise<Strand> {
  const strandId = randomUUID();
  const storage = new MemoryRawStorage();
  const db = new Database();
  const result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });
  const founder = strandMemberKeyPair(await generateStrandMemberKey());
  await bootstrapFounderMembership(db, {
    strandId,
    type,
    sApp: makeSAppConfig(),
    founderKeyPair: type === 'c' ? founder : undefined,
  });
  const strand: Strand = {
    db,
    strandId,
    founder,
    shutdown: async () => {
      await result.shutdown();
      db.close();
    },
  };
  opened.push(strand);
  return strand;
}

afterEach(async () => {
  while (opened.length > 0) {
    const strand = opened.pop()!;
    await strand.shutdown();
  }
});

// ── Phase 1: MemberPeer registration (member self-signs its own peer) ─────────

describe('registerMemberPeer', () => {
  it('the founder member registers a peer → exactly one MemberPeer row bound to its key', async () => {
    const { db, founder } = await openStrand('c');

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-alpha' });

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
    const row = await db.get('select MemberKey, PeerId from Strand.MemberPeer');
    expect(row?.MemberKey).toBe(founder.publicKeyB64);
    expect(row?.PeerId).toBe('peer-alpha');
  }, 30_000);

  it('rejects a peer insert signed by a key other than the member key (self-signature only)', async () => {
    const { db, founder } = await openStrand('c');
    const peerId = 'peer-impostor';
    const impostor = freshKeyPair();

    // The MemberKey is the real founder member (so the deferred MemberExists passes),
    // but the Signature is made by an unrelated key over the same payload — so the
    // immediate Authorized check (verify against MemberKey itself) fails.
    const payload = `${founder.publicKeyB64}|${peerId}`;
    const wrongSignature = signStrandPayload(payload, impostor.privateKeyB64);

    await expect(
      db.exec(
        `insert into Strand.MemberPeer (MemberKey, PeerId)
           with context Signature = ?
           values (?, ?)`,
        [wrongSignature, founder.publicKeyB64, peerId],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('rejects registering a peer for a key with no Member row (deferred MemberExists)', async () => {
    const { db } = await openStrand('c');
    const notAMember = freshKeyPair();

    // Self-signature is valid (registerMemberPeer self-signs), but no Member row
    // exists for this key, so the deferred MemberExists rejects at commit.
    await expect(
      registerMemberPeer(db, { memberKeyPair: notAMember, peerId: 'peer-ghost' }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('a member may register multiple distinct peers (multi-device) → one row per PeerId', async () => {
    const { db, founder } = await openStrand('c');

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-phone' });
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-laptop' });

    expect(await tableCount(db, 'MemberPeer')).toBe(2);
    const peers = await db.get(
      'select count(1) as c from Strand.MemberPeer where MemberKey = ?',
      [founder.publicKeyB64],
    );
    expect(peers?.c).toBe(2);
  }, 30_000);

  it('re-registering the same (MemberKey, PeerId) is an insert-if-absent no-op (restart-safe)', async () => {
    const { db, founder } = await openStrand('c');

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-stable' });
    // A second call (e.g. on founder restart) must not throw and must not duplicate
    // the row — the writer's existence guard skips the redundant insert, so the
    // restart path never has to catch the platform's duplicate-PK rejection.
    await expect(
      registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-stable' }),
    ).resolves.toBeUndefined();

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('re-registering ONE of a member\'s peers skips only that peer (siblings + new peers unaffected)', async () => {
    const { db, founder } = await openStrand('c');

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-phone' });
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-laptop' });
    expect(await tableCount(db, 'MemberPeer')).toBe(2);

    // The existence guard scans this member's peers, so `peer-laptop` is among the
    // rows it walks — an incorrect PeerId comparison would false-positive here.
    await expect(
      registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-phone' }),
    ).resolves.toBeUndefined();
    expect(await tableCount(db, 'MemberPeer')).toBe(2);

    // A genuinely new PeerId under the same member still inserts.
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-tablet' });
    expect(await tableCount(db, 'MemberPeer')).toBe(3);
  }, 30_000);

  it('two different members may register the SAME PeerId (guard keys on MemberKey too)', async () => {
    const { db, founder } = await openStrand('c');
    const second = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: second.publicKeyB64 });

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-shared' });
    // The second member's registration must NOT be skipped just because some other
    // member already registered `peer-shared` — the guard re-checks MemberKey in JS.
    await registerMemberPeer(db, { memberKeyPair: second, peerId: 'peer-shared' });

    expect(await tableCount(db, 'MemberPeer')).toBe(2);
    // Per-MemberKey counts (not a bare table count) prove a row landed for EACH member.
    const founderPeers = await db.get(
      'select count(1) as c from Strand.MemberPeer where MemberKey = ?',
      [founder.publicKeyB64],
    );
    expect(founderPeers?.c).toBe(1);
    const secondPeers = await db.get(
      'select count(1) as c from Strand.MemberPeer where MemberKey = ?',
      [second.publicKeyB64],
    );
    expect(secondPeers?.c).toBe(1);
  }, 30_000);

  it('a non-founder member admitted by manager can register its own peer (count > 1 branch)', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });

    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-member' });

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
    const row = await db.get('select MemberKey, PeerId from Strand.MemberPeer');
    expect(row?.MemberKey).toBe(member.publicKeyB64);
    expect(row?.PeerId).toBe('peer-member');
  }, 30_000);

  it('rejects peer registration on an open strand (no Member can exist → MemberExists)', async () => {
    const { db } = await openStrand('o');
    const stranger = freshKeyPair();

    // Open strands seat no Member (Member is OnlyClosed), so MemberExists has nothing
    // to match and the peer insert is rejected.
    await expect(
      registerMemberPeer(db, { memberKeyPair: stranger, peerId: 'peer-open' }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);
});

// ── Phase 2: Manager rotation (add / remove admins) ─────────────────────────

/** Add `count` extra managers (signed by the founder) and return their keypairs. */
async function addExtraManagers(db: Database, founder: Ed25519KeyPair, count: number): Promise<Ed25519KeyPair[]> {
  const extras: Ed25519KeyPair[] = [];
  for (let i = 0; i < count; i++) {
    const kp = freshKeyPair();
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: kp.publicKeyB64 });
    extras.push(kp);
  }
  return extras;
}

describe('addManager', () => {
  it('an existing manager promotes a second manager (non-bootstrap signature branch)', async () => {
    const { db, founder } = await openStrand('c');
    const second = freshKeyPair();

    await addManager(db, { byManagerKeyPair: founder, newManagerKey: second.publicKeyB64 });

    // At commit the count is 2, so the `count(Manager) <= 1` bootstrap branch is
    // false — this genuinely passed via the existing-manager signature branch.
    expect(await tableCount(db, 'Manager')).toBe(2);
    const row = await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [second.publicKeyB64]);
    expect(row?.MemberKey).toBe(second.publicKeyB64);
  }, 30_000);

  it('rejects an add whose signer is not a manager (no count<=1 shortcut once founder exists)', async () => {
    const { db } = await openStrand('c');
    const notAManager = freshKeyPair();
    const target = freshKeyPair();

    await expect(
      addManager(db, { byManagerKeyPair: notAManager, newManagerKey: target.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
  }, 30_000);

  it('rejects an add whose signature is over the wrong key (signature binding)', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();
    const someOtherKey = freshKeyPair().publicKeyB64;

    // A real manager (founder) signs, but over a DIFFERENT key than the one being
    // inserted, so verify(digest(new.MemberKey=target), sig, founder) fails.
    const wrongSignature = signStrandPayload(someOtherKey, founder.privateKeyB64);

    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey)
           with context ManagerKey = ?, Signature = ?
           values (?)`,
        [founder.publicKeyB64, wrongSignature, target.publicKeyB64],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  // Self-promotion guard: the existing-manager branch of `Manager.Authorized` is a
  // deferred (subquery-bearing) CHECK, so at commit it runs against the POST-insert
  // row set — the row being inserted is already in `Manager` and would otherwise
  // match itself. The branch's `A.MemberKey <> coalesce(new.MemberKey, old.MemberKey)`
  // excludes that row, so a key cannot authorize its own promotion.
  it('rejects a key promoting ITSELF (the row being inserted is not its own authorizer)', async () => {
    const { db, founder } = await openStrand('c');
    const attacker = freshKeyPair();

    // A perfectly-formed self-authorization: the attacker signs its own key and binds
    // itself as context.ManagerKey. Only the `<>` guard stands between this and admin.
    await expect(
      addManager(db, { byManagerKeyPair: attacker, newManagerKey: attacker.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [attacker.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a manager add on an open strand (Manager is OnlyClosed)', async () => {
    const { db } = await openStrand('o');
    const target = freshKeyPair();

    // Open strands have no founding Manager and Manager is OnlyClosed; any add is rejected.
    await expect(
      addManager(db, { byManagerKeyPair: freshKeyPair(), newManagerKey: target.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(0);
  }, 30_000);
});

describe('removeManager', () => {
  // NOTE on what these prove: the writer builds a correctly-signed delete (the
  // existing-manager branch for admin removal, the former-manager self branch
  // for self-resignation — see removeManager's doc). The optimystic bootstrap-mode
  // transactor now evaluates deferred (subquery-bearing) CHECK constraints on DELETE
  // — `Manager.Authorized` is one — so these acceptance tests genuinely exercise
  // the signature branches (the founder/self signatures are valid for those
  // branches), and an unauthorized delete is rejected (see the test below). The
  // platform gap they previously documented is tracked by
  // `optimystic-deferred-check-not-enforced-on-delete` (backlog), now fixed.
  it('a manager removes a DIFFERENT manager and leaves the other managers intact', async () => {
    const { db, founder } = await openStrand('c');
    // 3 managers total so removing one leaves 2 (≥ 2 after delete keeps the
    // `count(Manager) <= 1` bootstrap branch false, so this genuinely takes the
    // existing-manager signature branch).
    const [a2, a3] = await addExtraManagers(db, founder, 2);
    expect(await tableCount(db, 'Manager')).toBe(3);

    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: a3.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a3.publicKeyB64])).toBeUndefined();
    // The other managers are untouched (only the targeted row was removed).
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('a manager resigns itself (self-targeted removal removes only its own row)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    expect(await tableCount(db, 'Manager')).toBe(3);

    await removeManager(db, { byManagerKeyPair: a2, targetManagerKey: a2.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  // Delete-side constraint enforcement: an unauthorized removal is rejected.
  //
  // `Manager.Authorized` (a deferred, subquery-bearing CHECK) rejects a removal
  // whose signer is neither an existing manager nor the target itself. The
  // optimystic bootstrap-mode vtab transactor now evaluates deferred CHECK
  // constraints on DELETE (not only on INSERT), so a non-manager can no longer
  // remove a Manager row. This pins the intended secure behavior; it previously
  // documented the platform gap tracked by
  // `optimystic-deferred-check-not-enforced-on-delete` (backlog), now fixed.
  it('a non-manager removal is rejected (deferred CHECK enforced on delete)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    const notAManager = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(3);

    // No accepting branch matches (post-delete count 2 keeps the bootstrap branch
    // false), so the deferred Authorized CHECK rejects the delete at commit.
    await expect(
      removeManager(db, { byManagerKeyPair: notAManager, targetManagerKey: a2.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(3); // unchanged — nothing was removed
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a removal whose signature is over the wrong key (signature binding on delete)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    const someOtherKey = freshKeyPair().publicKeyB64;
    expect(await tableCount(db, 'Manager')).toBe(3);

    // A real manager (founder) signs, but over a DIFFERENT key than the row being
    // deleted, so verify(digest(old.MemberKey=a2), sig, founder) fails — the delete
    // analog of the addManager signature-binding test.
    const wrongSignature = signStrandPayload(someOtherKey, founder.privateKeyB64);

    await expect(
      db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, wrongSignature, a2.publicKeyB64],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(3);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
  }, 30_000);

  // ── The min-one-manager floor + the no-bootstrap-bypass pin ─────────────────
  //
  // `Manager.MinOneManager` (`check on delete`, deferred → sees the POST-delete
  // count) keeps a closed strand from ever reaching zero managers: every admit path
  // (Invite, addMemberByManager, addManager) needs a Manager row, so an admin-less
  // strand is frozen forever. And `Manager.Authorized`'s bootstrap branch is gated to
  // INSERTs (`old.MemberKey is null`), so a delete that drops the count toward the
  // floor no longer waives the signature check.

  it('rejects the SOLE manager resigning (min-one-manager floor)', async () => {
    const { db, founder } = await openStrand('c');
    expect(await tableCount(db, 'Manager')).toBe(1);

    // A valid self-resignation signature — rejected purely because it would empty
    // the Manager table.
    // Authorized passes (the self-resignation branch is satisfied), so MinOneManager
    // is the ONLY constraint that can reject — pinning the name proves the floor fired.
    await expect(
      removeManager(db, { byManagerKeyPair: founder, targetManagerKey: founder.publicKeyB64 }),
    ).rejects.toThrow(/MinOneManager/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a stranger removing the last manager (no unsigned drop to zero)', async () => {
    const { db, founder } = await openStrand('c');
    const stranger = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(1);

    // Both MinOneManager (post-delete count 0) and Authorized (stranger signature)
    // reject this; which one reports first is engine evaluation order, so only the
    // fact of a CHECK rejection is pinned.
    await expect(
      removeManager(db, { byManagerKeyPair: stranger, targetManagerKey: founder.publicKeyB64 }),
    ).rejects.toThrow(/CHECK constraint failed/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('still requires a valid signature for the SECOND-TO-LAST removal (bootstrap branch is insert-only)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 1);
    const stranger = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(2);

    // Post-delete count would be 1 — the old, ungated `count(Manager) <= 1` branch
    // accepted exactly this. Now it must fail on the signature.
    // MinOneManager is satisfied (1 would remain), so Authorized is the only rejector.
    await expect(
      removeManager(db, { byManagerKeyPair: stranger, targetManagerKey: a2.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(2);

    // The same removal, properly authorized by the OTHER manager, succeeds — proving
    // the rejection above was the signature, not the floor (1 manager still remains).
    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: a2.publicKeyB64 });
    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects any UPDATE of a Manager row (NoUpdate — a resignation signature is not a hand-off)', async () => {
    const { db, founder } = await openStrand('c');
    const attacker = freshKeyPair();

    // The strongest context an attacker could present: a genuine founder-signed
    // payload over the founder's OWN key (i.e. a captured self-resignation proof).
    // The former-manager branch verifies only `old.MemberKey`, so without NoUpdate
    // this would re-point the sole Manager row at an attacker-chosen key.
    const founderSelfSignature = signStrandPayload(founder.publicKeyB64, founder.privateKeyB64);

    await expect(
      db.exec(
        `update Strand.Manager
           with context ManagerKey = ?, Signature = ?
           set MemberKey = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, founderSelfSignature, attacker.publicKeyB64, founder.publicKeyB64],
      ),
    ).rejects.toThrow(/NoUpdate/); // not a parse error and not "updates unsupported"

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [attacker.publicKeyB64])).toBeUndefined();
  }, 30_000);

  it('rejects a same-transaction swap of the sole manager (hand-off must be add-then-resign)', async () => {
    const { db, founder } = await openStrand('c');
    // A second Member exists, so the bootstrap branch's `count(Member) <= 1` gate is
    // false — the successor cannot slip in as a "founding" manager.
    const successor = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: successor.publicKeyB64 });
    expect(await tableCount(db, 'Manager')).toBe(1);

    const resignSignature = signStrandPayload(founder.publicKeyB64, founder.privateKeyB64);

    // Delete-then-insert in ONE transaction: the deferred checks see the post-image
    // (one manager: the successor), which is exactly the state the old schema's
    // ungated bootstrap branch would have waved through.
    const swap = async (): Promise<void> => {
      await db.beginTransaction();
      try {
        await db.exec(
          `delete from Strand.Manager
             with context ManagerKey = ?, Signature = ?
             where MemberKey = ?`,
          [founder.publicKeyB64, resignSignature, founder.publicKeyB64],
        );
        await db.exec(
          `insert into Strand.Manager (MemberKey)
             with context ManagerKey = null, Signature = null
             values (?)`,
          [successor.publicKeyB64],
        );
        await db.commit();
      } catch (error) {
        // A failed commit() already tore the transaction down, so rollback() throws
        // "no transaction active" — log it rather than masking the real cause.
        try {
          await db.rollback();
        } catch (rollbackError) {
          log('Rollback after the swap attempt was a no-op: %s', rollbackError);
        }
        throw error;
      }
    };

    // The successor's INSERT has no other manager to authorize it (the founder's row
    // is gone in the post-image) and the bootstrap branch is gated off, so Authorized
    // rejects — not MinOneManager, which the successor row satisfies.
    await expect(swap()).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [successor.publicKeyB64])).toBeUndefined();
  }, 30_000);
});
