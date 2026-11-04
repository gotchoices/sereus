import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Database } from '@quereus/quereus';
import {
  StrandPartyKeyRotationDriver,
  type StrandPartyKeyRotationDeps,
  type StrandPartyKeySwapEntry,
} from '../src/strand-party-key-rotation.js';
import {
  bootstrapFounderMembership,
  isStrandManager,
  isStrandMember,
  listMemberPeers,
  registerMemberPeer,
} from '../src/strand-membership-writer.js';
import { readStrandRevocationRows } from '../src/strand-revocation-enforcer.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { PendingStrandPartyKeyRow } from '../src/types.js';
import { makeSAppConfig, openRawStrand } from './strand-spec-helpers.js';

/**
 * The party key rotation driver over a REAL closed strand on the local transactor (the same
 * engine path `StrandDatabase` uses), with the control database stubbed: a founded strand whose
 * party key K binds this machine, two siblings and a machine since removed from the cadre, and a
 * pending row naming a fresh key K'. A full run ends with K' as member and manager, this machine
 * and both siblings bound under K', K gone from the strand, the removed machine's binding under K
 * an orphan the revoked-peer gate denies, and one control swap. The same end state is reached
 * from every "crash after write N" state, by re-running the driver over the rows the crash left.
 */

/** This machine's peer id in the strand, and the party's other machines'. */
const SELF = 'self-machine';
const SIBLINGS = ['sibling-1', 'sibling-2'];
const REMOVED = 'removed-machine';

/**
 * The strand writes one clean run makes, in order: seat K' (1), bind self and two siblings under
 * K' (3), promote K' (1), K resigns (1), K leaves (1). The crash points below fail each one in turn.
 */
const WRITE_BATCHES = 7;

interface Fixture {
  db: Database;
  strandId: string;
  oldKey: Ed25519KeyPair;
  oldPrivateKey: string;
  newKey: Ed25519KeyPair;
  newPrivateKey: string;
  deps: StrandPartyKeyRotationDeps;
  swaps: () => StrandPartyKeySwapEntry[][];
  rotated: () => string[];
  /** Make the next control swap reject once. */
  failNextSwap: () => void;
}

/** A founded closed strand bound as described above, and a control seam that swaps in memory. */
async function rotationFixture(): Promise<Fixture> {
  const raw = await openRawStrand();
  const oldPrivateKey = await generateStrandMemberKey();
  const oldKey = strandMemberKeyPair(oldPrivateKey);
  await bootstrapFounderMembership(raw.db, {
    strandId: raw.strandId,
    type: 'c',
    sApp: makeSAppConfig(),
    founderKeyPair: oldKey,
    createEmptyCollections: raw.createEmptyCollections,
  });
  for (const peerId of [SELF, ...SIBLINGS, REMOVED]) {
    await registerMemberPeer(raw.db, { memberKeyPair: oldKey, peerId });
  }
  const newPrivateKey = await generateStrandMemberKey();
  let pending: PendingStrandPartyKeyRow | null = { privateKey: newPrivateKey, superseded: [], stampId: 'pending-stamp-1' };
  let currentKey = oldPrivateKey;
  let swapFailures = 0;
  const swaps: StrandPartyKeySwapEntry[][] = [];
  const rotated: string[] = [];
  const deps: StrandPartyKeyRotationDeps = {
    readPending: async () => pending,
    readCurrentKey: async () => currentKey,
    readSiblingPeerIds: async () => SIBLINGS,
    getDatabase: () => raw.db,
    getOwnPeerId: () => SELF,
    swapKeys: async (entries) => {
      if (swapFailures > 0) {
        swapFailures -= 1;
        throw new Error('injected swap failure');
      }
      swaps.push([...entries]);
      // What `ControlDatabase.swapStrandPartyKeys` leaves: the row names K', the pending row is gone.
      currentKey = entries[0]!.newKey;
      pending = null;
      return entries.map((entry) => entry.strandId);
    },
    onRotated: async (strandId) => { rotated.push(strandId); },
    onBlocked: () => { throw new Error('the party manages this strand; nothing should block'); },
  };
  return {
    db: raw.db,
    strandId: raw.strandId,
    oldKey,
    oldPrivateKey,
    newKey: strandMemberKeyPair(newPrivateKey),
    newPrivateKey,
    deps,
    swaps: () => swaps,
    rotated: () => [...rotated],
    failNextSwap: () => { swapFailures += 1; },
  };
}

/**
 * Fail the `failAt`-th membership write batch the way a refused commit reaches the writer (the
 * batch's `exec` rejects and nothing is written); every other batch runs for real. A writer's
 * transaction is one `exec` carrying `{ transaction: true }`, which is what counts as a batch.
 */
function failWriteBatch(db: Database, failAt: number): { batches: () => number } {
  const exec = db.exec.bind(db);
  let batches = 0;
  vi.spyOn(db, 'exec').mockImplementation((sql, params, options) => {
    if (options?.transaction !== true) return exec(sql, params, options);
    batches += 1;
    return batches === failAt ? Promise.reject(new Error(`injected failure at write ${failAt}`)) : exec(sql, params, options);
  });
  return { batches: () => batches };
}

/** The end state every run must reach, however it got there. */
async function expectRotated(fixture: Fixture): Promise<void> {
  const { db, strandId, oldKey, newKey } = fixture;
  expect(await isStrandMember(db, newKey.publicKeyB64)).toBe(true);
  expect(await isStrandManager(db, newKey.publicKeyB64)).toBe(true);
  expect((await listMemberPeers(db, newKey.publicKeyB64)).sort()).toEqual([SELF, ...SIBLINGS].sort());
  expect(await isStrandMember(db, oldKey.publicKeyB64)).toBe(false);
  expect(await isStrandManager(db, oldKey.publicKeyB64)).toBe(false);
  // The removed machine's binding under K is an orphan with no live binding beside it: the
  // revoked-peer gate's deny rule, on the rows alone. Every remaining machine is bound under K'
  // as well, so its binding under K orphans nothing.
  const rows = await readStrandRevocationRows(db);
  expect(rows.memberKeys.has(oldKey.publicKeyB64)).toBe(false);
  expect(rows.bindings).toContainEqual({ memberKey: oldKey.publicKeyB64, peerId: REMOVED });
  expect(rows.bindings.some((binding) => binding.peerId === REMOVED && rows.memberKeys.has(binding.memberKey))).toBe(false);
  // One swap, naming the keys the run started from and arrived at.
  expect(fixture.swaps()).toEqual([[{ strandId, oldKey: fixture.oldPrivateKey, newKey: fixture.newPrivateKey }]]);
  expect(fixture.rotated()).toEqual([strandId]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('party key rotation after a machine removal', () => {
  const crashPoints: (number | 'swap')[] = [0, ...Array.from({ length: WRITE_BATCHES }, (_, index) => index + 1), 'swap'];

  it.each(crashPoints)('reaches the rotated end state, crashing after write %s first', async (crashAt) => {
    const fixture = await rotationFixture();
    const driver = new StrandPartyKeyRotationDriver(fixture.deps);

    if (crashAt === 'swap') {
      fixture.failNextSwap();
      expect(await driver.drive([fixture.strandId], 'test')).toEqual([{ strandId: fixture.strandId, outcome: 'pending' }]);
      // Steps 1 to 5 completed: K is gone from the strand while the control record still names it.
      expect(await isStrandMember(fixture.db, fixture.oldKey.publicKeyB64)).toBe(false);
      expect(fixture.swaps()).toEqual([]);
    } else if (crashAt > 0) {
      const batches = failWriteBatch(fixture.db, crashAt);
      expect(await driver.drive([fixture.strandId], 'test')).toEqual([{ strandId: fixture.strandId, outcome: 'pending' }]);
      expect(batches.batches()).toBe(crashAt);
      vi.restoreAllMocks();
      expect(fixture.swaps()).toEqual([]);
    }

    // The run from wherever the rows are: clean, or after the crash above.
    const counted = failWriteBatch(fixture.db, Number.POSITIVE_INFINITY);
    expect(await driver.drive([fixture.strandId], 'test')).toEqual([{ strandId: fixture.strandId, outcome: 'rotated' }]);
    if (crashAt === 0) {
      expect(counted.batches()).toBe(WRITE_BATCHES);
    }
    await expectRotated(fixture);

    // Nothing is pending any more: a further run writes nothing and swaps nothing.
    vi.restoreAllMocks();
    const idle = failWriteBatch(fixture.db, Number.POSITIVE_INFINITY);
    expect(await driver.drive([fixture.strandId], 'test')).toEqual([{ strandId: fixture.strandId, outcome: 'rotated' }]);
    expect(idle.batches()).toBe(0);
    expect(fixture.swaps()).toHaveLength(1);
  }, 60_000);
});
