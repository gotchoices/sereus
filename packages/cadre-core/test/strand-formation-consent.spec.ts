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
import {
  FormationApprovalError,
  signFormationApproval,
  type FormationApproval,
  type FormationApprovalRequest,
  type FormationApprover,
} from '../src/formation-approval.js';
import { canonicalJson } from '../src/canonical-json.js';
import { StrandFormationManager } from '../src/strand-formation-manager.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { mintContactJoiner, mintContactConsent } from './formation-consent-helper.js';
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
 *
 * Plus the responder-provisions (UNBOUND-invite) path and the missing-host-strand path:
 *  (e) an unbound single-use invite provisions a fresh strand + records one usage, and a
 *      second redemption is rejected (the security regression: the old fallback wrote NO
 *      usage row, so a TotalUses:1 unbound invite was infinitely redeemable),
 *  (f) an unbound multi-use invite provisions distinct strands until TotalUses is exhausted,
 *  (g) a bound invite naming a host strand absent on this responder yields a CLEAN
 *      `approved:false` (no hang, no dropped frame, no usage row, no identity disclosed) —
 *      previously the deferred StrandExists CHECK threw and the stream closed with no frame.
 *
 * Plus the outside-approval path (invite carries a `ValidationUrl`; a fake
 * {@link FormationApprover} is injected so no HTTP leaves the test):
 *  (h) a bound `ValidationUrl` invite obtains an approval and the nonce the approver SIGNED
 *      is the nonce INSERTED (`UsageStampId` read back equals the request the fake saw),
 *      with the real serialized disclosure recorded,
 *  (i) same through the unbound path (`provisionAndRecord` mints the strand),
 *  (j) each approval-failure category maps to its own distinct rejection reason, writes
 *      nothing, and does NOT burn the invite (a good approver redeems it afterwards),
 *  (k) an invite with no `ValidationUrl` never contacts the approver at all,
 *  (l) an oversized disclosure is rejected before the approver or the DB is touched,
 *  (m) a slow (6 s) approver still succeeds inside the 12 s default provisioning budget.
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

async function contactFor(token: string, disclosure: StrandFormationDisclosure = REAL_DISCLOSURE): Promise<FormationContactMessage> {
  const joiner = await mintContactJoiner();
  return {
    token,
    partyId: joiner.partyId,
    ...mintContactConsent(joiner, token, disclosure),
    disclosure,
    cadrePeerAddrs: ['/ip4/127.0.0.1/tcp/1/p2p/initiator'],
  };
}

/**
 * Fake {@link FormationApprover}: records every request it is shown (so tests can assert
 * the approver was / was not contacted, and WHAT nonce it signed) and answers via the
 * supplied function — a real signature, a tampered one, or a thrown
 * {@link FormationApprovalError}. Never parses `validationUrl`; any string works.
 */
function recordingApprover(
  answer: (request: FormationApprovalRequest) => FormationApproval | Promise<FormationApproval>
): FormationApprover & { seen: FormationApprovalRequest[] } {
  const seen: FormationApprovalRequest[] = [];
  return {
    seen,
    async requestApproval(request) {
      seen.push(request);
      return answer(request);
    },
  };
}

const HOST_PARTY = 'host-party';
const HOST_CADRE = ['/ip4/10.0.0.1/tcp/2/p2p/host'];

describe('strand formation consent (provision-then-record, real recorder)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let ownerPrivateKey: string;
  let ownerPublicKey: string;
  let validationPrivateKey: string;
  let validationPublicKey: string;

  // ed25519-sign the raw message bytes (no pre-hash), matching insert* signers.
  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);

  /** Fresh manager wired to a real DB-backed recorder, registered on a captured handler. */
  function responder(approver?: FormationApprover): { invoke: (s: MockStream) => Promise<void> } {
    const manager = new StrandFormationManager({
      formationUsageRecorder: new ControlFormationUsageRecorder(db, approver ? { approver } : undefined),
      partyId: HOST_PARTY,
      cadrePeerAddrs: HOST_CADRE,
    });
    const { node: mock, invoke } = captureHandler();
    manager.registerResponder(mock);
    return { invoke };
  }

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: { partyId: 'formation-consent-' + rand(), bootstrapNodes: [] },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();

    expect(await db.ensureOwnerKey(ownerPublicKey)).toBe(true);

    // Enroll the validation keypair the fake approver signs with — the DB's
    // FormationUsage.Authorized CHECK verifies against this stored row.
    validationPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    validationPublicKey = getPublicKey(validationPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    await db.insertValidationKey(validationPublicKey, ownerPublicKey, signMessage);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('(a) rejects an unknown token without disclosing identity or membership key', async () => {
    const { invoke } = responder();

    const stream = new MockStream([encodeFrame(await contactFor('no-such-' + rand()))]);
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
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, await generateStrandMemberKey());

    const token = 'invite-exp-' + rand();
    await db.insertFormationInvite(token, 'sapp-exp', ownerPublicKey, signMessage, {
      strandId: hostStrandId,
      expiresAtMs: Date.parse('2000-01-01T00:00:00Z'),
    });

    const { invoke } = responder();
    const stream = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(stream);
    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);

    expect(result.approved).toBe(false);
    expect(result.provisionResult).toBeUndefined();
    expect(await db.countFormationUsage(token)).toBe(0);
  });

  it('(b,c,d) records one consent row, returns the host strand + membership key, single-use', async () => {
    // Host pre-creates the closed strand owner-signed, then mints a bound single-use invite.
    const hostStrandId = 'strand-host-' + rand();
    const hostMemberKey = await generateStrandMemberKey();
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, hostMemberKey);

    const token = 'invite-consent-' + rand();
    await db.insertFormationInvite(token, 'sapp-consent', ownerPublicKey, signMessage, {
      totalUses: 1,
      strandId: hostStrandId,
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const { invoke } = responder();

    // First use: approves, returns the REAL strand + key, records exactly one usage row.
    const first = new MockStream([encodeFrame(await contactFor(token))]);
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
    const second = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(second);
    const rejected = decodeFirstFrame<FormationResultMessage>(second.sent);

    expect(rejected.approved).toBe(false);
    expect(rejected.reason).toBe('Invalid token');
    expect(rejected.provisionResult).toBeUndefined();
    expect(rejected.partyId).toBeUndefined();
    expect(await db.countFormationUsage(token)).toBe(1);
  });

  it('(e) unbound single-use: provisions a fresh strand, records one usage, rejects reuse', async () => {
    // UNBOUND invite (no strandId) → responder-provisions path through provisionAndRecord.
    const token = 'invite-unbound-1use-' + rand();
    await db.insertFormationInvite(token, 'sapp-unbound', ownerPublicKey, signMessage, {
      totalUses: 1,
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const { invoke } = responder();

    // First use: approves, mints a fresh responder-provisioned strand, records one usage row.
    const first = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(first);
    const ok = decodeFirstFrame<FormationResultMessage>(first.sent);

    expect(ok.approved).toBe(true);
    expect(ok.partyId).toBe(HOST_PARTY);
    expect(ok.cadrePeerAddrs).toEqual(HOST_CADRE);
    const mintedId = ok.provisionResult?.strand.strandId;
    expect(mintedId).toBeDefined();
    expect(mintedId!.length).toBeGreaterThan('strand-'.length);
    expect(ok.provisionResult?.strand.createdBy).toBe('responder');
    // An unbound responder-provisioned strand is open → no membership key disclosed.
    expect(ok.provisionResult?.memberPrivateKey).toBeUndefined();

    // Exactly one usage row, and a Strand row now exists for the minted id.
    expect(await db.countFormationUsage(token)).toBe(1);
    expect(await db.queryStrand(mintedId!)).not.toBeNull();

    // Second use of the single-use invite is rejected and writes NO extra row
    // (the security regression: the old fallback never recorded usage, so this re-approved).
    const second = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(second);
    const rejected = decodeFirstFrame<FormationResultMessage>(second.sent);

    expect(rejected.approved).toBe(false);
    expect(rejected.reason).toBe('Invalid token');
    expect(rejected.provisionResult).toBeUndefined();
    expect(await db.countFormationUsage(token)).toBe(1);
  });

  it('(f) unbound multi-use: provisions distinct strands until TotalUses is exhausted', async () => {
    const token = 'invite-unbound-2use-' + rand();
    await db.insertFormationInvite(token, 'sapp-unbound-multi', ownerPublicKey, signMessage, {
      totalUses: 2,
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const { invoke } = responder();

    const first = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(first);
    const r1 = decodeFirstFrame<FormationResultMessage>(first.sent);

    const second = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(second);
    const r2 = decodeFirstFrame<FormationResultMessage>(second.sent);

    expect(r1.approved).toBe(true);
    expect(r2.approved).toBe(true);
    const id1 = r1.provisionResult?.strand.strandId;
    const id2 = r2.provisionResult?.strand.strandId;
    // Two distinct freshly-minted strand ids, two usage rows.
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
    expect(await db.countFormationUsage(token)).toBe(2);

    // UseNumbers are the sequential 1 and 2 across the two minted strands.
    const u1 = await rawDb.get('select UseNumber from CadreControl.FormationUsage where Token = ? and StrandId = ?', [token, id1!]);
    const u2 = await rawDb.get('select UseNumber from CadreControl.FormationUsage where Token = ? and StrandId = ?', [token, id2!]);
    expect(new Set([u1?.UseNumber, u2?.UseNumber])).toEqual(new Set([1, 2]));

    // Third use exhausts the invite.
    const third = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(third);
    const r3 = decodeFirstFrame<FormationResultMessage>(third.sent);
    expect(r3.approved).toBe(false);
    expect(r3.reason).toBe('Invalid token');
    expect(await db.countFormationUsage(token)).toBe(2);
  });

  it('(g) bound + missing strand: clean rejection, no dropped frame, no usage row, no disclosure', async () => {
    // The invite binds a strand id that was NEVER inserted as a Strand row (an
    // unconverged host). Previously the responder tried to record usage, the deferred
    // StrandExists CHECK threw, and the stream closed WITHOUT a result frame.
    const missingStrandId = 'strand-never-inserted-' + rand();
    const token = 'invite-missing-' + rand();
    await db.insertFormationInvite(token, 'sapp-missing', ownerPublicKey, signMessage, {
      totalUses: 1,
      strandId: missingStrandId,
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const { invoke } = responder();
    const stream = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(stream);

    // A result frame IS written (no hang/drop), and it is a clean non-disclosing rejection.
    expect(stream.sent.length).toBeGreaterThan(0);
    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Host strand not yet available on this responder');
    expect(result.partyId).toBeUndefined();
    expect(result.cadrePeerAddrs).toBeUndefined();
    expect(result.provisionResult).toBeUndefined();

    // No usage row written, so a retry after convergence is not blocked.
    expect(await db.countFormationUsage(token)).toBe(0);
  });

  it('(h) bound ValidationUrl invite: nonce signed = nonce inserted, real disclosure recorded', async () => {
    const hostStrandId = 'strand-host-vu-' + rand();
    const hostMemberKey = await generateStrandMemberKey();
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, hostMemberKey);

    const token = 'invite-vu-bound-' + rand();
    await db.insertFormationInvite(token, 'sapp-vu', ownerPublicKey, signMessage, {
      totalUses: 1,
      strandId: hostStrandId,
      validationUrl: 'https://hook.example/approve',
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const approver = recordingApprover((req) =>
      signFormationApproval(req, validationPublicKey, validationPrivateKey));
    const { invoke } = responder(approver);

    const stream = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(stream);
    const ok = decodeFirstFrame<FormationResultMessage>(stream.sent);

    // Redemption succeeds and still carries the host strand + its membership key.
    expect(ok.approved).toBe(true);
    expect(ok.provisionResult?.strand.strandId).toBe(hostStrandId);
    expect(ok.provisionResult?.memberPrivateKey).toBe(hostMemberKey);

    // The approver was asked exactly once, and was handed the invite's hook URL.
    expect(approver.seen.length).toBe(1);
    expect(approver.seen[0].validationUrl).toBe('https://hook.example/approve');

    expect(await db.countFormationUsage(token)).toBe(1);
    const usage = await rawDb.get(
      'select UsageStampId, Disclosure from CadreControl.FormationUsage where Token = ?',
      [token],
    );
    // The single most important invariant: the nonce the approver SIGNED is the nonce INSERTED.
    expect(usage?.UsageStampId).toBe(approver.seen[0].usageStampId);
    // The recorded disclosure is the exact serialized text the approver signed over.
    expect(usage?.Disclosure).toBe(canonicalJson(REAL_DISCLOSURE));
    expect(approver.seen[0].disclosure).toBe(canonicalJson(REAL_DISCLOSURE));
  });

  it('(i) unbound ValidationUrl invite: approval flows through provisionAndRecord, strand minted', async () => {
    const token = 'invite-vu-unbound-' + rand();
    await db.insertFormationInvite(token, 'sapp-vu-unbound', ownerPublicKey, signMessage, {
      totalUses: 1,
      validationUrl: 'https://hook.example/approve-unbound',
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const approver = recordingApprover((req) =>
      signFormationApproval(req, validationPublicKey, validationPrivateKey));
    const { invoke } = responder(approver);

    const stream = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(stream);
    const ok = decodeFirstFrame<FormationResultMessage>(stream.sent);

    expect(ok.approved).toBe(true);
    const mintedId = ok.provisionResult?.strand.strandId;
    expect(mintedId).toBeDefined();
    expect(await db.queryStrand(mintedId!)).not.toBeNull();

    expect(approver.seen.length).toBe(1);
    expect(await db.countFormationUsage(token)).toBe(1);
    const usage = await rawDb.get(
      'select UsageStampId, StrandId from CadreControl.FormationUsage where Token = ?',
      [token],
    );
    expect(usage?.UsageStampId).toBe(approver.seen[0].usageStampId);
    expect(usage?.StrandId).toBe(mintedId);
    // The approver signed over the strand id that was actually minted + recorded.
    expect(approver.seen[0].strandId).toBe(mintedId);
  });

  it('(j) approval failures map to distinct reasons, write nothing, and do not burn the invite', async () => {
    const hostStrandId = 'strand-host-vu-fail-' + rand();
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, await generateStrandMemberKey());

    const token = 'invite-vu-fail-' + rand();
    await db.insertFormationInvite(token, 'sapp-vu-fail', ownerPublicKey, signMessage, {
      totalUses: 1,
      strandId: hostStrandId,
      validationUrl: 'https://hook.example/flaky',
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    // A valid keypair that was never enrolled as a ValidationKey row.
    const strayPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    const strayPublicKey = getPublicKey(strayPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    const scenarios: Array<{ label: string; approver: FormationApprover; reason: string }> = [
      {
        label: 'refused',
        approver: recordingApprover(() => { throw new FormationApprovalError('refused', 'hook said no'); }),
        reason: 'Formation approval refused',
      },
      {
        label: 'unavailable',
        approver: recordingApprover(() => { throw new FormationApprovalError('unavailable', 'hook down'); }),
        reason: 'Formation approval unavailable, retry',
      },
      {
        label: 'misconfigured',
        approver: recordingApprover(() => { throw new FormationApprovalError('misconfigured', 'bad url'); }),
        reason: 'Formation approval misconfigured',
      },
      {
        label: 'invalid signature (signed over tampered fields)',
        approver: recordingApprover((req) =>
          signFormationApproval({ ...req, peerKey: 'tampered-' + req.peerKey }, validationPublicKey, validationPrivateKey)),
        reason: 'Formation approval invalid',
      },
      {
        label: 'non-enrolled key (valid signature, unknown key)',
        approver: recordingApprover((req) =>
          signFormationApproval(req, strayPublicKey, strayPrivateKey)),
        reason: 'Formation approval key is not enrolled',
      },
    ];

    for (const { label, approver, reason } of scenarios) {
      const { invoke } = responder(approver);
      const stream = new MockStream([encodeFrame(await contactFor(token))]);
      await invoke(stream);
      const result = decodeFirstFrame<FormationResultMessage>(stream.sent);

      expect(result.approved, label).toBe(false);
      expect(result.reason, label).toBe(reason);
      // A rejection discloses nothing.
      expect(result.partyId, label).toBeUndefined();
      expect(result.provisionResult, label).toBeUndefined();
      // No usage row → the use count is unchanged, the invite is not consumed.
      expect(await db.countFormationUsage(token), label).toBe(0);
    }

    // The five failures burned nothing: the SAME single-use invite still redeems cleanly.
    const good = recordingApprover((req) =>
      signFormationApproval(req, validationPublicKey, validationPrivateKey));
    const { invoke } = responder(good);
    const stream = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(stream);
    const ok = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(ok.approved).toBe(true);
    expect(await db.countFormationUsage(token)).toBe(1);
  });

  it('(k) invite without ValidationUrl: approver never contacted, real disclosure still recorded', async () => {
    const hostStrandId = 'strand-host-novu-' + rand();
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, await generateStrandMemberKey());

    const token = 'invite-novu-' + rand();
    await db.insertFormationInvite(token, 'sapp-novu', ownerPublicKey, signMessage, {
      totalUses: 1,
      strandId: hostStrandId,
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const approver = recordingApprover((req) =>
      signFormationApproval(req, validationPublicKey, validationPrivateKey));
    const { invoke } = responder(approver);

    const stream = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(stream);
    const ok = decodeFirstFrame<FormationResultMessage>(stream.sent);

    expect(ok.approved).toBe(true);
    // No ValidationUrl on the invite → the approver is never asked.
    expect(approver.seen.length).toBe(0);
    // Every redemption now records the real serialized disclosure (was '' before this wiring).
    const usage = await rawDb.get(
      'select Disclosure from CadreControl.FormationUsage where Token = ?',
      [token],
    );
    expect(usage?.Disclosure).toBe(canonicalJson(REAL_DISCLOSURE));
  });

  it('(l) oversized disclosure: rejected before the approver or the database is touched', async () => {
    const hostStrandId = 'strand-host-big-' + rand();
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, await generateStrandMemberKey());

    const token = 'invite-big-' + rand();
    await db.insertFormationInvite(token, 'sapp-big', ownerPublicKey, signMessage, {
      totalUses: 1,
      strandId: hostStrandId,
      validationUrl: 'https://hook.example/never-reached',
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    const approver = recordingApprover((req) =>
      signFormationApproval(req, validationPublicKey, validationPrivateKey));
    const { invoke } = responder(approver);

    // Over the 8 KiB serialized cap.
    const oversized: StrandFormationDisclosure = { partyId: 'initiator-key', purpose: 'x'.repeat(9000) };
    const stream = new MockStream([encodeFrame(await contactFor(token, oversized))]);
    await invoke(stream);
    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Disclosure too large');
    expect(approver.seen.length).toBe(0);
    expect(await db.countFormationUsage(token)).toBe(0);
  });

  it('(m) slow (6 s) approver still succeeds inside the default provisioning budget', async () => {
    const hostStrandId = 'strand-host-slow-' + rand();
    const hostMemberKey = await generateStrandMemberKey();
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, hostMemberKey);

    const token = 'invite-slow-' + rand();
    await db.insertFormationInvite(token, 'sapp-slow', ownerPublicKey, signMessage, {
      totalUses: 1,
      strandId: hostStrandId,
      validationUrl: 'https://hook.example/slow',
      expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });

    // 6 s of REAL wall-clock: under the approval client's 10 s and the responder's 12 s
    // provisioning budget (see strand-formation-protocol.ts ordering rationale).
    const approver = recordingApprover(async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return signFormationApproval(req, validationPublicKey, validationPrivateKey);
    });
    const { invoke } = responder(approver);

    const stream = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(stream);
    const ok = decodeFirstFrame<FormationResultMessage>(stream.sent);

    expect(ok.approved).toBe(true);
    expect(ok.provisionResult?.strand.strandId).toBe(hostStrandId);
    expect(await db.countFormationUsage(token)).toBe(1);
  }, 40_000);

  it('(n) rejects invalid joiner consent without burning the invite', async () => {
    const hostStrandId = 'strand-host-badconsent-' + rand();
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, await generateStrandMemberKey());
    const token = 'invite-badconsent-' + rand();
    await db.insertFormationInvite(token, 'sapp-badconsent', ownerPublicKey, signMessage, {
      totalUses: 1, strandId: hostStrandId, expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });
    const { invoke } = responder();

    const good = await contactFor(token);
    const otherJoiner = await mintContactJoiner();
    const badContacts: Array<[string, FormationContactMessage]> = [
      ['tampered peerSignature', { ...good, peerSignature: (good.peerSignature[0] === 'A' ? 'B' : 'A') + good.peerSignature.slice(1) }],
      ['partyId of a different joiner', { ...good, partyId: otherJoiner.partyId }],
      ['garbage peerKey', { ...good, peerKey: 'garbage-not-32-bytes' }],
    ];
    for (const [label, bad] of badContacts) {
      const stream = new MockStream([encodeFrame(bad)]);
      await invoke(stream);
      const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
      expect(result.approved, label).toBe(false);
      expect(result.reason, label).toBe('Invalid joiner consent');
      expect(result.partyId, label).toBeUndefined();
      expect(result.provisionResult, label).toBeUndefined();
      expect(await db.countFormationUsage(token), label).toBe(0);
    }

    // Nothing burned: the same single-use invite still redeems with a well-formed contact.
    const stream = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(stream);
    expect(decodeFirstFrame<FormationResultMessage>(stream.sent).approved).toBe(true);
    expect(await db.countFormationUsage(token)).toBe(1);
  });

  it('(o) joiner nonce reuse is a retryable conflict; a fresh nonce then succeeds', async () => {
    const hostStrandId = 'strand-host-noncereuse-' + rand();
    await db.insertStrand(hostStrandId, 'c', ownerPublicKey, signMessage, await generateStrandMemberKey());
    const token = 'invite-noncereuse-' + rand();
    await db.insertFormationInvite(token, 'sapp-noncereuse', ownerPublicKey, signMessage, {
      totalUses: 2, strandId: hostStrandId, expiresAtMs: Date.now() + 365 * 24 * 3600_000,
    });
    const { invoke } = responder();
    const contact = await contactFor(token);

    const first = new MockStream([encodeFrame(contact)]);
    await invoke(first);
    expect(decodeFirstFrame<FormationResultMessage>(first.sent).approved).toBe(true);
    expect(await db.countFormationUsage(token)).toBe(1);

    // Same contact again: UsageStampId is unique, the insert fails → retryable conflict.
    const second = new MockStream([encodeFrame(contact)]);
    await invoke(second);
    const conflict = decodeFirstFrame<FormationResultMessage>(second.sent);
    expect(conflict.approved).toBe(false);
    expect(conflict.reason).toBe('Formation conflict, retry');
    expect(conflict.partyId).toBeUndefined();
    expect(await db.countFormationUsage(token)).toBe(1);

    // A fresh joiner/nonce for the same token succeeds — the conflicted use was not spent.
    const third = new MockStream([encodeFrame(await contactFor(token))]);
    await invoke(third);
    expect(decodeFirstFrame<FormationResultMessage>(third.sent).approved).toBe(true);
    expect(await db.countFormationUsage(token)).toBe(2);
  });
});
