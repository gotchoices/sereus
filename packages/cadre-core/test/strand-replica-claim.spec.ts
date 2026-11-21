import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { StrandInstanceManager, type StartStrandConfig } from '../src/strand-instance-manager.js';
import type { StrandRow } from '../src/types.js';
import { signedSApp } from './signed-sapp.js';
import { AppSchemaRefusedError } from '@serfab/quereus-plugin-sereus';

/** A schema the plugin refuses whatever the node holds: Sereus applies no seed rows to a strand. */
const SEED_SCHEMA = `table Role (Name text primary key); seed Role (('admin'));`;
/** `signedSApp`'s `Note` table plus a `not null` column with no default: refused once `Note` has rows. */
const NOT_NULL_ADDED_SCHEMA = 'table Note (Id text primary key, At text not null);';

/**
 * **What this protects: claiming a strand this node already hosts as a storage replica**
 * (`StrandInstanceManager.attachSApp`, called by `CadreNode` before any founding).
 *
 * A server node runs unclaimed strands with no sApp config: the `Strand` schema,
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
    const strandRow: StrandRow = { Id: 'replica-claimed', MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null };

    // The claim lands while the replica's runtime is still being built, so the attach must
    // wait for the build and act on the database it produced.
    const launching = manager.startStrand({ strandRow, nodeClass: 'server', defaultLatencyHint: 'interactive' });
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

  // A refused schema must not stay in the retained launch config: every later rebuild would
  // apply it again and leave the replica in `'error'` with no database until a restart.
  it.each([
    ['live', false],
    ['quiesced', true],
  ])('refuses a claim with a schema that can never apply on a %s replica, and the replica still resumes', async (_state, quiesceFirst) => {
    manager = new StrandInstanceManager();
    const strandRow: StrandRow = { Id: `replica-refused-${String(quiesceFirst)}`, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null };
    const instance = await manager.startStrand({ strandRow, nodeClass: 'server', defaultLatencyHint: 'interactive' });
    if (quiesceFirst) {
      await manager.quiesceStrand(strandRow.Id);
    }

    await expect(manager.attachSApp(strandRow.Id, signedSApp({ schema: SEED_SCHEMA }))).rejects.toBeInstanceOf(AppSchemaRefusedError);
    expect(instance.sAppInfo).toBeUndefined();

    if (!quiesceFirst) {
      await manager.quiesceStrand(strandRow.Id);
    }
    await manager.resumeStrand(strandRow.Id);
    expect(instance.status).not.toBe('error');
    expect(instance.libp2pNode).toBeDefined();
  });

  // A refusal by the strand's rows passes the claim-time check, so on a quiesced replica only the
  // next build meets it, after the claim resolved; that build must fall back to the replica.
  it.each([
    ['live', false],
    ['quiesced', true],
  ])('runs the replica again when its rows refuse a claim\'s schema on a %s replica', async (_state, quiesceFirst) => {
    manager = new StrandInstanceManager();
    const strandRow: StrandRow = { Id: `replica-rows-refuse-${String(quiesceFirst)}`, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null };
    // One store and transport key for every launch, so the replica hydrates the founder's catalog and row.
    const storage = new MemoryRawStorage();
    const privateKey = await generateKeyPair('Ed25519');
    const launch = (overrides: Partial<StartStrandConfig>): StartStrandConfig =>
      ({ strandRow, nodeClass: 'server', defaultLatencyHint: 'interactive', storage: { provider: () => storage }, privateKey, ...overrides });

    const founded = await manager.startStrand(launch({ sAppConfig: signedSApp(), founder: true }));
    await founded.database!.getDatabase().exec(`insert into App.Note (Id) values ('n1')`);
    await manager.stopStrand(strandRow.Id);
    const instance = await manager.startStrand(launch({}));
    if (quiesceFirst) {
      await manager.quiesceStrand(strandRow.Id);
    }

    const claim = manager.attachSApp(strandRow.Id, signedSApp({ schema: NOT_NULL_ADDED_SCHEMA }));
    if (quiesceFirst) {
      await expect(claim).resolves.toBe('attached');
    } else {
      await expect(claim).rejects.toBeInstanceOf(AppSchemaRefusedError);
      await manager.quiesceStrand(strandRow.Id);
    }
    await manager.resumeStrand(strandRow.Id);
    expect(instance.status).not.toBe('error');
    expect(instance.sAppInfo).toBeUndefined();
    expect(await instance.database!.getDatabase().get('select count(1) as c from App.Note')).toEqual({ c: 1 });
  });
});
