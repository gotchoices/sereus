import { describe, it, expect } from 'vitest';
import type { WriteDurability } from '@optimystic/db-core';
import type { SqlCommitDurability } from '@serfab/quereus-plugin-sereus';
import { StrandCommitRecord } from '../src/strand-commit-durability.js';
import type { PartyStrandPeer } from '../src/strand-party-peers.js';

/** docs/strands.md → "A commit's durability": which of the party's machines a commit is reported as waiting for. */

const SELF = 'self-strand';
// The control and strand ids differ: a durability report names peers by their strand id.
const A: PartyStrandPeer = { peerId: 'a-control', strandPeerId: 'a-strand' };

function report(overall: WriteDurability | undefined): SqlCommitDurability {
  return { transactionId: 'tx', durability: { collections: new Map(), overall }, tables: new Map(), followed: true };
}

const local = { quorum: 'local', confirmed: 1 } as const;

describe('StrandCommitRecord awaitedMachines', () => {
  it.each<[string, WriteDurability | undefined, PartyStrandPeer[], boolean, PartyStrandPeer[]]>([
    ['alone, the machine not in the cohort', { ...local, cohort: 1, cohortPeerIds: [SELF] }, [A], false, [A]],
    ['alone, the machine owed by name', { ...local, cohort: 2, cohortPeerIds: [SELF], unconfirmed: [A.strandPeerId] }, [A], false, [A]],
    ['held by the machine', { quorum: 'majority', confirmed: 2, cohort: 2, cohortPeerIds: [SELF, A.strandPeerId], unconfirmed: [] }, [A], true, []],
    ['cohort unknown', undefined, [A], false, [A]],
    ['a cadre of one', { ...local, cohort: 1, cohortPeerIds: [SELF] }, [], false, []]
  ])('%s', (_case, overall, machines, heldElsewhere, awaitedMachines) => {
    const record = new StrandCommitRecord('s', {}, () => machines);
    record.reportCommit(report(overall));
    expect(record.get('tx')).toMatchObject({ heldElsewhere, awaitedMachines });
  });
});
