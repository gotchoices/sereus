import { describe, it, expect, afterEach } from 'vitest';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import type { StrandRow } from '../src/types.js';
import { signedSApp } from './signed-sapp.js';

/**
 * **What this protects: claiming a strand this node already hosts as a storage replica**
 * (`StrandInstanceManager.attachSApp`, called by `CadreNode` before any founding).
 *
 * A storage-profile node runs unclaimed strands with no sApp config: the `Strand` schema,
 * no `App` tables. When an app on the same machine claims one — including as its founder,
 * after a restart where the watcher's replica launch won the race — the running replica
 * must gain the app's tables over the SAME node and store, and a founding that follows must
 * write the sApp into `Strand.Header`. Real libp2p node + StrandDatabase, solo (the network
 * transactor self-coordinates at a cohort of one), so the replica comes up `'syncing'` with
 * its database held by the first-sync gate — the state a replica that has not reached a
 * member yet is in.
 */
describe('claiming a hosted storage replica', () => {
  let manager: StrandInstanceManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.stopAll();
      manager = null;
    }
  });

  it('attaches the app schema in place during the replica launch, then founds it with the sApp in the Header', async () => {
    manager = new StrandInstanceManager();
    const sApp = signedSApp();
    const strandRow: StrandRow = { Id: 'replica-claimed', MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null };

    // The claim lands while the replica's runtime is still being built, so the attach must
    // wait for the build and act on the database it produced.
    const launching = manager.startStrand({ strandRow, profile: 'storage', defaultLatencyHint: 'interactive' });
    const attaching = manager.attachSApp(strandRow.Id, sApp);
    const instance = await launching;
    const node = instance.libp2pNode;
    expect(node).toBeDefined();
    await expect(attaching).resolves.toBe('attached');
    await expect(manager.foundExistingStrand(strandRow.Id)).resolves.toBe('bootstrapped');

    expect(instance.status).toBe('active');
    expect(instance.sAppInfo?.id).toBe(sApp.id);
    // No rebuild: the node the replica launched with is the one still serving the strand.
    expect(instance.libp2pNode).toBe(node);

    const db = instance.database!.getDatabase();
    await db.exec(`insert into App.Note (Id) values ('n1')`);
    expect(await db.get('select count(1) as c from App.Note')).toEqual({ c: 1 });
    const header = await db.get('select sAppId, sAppVersion from Strand.Header');
    expect(header).toEqual({ sAppId: sApp.id, sAppVersion: sApp.version });
  });
});
