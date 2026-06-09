import { describe, it, expect } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import {
  FormationListener,
  isValidResponderCreatesResult,
  type FormationContactMessage,
  type FormationResultMessage,
  type FormationListenerOptions,
  type ResponderProvisionOutcome
} from '../src/strand-formation-protocol.js';
import type { StrandFormationDisclosure } from '../src/types.js';

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

const realDisclosure: StrandFormationDisclosure = { partyId: 'initiator-key', purpose: 'real' };
const contact: FormationContactMessage = {
  token: 'invite-real',
  partyId: 'initiator-key',
  disclosure: realDisclosure,
  cadrePeerAddrs: ['/ip4/127.0.0.1/tcp/1/p2p/initiator']
};

const RESPONDER_IDENTITY = {
  partyId: 'responder-secret-id',
  cadrePeerAddrs: ['/ip4/10.0.0.1/tcp/2/p2p/responder']
};

function baseOptions(overrides: Partial<FormationListenerOptions>): {
  options: FormationListenerOptions;
  identityDisclosed: () => boolean;
} {
  let disclosed = false;
  const options: FormationListenerOptions = {
    validateToken: async () => ({ valid: true }),
    validateDisclosure: async () => true,
    provisionStrand: async (): Promise<ResponderProvisionOutcome> => ({
      approved: true,
      result: {
        strand: { strandId: 'strand-ok', createdBy: 'responder' },
        dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
      }
    }),
    getResponderIdentity: () => { disclosed = true; return RESPONDER_IDENTITY; },
    ...overrides
  };
  return { options, identityDisclosed: () => disclosed };
}

// ── Disclosure-timing: the responder cadre must NEVER leak on a rejection ──────

describe('FormationListener disclosure timing (no responder cadre on rejection)', () => {
  it('rejects an invalid token without disclosing responder identity/cadre', async () => {
    const { options, identityDisclosed } = baseOptions({
      validateToken: async () => ({ valid: false })
    });
    const listener = new FormationListener(options);
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Invalid token');
    expect(result.partyId).toBeUndefined();
    expect(result.cadrePeerAddrs).toBeUndefined();
    // The responder identity must not even be read before a token passes.
    expect(identityDisclosed()).toBe(false);
  });

  it('rejects an invalid disclosure without disclosing responder cadre', async () => {
    const { options, identityDisclosed } = baseOptions({
      validateDisclosure: async () => false
    });
    const listener = new FormationListener(options);
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Invalid disclosure');
    expect(result.cadrePeerAddrs).toBeUndefined();
    expect(identityDisclosed()).toBe(false);
  });

  it('rejects over the concurrency cap without disclosing responder cadre', async () => {
    const { options, identityDisclosed } = baseOptions({});
    const listener = new FormationListener({ ...options, maxConcurrentSessions: 0 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Too many concurrent formation sessions');
    expect(result.cadrePeerAddrs).toBeUndefined();
    expect(identityDisclosed()).toBe(false);
    expect(stream.closed).toBe(true);
  });

  it('discloses responder identity + provision result only after both validations pass', async () => {
    const { options, identityDisclosed } = baseOptions({});
    const listener = new FormationListener(options);
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(true);
    expect(result.partyId).toBe(RESPONDER_IDENTITY.partyId);
    expect(result.cadrePeerAddrs).toEqual(RESPONDER_IDENTITY.cadrePeerAddrs);
    expect(result.provisionResult?.strand.strandId).toBe('strand-ok');
    expect(result.provisionResult?.strand.createdBy).toBe('responder');
    expect(identityDisclosed()).toBe(true);
  });

  it('rejects a post-validation provisioning outcome without disclosing responder cadre', async () => {
    // The hook validated token + disclosure but then REJECTS (e.g. an unconverged host
    // strand). The listener must reply with a clean, non-disclosing approved:false.
    const { options, identityDisclosed } = baseOptions({
      provisionStrand: async (): Promise<ResponderProvisionOutcome> =>
        ({ approved: false, reason: 'Host strand not yet available on this responder' })
    });
    const listener = new FormationListener(options);
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Host strand not yet available on this responder');
    expect(result.partyId).toBeUndefined();
    expect(result.cadrePeerAddrs).toBeUndefined();
    expect(result.provisionResult).toBeUndefined();
    // Identity is read only on the approval path — a rejection discloses nothing.
    expect(identityDisclosed()).toBe(false);
  });

  it('converts an unexpected provisioning throw into a non-disclosing internal-error frame', async () => {
    // A future hook bug that THROWS must not reproduce the silent-drop symptom: a
    // best-effort approved:false frame is written before the stream closes.
    const { options, identityDisclosed } = baseOptions({
      provisionStrand: async (): Promise<ResponderProvisionOutcome> => { throw new Error('boom'); }
    });
    const listener = new FormationListener(options);
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Internal formation error');
    expect(result.partyId).toBeUndefined();
    expect(result.cadrePeerAddrs).toBeUndefined();
    expect(identityDisclosed()).toBe(false);
    expect(stream.closed).toBe(true);
  });
});

// ── isValidResponderCreatesResult rejection matrix (the initiator's floor) ─────

describe('isValidResponderCreatesResult rejection matrix', () => {
  const good: FormationResultMessage = {
    approved: true,
    partyId: 'responder-id',
    cadrePeerAddrs: ['/ip4/10.0.0.1/tcp/2/p2p/responder'],
    provisionResult: {
      strand: { strandId: 'strand-1', createdBy: 'responder' },
      dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
    }
  };

  it('accepts a fully-formed responderCreates result', () => {
    expect(isValidResponderCreatesResult(good)).toBe(true);
  });

  it('rejects when not approved', () => {
    expect(isValidResponderCreatesResult({ ...good, approved: false })).toBe(false);
  });

  it('rejects a missing disclosed identity', () => {
    expect(isValidResponderCreatesResult({ ...good, partyId: undefined })).toBe(false);
  });

  it('rejects empty cadre addresses', () => {
    expect(isValidResponderCreatesResult({ ...good, cadrePeerAddrs: [] })).toBe(false);
  });

  it('rejects deprecated cadre-*.local placeholder addresses', () => {
    expect(isValidResponderCreatesResult({ ...good, cadrePeerAddrs: ['cadre-a-1.local'] })).toBe(false);
    expect(isValidResponderCreatesResult({ ...good, cadrePeerAddrs: ['cadre-b-2.local'] })).toBe(false);
  });

  it('rejects a missing or empty strand id', () => {
    expect(isValidResponderCreatesResult({ ...good, provisionResult: undefined })).toBe(false);
    expect(isValidResponderCreatesResult({
      ...good,
      provisionResult: { ...good.provisionResult!, strand: { strandId: '', createdBy: 'responder' } }
    })).toBe(false);
  });

  it('rejects a strand the responder did not create', () => {
    expect(isValidResponderCreatesResult({
      ...good,
      provisionResult: { ...good.provisionResult!, strand: { strandId: 'strand-1', createdBy: 'initiator' } }
    })).toBe(false);
  });
});
