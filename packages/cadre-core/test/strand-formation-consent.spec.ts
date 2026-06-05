import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { ControlFormationUsageRecorder } from '../src/control-formation-recorder.js';
import { StrandFormationManager } from '../src/strand-formation-manager.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import type {
  FormationContactMessage,
  FormationResultMessage,
} from '../src/strand-formation-protocol.js';
import type { StrandFormationDisclosure } from '../src/types.js';

/**
 * Provision-then-record consent round-trip, driven through the REAL responder stack:
 * a {@link StrandFormationManager} wired to a real {@link ControlFormationUsageRecorder}
 * over an in-memory control DB, against a pre-existing closed strand + a bound invite.
 *
 * Drives the manager's libp2p handler directly with an in-memory stream (the captured
 * handler + MockStream below), so the assertions are on the DB effects + the on-wire
 * `FormationResultMessage` — NOT a two-node libp2p leg (that stays in integration-tests,
 * which is not agent-runnable). The same protocol path runs in both.
 *
 * Asserts a responder session:
 *  (a) rejects an unknown/expired token without disclosing the membership key,
 *  (b) writes EXACTLY ONE FormationUsage row keyed to the host strand,
 *  (c) returns the host's real strandId AND its memberPrivateKey in the result, and
 *  (d) is single-use: a second use of a TotalUses:1 invite is rejected and writes no row.
 */

// ── Frame helpers (mirror the on-wire 4-byte big-endian length prefix) ─────────

function encodeFrame(obj: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** Decode the first length-prefixed frame from concatenated sent chunks. */
function decodeFirstFrame<T>(chunks: Uint8Array[]): T {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  const length = new DataView(all.buffer, all.byteOffset, all.byteLength).getUint32(0, false);
  return JSON.parse(new TextDecoder().decode(all.subarray(4, 4 + length))) as T;
}

/**
 * Minimal in-memory libp2p stream: yields the supplied inbound frames to the
 * reader and records everything the listener writes back via `send()`.
 */
class MockStream {
  readonly sent: Uint8Array[] = [];
  closed = false;
  constructor(private readonly inbound: Uint8Array[]) {}
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (const chunk of this.inbound) yield chunk;
  }
  send(data: Uint8Array): boolean { this.sent.push(data); return true; }
  async close(): Promise<void> { this.closed = true; }
  abort(): void {}
}

/** A mock node that captures the registered protocol handler so we can drive it directly. */
function captureHandler(): { node: Libp2p; invoke: (stream: MockStream) => Promise<void> } {
  let handler: ((stream: unknown, conn: unknown) => Promise<void>) | undefined;
  const node = {
    handle: (_id: string, fn: (stream: unknown, conn: unknown) => Promise<void>) => { handler = fn; },
    unhandle: () => {}
  } as unknown as Libp2p;
  return {
    node,
    invoke: async (stream: MockStream) => {
      if (!handler) throw new Error('handler not registered');
      await handler(stream, {});
    }
  };
}

const REAL_DISCLOSURE: StrandFormationDisclosure = { partyId: 'initiator-key', purpose: 'consent-test' };

function contactFor(token: string): FormationContactMessage {
  return {
    token,
    partyId: 'initiator-key',
    disclosure: REAL_DISCLOSURE,
    cadrePeerAddrs: ['/ip4/127.0.0.1/tcp/1/p2p/initiator'],
  };
}

const HOST_PARTY = 'host-party';
const HOST_CADRE = ['/ip4/10.0.0.1/tcp/2/p2p/host'];

describe('strand formation consent (provision-then-record, real recorder)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let authorityPrivateKey: string;
  let authorityPublicKey: string;

  // ed25519-sign the raw message bytes (no pre-hash), matching insert* signers.
  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, authorityPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);

  /** Fresh manager wired to a real DB-backed recorder, registered on a captured handler. */
  function responder(): { invoke: (s: MockStream) => Promise<void> } {
    const manager = new StrandFormationManager({
      formationUsageRecorder: new ControlFormationUsageRecorder(db),
      partyId: HOST_PARTY,
      cadrePeerAddrs: HOST_CADRE,
    });
    const { node: mock, invoke } = captureHandler();
    manager.registerResponder(mock);
    return { invoke };
  }

  beforeAll(async () => {
    authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorityPublicKey = getPublicKey(authorityPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: { partyId: 'formation-consent-' + rand(), bootstrapNodes: [] },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();

    expect(await db.ensureAuthorityKey(authorityPublicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('(a) rejects an unknown token without disclosing identity or membership key', async () => {
    const { invoke } = responder();

    const stream = new MockStream([encodeFrame(contactFor('no-such-' + rand()))]);
    await invoke(stream);
    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Invalid token');
    expect(result.partyId).toBeUndefined();
    expect(result.cadrePeerAddrs).toBeUndefined();
    expect(result.provisionResult).toBeUndefined();
  });

  it('(a) rejects an expired token (no disclosure, no usage row)', async () => {
    const hostStrandId = 'strand-host-exp-' + rand();
    await db.insertStrand(hostStrandId, 'c', authorityPublicKey, signMessage, await generateStrandMemberKey());

    const token = 'invite-exp-' + rand();
    await db.insertFormationInvite(token, 'sapp-exp', authorityPublicKey, signMessage, {
      strandId: hostStrandId,
      expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
    });

    const { invoke } = responder();
    const stream = new MockStream([encodeFrame(contactFor(token))]);
    await invoke(stream);
    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);

    expect(result.approved).toBe(false);
    expect(result.provisionResult).toBeUndefined();
    expect(await db.countFormationUsage(token)).toBe(0);
  });

  it('(b,c,d) records one consent row, returns the host strand + membership key, single-use', async () => {
    // Host pre-creates the closed strand authority-signed, then mints a bound single-use invite.
    const hostStrandId = 'strand-host-' + rand();
    const hostMemberKey = await generateStrandMemberKey();
    await db.insertStrand(hostStrandId, 'c', authorityPublicKey, signMessage, hostMemberKey);

    const token = 'invite-consent-' + rand();
    await db.insertFormationInvite(token, 'sapp-consent', authorityPublicKey, signMessage, {
      totalUses: 1,
      strandId: hostStrandId,
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const { invoke } = responder();

    // First use: approves, returns the REAL strand + key, records exactly one usage row.
    const first = new MockStream([encodeFrame(contactFor(token))]);
    await invoke(first);
    const ok = decodeFirstFrame<FormationResultMessage>(first.sent);

    expect(ok.approved).toBe(true);
    expect(ok.partyId).toBe(HOST_PARTY);
    expect(ok.cadrePeerAddrs).toEqual(HOST_CADRE);
    // (c) the host's ACTUAL strand + its membership key, delivered through the protocol.
    expect(ok.provisionResult?.strand.strandId).toBe(hostStrandId);
    expect(ok.provisionResult?.strand.createdBy).toBe('responder');
    expect(ok.provisionResult?.memberPrivateKey).toBe(hostMemberKey);

    // (b) exactly one FormationUsage row, keyed to the host strand.
    expect(await db.countFormationUsage(token)).toBe(1);
    const usage = await rawDb.get(
      'select StrandId, UseNumber from CadreControl.FormationUsage where Token = ?',
      [token],
    );
    expect(usage?.StrandId).toBe(hostStrandId);
    expect(usage?.UseNumber).toBe(1);

    // (d) second use of the single-use invite is rejected, and writes NO extra row.
    const second = new MockStream([encodeFrame(contactFor(token))]);
    await invoke(second);
    const rejected = decodeFirstFrame<FormationResultMessage>(second.sent);

    expect(rejected.approved).toBe(false);
    expect(rejected.reason).toBe('Invalid token');
    expect(rejected.provisionResult).toBeUndefined();
    expect(rejected.partyId).toBeUndefined();
    expect(await db.countFormationUsage(token)).toBe(1);
  });
});
