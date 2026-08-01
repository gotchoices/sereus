import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { generatePrivateKey, getPublicKey, sign as cryptoSign } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { signSchema } from '../src/schema-verification.js';
import type { ControlDatabase } from '../src/control-database.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { StrandConfig, StrandFilter } from '../src/types.js';

/**
 * Exercises the node-level strand removal surface — `unpublishStrand`, the owner-signed
 * party-wide inverse of `publishStrand` — plus the error shape of the renamed local-only
 * `stopStrand`.
 *
 * The DB-level `deleteStrand` writer and its authorization/replay defences are covered by
 * `control-authorization-binding.spec.ts` and `control-revocation-replay.spec.ts` (non-owner
 * signer refused, add-approval replay refused, tombstone transactionality). This pins the
 * wrapper: it self-signs with the node's own owner key, the row and its tombstone land,
 * blank input is refused before any write, a closed strand's `MemberPrivateKey` dies with
 * the row, the id is NOT blacklisted for owner re-publish, and the local instance is
 * stopped by the time the promise resolves.
 *
 * The last two tests cover the OTHER side of the same party-wide contract: a node that did
 * not issue the removal and learns of it only by seeing the `Strand` row missing on its own
 * next `StrandWatcher` poll (`StrandWatcher.poll` → `onStrandRemoved` →
 * `CadreNode.handleStrandRemoved`). That branch is never reached through `unpublishStrand`,
 * which force-stops the local instance itself. They stand in for a sibling without a second
 * machine, by deleting the row out from under a single running node with a direct
 * `ControlDatabase.deleteStrand`; whether the deletion actually becomes VISIBLE to a real
 * second node over the network is a separate, cross-machine question covered elsewhere.
 *
 * Boots a self-signing node the way `validation-key-enrollment.spec.ts` does: the node's
 * libp2p key IS its owner key, enrolled in `OwnerKey` so its self-signed control writes are
 * authorised.
 */
describe('CadreNode strand unpublish', () => {
  let node: CadreNode | undefined;

  /** Poll interval for the watcher-driven tests: short enough to assert in well under a second. */
  const WATCH_INTERVAL_MS = 200;
  /**
   * "…and it stays that way" window, five polls wide. Derived from the interval on purpose:
   * a future interval bump must not silently turn a real assertion into a vacuous one.
   */
  const QUIET_WINDOW_MS = WATCH_INTERVAL_MS * 5;
  /** Budget for the poll-driven waits — generous; the assertions resolve in a poll or two. */
  const WAIT_BUDGET_MS = 10_000;

  const rand = (): string => Math.random().toString(36).slice(2);

  const quietWindow = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));

  /**
   * Owner keypair each node self-signs with, so a test can drive a control writer directly
   * without `startSelfOwnerNode` having to change its return type.
   */
  const ownerKeys = new WeakMap<CadreNode, Ed25519KeyPair>();

  /**
   * @param overrides - The `CadreNodeConfig` fields the watcher-removal tests need. Both
   *   default to the production values, so existing call sites are unaffected.
   *   NOTE: carry this parameter across when the duplicated copies of this helper are
   *   consolidated into a shared harness (`debt-self-owner-node-test-harness-duplicated`).
   */
  async function startSelfOwnerNode(
    overrides: { strandWatchInterval?: number; strandFilter?: StrandFilter } = {},
  ): Promise<CadreNode> {
    const nodeKey = await generateKeyPair('Ed25519');
    const ownerKey = ed25519KeyPairFromLibp2p(nodeKey);

    const n = new CadreNode({
      controlNetwork: { partyId: 'strand-unpublish-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
      ...(overrides.strandWatchInterval === undefined ? {} : { strandWatchInterval: overrides.strandWatchInterval }),
      ...(overrides.strandFilter === undefined ? {} : { strandFilter: overrides.strandFilter }),
    });
    await n.start();

    const db = n.getControlDatabase();
    expect(db).not.toBeNull();
    await db!.insertOwnerKey(ownerKey.publicKeyB64);
    ownerKeys.set(n, ownerKey);
    return n;
  }

  /**
   * Remove a `Strand` row the way somebody ELSE's removal arrives here: straight through the
   * owner-signed writer, with no local stop. `unpublishStrand` cannot stand in — it
   * force-stops the local instance itself, masking the watcher path under test. What is left
   * is exactly a sibling's state a moment after another party's removal commits: the row is
   * gone from this node's view, its instance is still running, and only the next poll can
   * notice.
   */
  async function deleteStrandRow(n: CadreNode, strandId: string): Promise<boolean> {
    const ownerKey = ownerKeys.get(n);
    if (!ownerKey) throw new Error('deleteStrandRow requires a node started by startSelfOwnerNode');
    return await n.getControlDatabase()!.deleteStrand(
      strandId,
      ownerKey.publicKeyB64,
      // ed25519 over the raw canonical bytes (no pre-hash), as every control writer expects.
      (message: Uint8Array): string =>
        cryptoSign(message, ownerKey.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string,
    );
  }

  function revocationRow(db: ControlDatabase, stampId: string): Promise<Record<string, unknown> | undefined> {
    return db.getDatabase().get(
      'select TableName, RowKey, StampId from CadreControl.Revocation where TableName = ? and StampId = ?',
      ['Strand', stampId],
    );
  }

  /** A full strand config with a real signed sApp schema, for `addStrand`. */
  function createStrandConfig(strandId: string): StrandConfig {
    const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    const schema = 'create table Test (id text primary key);';
    const version = '1.0.0';
    return {
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: {
        id: authorPublicKey,
        version,
        schema,
        signature: signSchema(schema, version, authorPrivateKey),
      },
    };
  }

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('publish → unpublish removes the row and files a Revocation tombstone retiring its stamp', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-unpub-' + rand();

    await node.publishStrand(strandId);
    expect((await db.queryStrands()).map((row) => row.Id)).toEqual([strandId]);

    const stampId = await db.queryStrandStampId(strandId);
    expect(stampId).not.toBeNull();

    await node.unpublishStrand(strandId);

    expect(await db.queryStrands()).toEqual([]);
    const tombstone = await revocationRow(db, stampId!);
    expect(tombstone).toBeDefined();
    expect(tombstone?.RowKey).toBe(strandId);
    expect((await db.queryRevokedStamps('Strand')).has(stampId!)).toBe(true);
  }, 60_000);

  it('unpublishing a never-published id is a silent no-op (no throw, no tombstone)', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;

    await expect(node.unpublishStrand('never-published-' + rand())).resolves.toBeUndefined();

    expect((await db.queryRevokedStamps('Strand')).size).toBe(0);
    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);

  it('rejects an empty or whitespace-only id before any write', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;

    for (const blank of ['', '   ', '\t\n']) {
      await expect(node.unpublishStrand(blank)).rejects.toThrow(/required/i);
    }

    expect(await db.queryStrands()).toEqual([]);
    expect((await db.queryRevokedStamps('Strand')).size).toBe(0);
  }, 60_000);

  it('throws the named error shapes when the node has not been started', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const stopped = new CadreNode({
      controlNetwork: { partyId: 'strand-unpublish-stopped-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });

    // stopStrand keeps its pre-existing local-lifecycle error; unpublishStrand goes
    // through requireOwnerSigningKey and reports the started-guard shape.
    await expect(stopped.stopStrand('any-strand')).rejects.toThrow(/not running/);
    await expect(stopped.unpublishStrand('any-strand')).rejects.toThrow(
      /must be started before attempting to unpublish strand/i,
    );
  });

  it('unpublishing a closed strand destroys the row and its MemberPrivateKey', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-closed-' + rand();
    const memberKey = await generateStrandMemberKey();

    await node.publishStrand(strandId, 'c', memberKey);
    expect(await db.queryStrand(strandId)).toEqual({
      Id: strandId,
      MemberPrivateKey: memberKey,
      Type: 'c',
    });

    await node.unpublishStrand(strandId);

    expect(await db.queryStrand(strandId)).toBeNull();
    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);

  it('re-publishing after unpublish succeeds on a fresh stamp (the id is not blacklisted)', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-republish-' + rand();

    await node.publishStrand(strandId);
    const firstStamp = await db.queryStrandStampId(strandId);
    await node.unpublishStrand(strandId);

    await node.publishStrand(strandId);

    const secondStamp = await db.queryStrandStampId(strandId);
    expect(secondStamp).not.toBeNull();
    expect(secondStamp).not.toBe(firstStamp);
    expect(await revocationRow(db, firstStamp!)).toBeDefined();
    expect((await db.queryStrands()).map((row) => row.Id)).toEqual([strandId]);
  }, 60_000);

  it('stops a locally-running instance by the time the promise resolves, emitting strand:stopped once', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-running-' + rand();

    await node.addStrand(createStrandConfig(strandId));
    await node.publishStrand(strandId);
    expect(node.getStrand(strandId)).toBeDefined();

    const stopped: string[] = [];
    node.on('strand:stopped', ({ strandId: id }) => void stopped.push(id));

    await node.unpublishStrand(strandId);

    // Pins the force-poll + explicit-stop convergence step: no waiting on the 5 s
    // watcher interval — the local instance is gone when unpublishStrand returns.
    expect(node.getStrand(strandId)).toBeUndefined();
    expect(node.getStrands().size).toBe(0);
    expect(await db.queryStrands()).toEqual([]);
    // Exactly once: the watcher's removal path and the explicit stop must not both fire.
    expect(stopped).toEqual([strandId]);
  }, 60_000);

  it('stops a locally-running instance the watcher never tracked (never-published id)', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-unwatched-' + rand();

    // addStrand without publishStrand: no Strand row exists, so the watcher never
    // observes this id and can never fire its removal path. This is the branch the
    // explicit getInstance + stopStrand step in unpublishStrand exists for.
    await node.addStrand(createStrandConfig(strandId));
    expect(node.getStrand(strandId)).toBeDefined();

    const stopped: string[] = [];
    node.on('strand:stopped', ({ strandId: id }) => void stopped.push(id));

    await node.unpublishStrand(strandId);

    expect(node.getStrand(strandId)).toBeUndefined();
    expect(stopped).toEqual([strandId]);
    // Still a control-plane no-op: nothing was published, so nothing is tombstoned.
    expect((await db.queryRevokedStamps('Strand')).size).toBe(0);
  }, 60_000);

  /** Ids seen for each lifecycle event, in order, for the watcher-driven assertions below. */
  function collectStrandEvents(n: CadreNode): {
    discovered: string[];
    stopped: string[];
    errors: string[];
  } {
    const events = { discovered: [] as string[], stopped: [] as string[], errors: [] as string[] };
    n.on('strand:discovered', ({ strandId }) => void events.discovered.push(strandId));
    n.on('strand:stopped', ({ strandId }) => void events.stopped.push(strandId));
    n.on('strand:error', ({ strandId }) => void events.errors.push(strandId));
    return events;
  }

  it('stops a watched instance when the row vanishes from under it (the sibling-side removal path)', async () => {
    node = await startSelfOwnerNode({ strandWatchInterval: WATCH_INTERVAL_MS });
    const db = node.getControlDatabase()!;
    const strandId = 'strand-vanished-' + rand();
    const events = collectStrandEvents(node);

    // Publish FIRST, then wait for `strand:discovered`: that event is the proof the watcher
    // holds the id in `knownStrands`, which is the precondition for its removal path ever
    // firing. A delete that lands before the first successful poll could never fire it, and
    // the test would fail for a reason unrelated to the code under test — hence a gate on the
    // event rather than a sleep.
    await node.publishStrand(strandId);
    await vi.waitFor(() => expect(events.discovered).toEqual([strandId]), { timeout: WAIT_BUDGET_MS, interval: 50 });

    // Only now register the config + launch. Adding first would have the watcher relaunch the
    // strand on discovery and emit a second `strand:started`, muddying the event stream.
    await node.addStrand(createStrandConfig(strandId));
    expect(node.getStrand(strandId)).toBeDefined();

    expect(await deleteStrandRow(node, strandId)).toBe(true);
    expect(await db.queryStrands()).toEqual([]);

    await vi.waitFor(() => expect(events.stopped).toEqual([strandId]), { timeout: WAIT_BUDGET_MS, interval: 50 });
    expect(node.getStrand(strandId)).toBeUndefined();
    expect(node.getStrands().size).toBe(0);

    // Exactly once. `handleStrandRemoved` drops the id from `knownStrands` before invoking the
    // callback, so a repeat is not expected — but a regression here reaches an app as a
    // duplicate shutdown, so assert it across a further quiet window.
    await quietWindow();
    expect(events.stopped).toEqual([strandId]);
    expect(events.errors).toEqual([]);

    // The sApp config went with the strand: a re-publish is DISCOVERED again rather than
    // relaunched. This is what proves `handleStrandRemoved` cleared both `sAppConfigs` and the
    // watcher's `knownStrands`, and that the removal's `Revocation` tombstone is not mistaken
    // for a live row.
    await node.publishStrand(strandId);
    await vi.waitFor(
      () => expect(events.discovered).toEqual([strandId, strandId]),
      { timeout: WAIT_BUDGET_MS, interval: 50 },
    );
    expect(node.getStrand(strandId)).toBeUndefined();
    expect(events.errors).toEqual([]);
  }, 60_000);

  it('keeps running a strand its strandFilter excluded, even after the row vanishes', async () => {
    const strandId = 'strand-filtered-out-' + rand();
    node = await startSelfOwnerNode({
      strandWatchInterval: WATCH_INTERVAL_MS,
      // The `strandId` form rather than `{ mode: 'none' }`: it is the shape a real app uses,
      // and it keeps the test honest about WHICH strand was excluded.
      strandFilter: { mode: 'strandId', strandId: 'strand-watched-instead-' + rand() },
    });
    const events = collectStrandEvents(node);

    // Rejected by the filter, so the watcher never tracks the row — no discovery, ever.
    await node.publishStrand(strandId);
    await quietWindow();
    expect(events.discovered).toEqual([]);

    // An app may still run a strand the watcher was told to ignore.
    await node.addStrand(createStrandConfig(strandId));
    expect(node.getStrand(strandId)).toBeDefined();

    expect(await deleteStrandRow(node, strandId)).toBe(true);
    await quietWindow();

    // Documented consequence, not a defect: a node that opted out of WATCHING a strand also
    // opted out of observing its party-wide removal. Its only stop is a local
    // `stopStrand`/`unpublishStrand` call.
    expect(node.getStrand(strandId)).toBeDefined();
    expect(events.stopped).toEqual([]);
    expect(events.discovered).toEqual([]);
    expect(events.errors).toEqual([]);
  }, 60_000);
});
