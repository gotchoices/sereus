import { describe, it, expect } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import {
  FormationListener,
  dialFormation,
  isValidResponderCreatesResult,
  type FormationContactMessage,
  type FormationResultMessage,
  type FormationListenerOptions,
  type FormationProvisionResult,
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

/** An approving `provisionStrand` that spends `delayMs` of real work before answering. */
function slowProvision(delayMs: number, strandId: string): () => Promise<ResponderProvisionOutcome> {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      approved: true,
      result: {
        strand: { strandId, createdBy: 'responder' },
        dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
      }
    };
  };
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

  it('completes when provisionStrand is slower than stepTimeoutMs but within provisionTimeoutMs', async () => {
    // Regression: the responder used to run provisioning under the tiny per-wire-step
    // budget, so real work (a DB write, a hook call) could time out a join that would
    // otherwise have succeeded. provisionTimeoutMs is a separate, larger budget.
    const { options, identityDisclosed } = baseOptions({
      provisionStrand: slowProvision(30, 'strand-slow-but-ok')
    });
    const listener = new FormationListener({ ...options, stepTimeoutMs: 10, provisionTimeoutMs: 200 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(true);
    expect(result.provisionResult?.strand.strandId).toBe('strand-slow-but-ok');
    expect(identityDisclosed()).toBe(true);
  });

  it('reports a timed-out provisionStrand as a retryable rejection, not a dropped stream', async () => {
    let capturedSignal: AbortSignal | undefined;
    const { options, identityDisclosed } = baseOptions({
      provisionStrand: (_t, _p, _d, signal): Promise<ResponderProvisionOutcome> => {
        capturedSignal = signal;
        return new Promise(() => { /* never settles */ });
      }
    });
    const listener = new FormationListener({ ...options, provisionTimeoutMs: 20 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Formation provisioning timed out');
    expect(result.partyId).toBeUndefined();
    expect(result.cadrePeerAddrs).toBeUndefined();
    expect(identityDisclosed()).toBe(false);
    expect(stream.closed).toBe(true);
    // The abandoned hook must have been CANCELLED, not merely left running.
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('clamps provisionTimeoutMs when it would outlive the session, so a slow hook still gets a reply', async () => {
    // provisionTimeoutMs (5000) >= sessionTimeoutMs (1000) must clamp to
    // sessionTimeoutMs - stepTimeoutMs (900). A provisioning hook that takes longer than the
    // clamped budget but would fit under the UNCLAMPED one must still see a clean rejection
    // frame — not silence from the outer session timeout firing first.
    const { options } = baseOptions({
      provisionStrand: slowProvision(950, 'strand-too-slow')
    });
    const listener = new FormationListener({
      ...options,
      sessionTimeoutMs: 1000,
      stepTimeoutMs: 100,
      provisionTimeoutMs: 5000
    });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Formation provisioning timed out');
  });

  it('clamps a provisionTimeoutMs that leaves no room for the preceding wire step', async () => {
    // 800ms fits under the 1000ms session on its own, but the session budget also has to
    // cover the contact read (stepTimeoutMs 400), so it clamps to session - step = 600ms.
    // A 700ms hook therefore gets a rejection frame; without the headroom in the guard it
    // would have run to 800ms and raced the session timeout instead.
    const { options } = baseOptions({
      provisionStrand: slowProvision(700, 'strand-no-headroom')
    });
    const listener = new FormationListener({
      ...options,
      sessionTimeoutMs: 1000,
      stepTimeoutMs: 400,
      provisionTimeoutMs: 800
    });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Formation provisioning timed out');
  });

  it('treats provisionTimeoutMs 0 as unset — the default budget, not an instant timeout', async () => {
    // A 0/negative budget must not mean "fail immediately"; it means "no value supplied".
    const { options } = baseOptions({
      provisionStrand: slowProvision(30, 'strand-default-budget')
    });
    const listener = new FormationListener({ ...options, stepTimeoutMs: 10, provisionTimeoutMs: 0 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(true);
    expect(result.provisionResult?.strand.strandId).toBe('strand-default-budget');
  });

  it('adopts a provisioning that lands inside the settle grace instead of replying "timed out"', async () => {
    // Regression: the work budget expiring must NOT report a timeout over an invite the hook
    // has in fact spent. provisionTimeoutMs 400 → work 200 + grace 200; the hook writes at
    // 300ms — after the abort but inside the grace — so its approval is adopted.
    let uses = 0;
    const { options, identityDisclosed } = baseOptions({
      validateToken: async () => ({ valid: uses < 1 }),
      provisionStrand: async (): Promise<ResponderProvisionOutcome> => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        uses++; // stands in for the append-only FormationUsage insert: ignores the abort
        return {
          approved: true,
          result: {
            strand: { strandId: 'strand-late-but-landed', createdBy: 'responder' },
            dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
          }
        };
      }
    });
    const listener = new FormationListener({ ...options, provisionTimeoutMs: 400 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const first = new MockStream([encodeFrame(contact)]);
    await invoke(first);

    const firstResult = decodeFirstFrame<FormationResultMessage>(first.sent);
    expect(firstResult.approved).toBe(true);
    expect(firstResult.reason).toBeUndefined();
    expect(firstResult.provisionResult?.strand.strandId).toBe('strand-late-but-landed');
    expect(firstResult.partyId).toBe(RESPONDER_IDENTITY.partyId);
    expect(identityDisclosed()).toBe(true);
    expect(uses).toBe(1);

    // The spend now belongs to a join the joiner was TOLD succeeded, so refusing a second
    // presentation of the same token is honest — not a silently lost invitation.
    const second = new MockStream([encodeFrame(contact)]);
    await invoke(second);
    expect(decodeFirstFrame<FormationResultMessage>(second.sent).reason).toBe('Invalid token');
  });

  it('adopts a REJECTION that lands inside the settle grace, reporting its reason non-disclosingly', async () => {
    // The other adoption branch: a hook that answers `approved: false` after the abort has its
    // own reason relayed — not overwritten with the generic 'Formation provisioning timed out',
    // which would tell the joiner to retry a formation the responder deliberately refused.
    const { options, identityDisclosed } = baseOptions({
      provisionStrand: async (): Promise<ResponderProvisionOutcome> => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { approved: false, reason: 'Host strand not yet available on this responder' };
      }
    });
    const listener = new FormationListener({ ...options, provisionTimeoutMs: 400 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    const result = decodeFirstFrame<FormationResultMessage>(stream.sent);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Host strand not yet available on this responder');
    // A post-validation rejection still discloses nothing, adopted or not.
    expect(result.partyId).toBeUndefined();
    expect(result.cadrePeerAddrs).toBeUndefined();
    expect(identityDisclosed()).toBe(false);
  });

  it('does not abort provisioning that finishes inside its work budget', async () => {
    // The abort must fire only on overrun; a listener that aborted unconditionally would
    // still pass every timeout test above while cancelling healthy redemptions.
    let capturedSignal: AbortSignal | undefined;
    const { options } = baseOptions({
      provisionStrand: (_t, _p, _d, signal): Promise<ResponderProvisionOutcome> => {
        capturedSignal = signal;
        return slowProvision(20, 'strand-in-budget')();
      }
    });
    const listener = new FormationListener({ ...options, provisionTimeoutMs: 400 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);

    expect(decodeFirstFrame<FormationResultMessage>(stream.sent).approved).toBe(true);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('leaves the invite unspent when the hook observes its abort, so the same token retries', async () => {
    // The other half of the fix: a hook that honours the signal BEFORE writing abandons the
    // redemption. Session 1 gets a timeout with nothing spent; session 2 re-presents the SAME
    // contact frame and forms the strand.
    let uses = 0;
    let calls = 0;
    const { options } = baseOptions({
      validateToken: async () => ({ valid: uses < 1 }),
      provisionStrand: (_token, _partyId, _disclosure, signal): Promise<ResponderProvisionOutcome> => {
        if (++calls === 1) {
          // Writes nothing and rejects the moment the work budget aborts it — what
          // ControlFormationUsageRecorder does via FormationAbortedError.
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new Error('Formation aborted before usage recording')),
              { once: true }
            );
          });
        }
        uses++;
        return Promise.resolve({
          approved: true,
          result: {
            strand: { strandId: 'strand-retry-ok', createdBy: 'responder' },
            dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
          }
        });
      }
    });
    const listener = new FormationListener({ ...options, provisionTimeoutMs: 100 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const first = new MockStream([encodeFrame(contact)]);
    await invoke(first);
    const firstResult = decodeFirstFrame<FormationResultMessage>(first.sent);
    expect(firstResult.approved).toBe(false);
    expect(firstResult.reason).toBe('Formation provisioning timed out');
    expect(uses).toBe(0);

    const second = new MockStream([encodeFrame(contact)]);
    await invoke(second);
    const secondResult = decodeFirstFrame<FormationResultMessage>(second.sent);
    expect(secondResult.approved).toBe(true);
    expect(secondResult.provisionResult?.strand.strandId).toBe('strand-retry-ok');
    expect(uses).toBe(1);
  });

  it('carves the settle grace OUT of provisionTimeoutMs rather than adding it on top', async () => {
    // provisionTimeoutMs 500 → work 250 + grace 250, so a signal-ignoring never-settling hook
    // must be answered by ~500ms, not ~750ms. Adding the grace on top would push provisioning
    // past the initiator's await-response budget and break the nested timeout ladder.
    const { options } = baseOptions({
      provisionStrand: (): Promise<ResponderProvisionOutcome> => new Promise(() => { /* ignores the signal */ })
    });
    const listener = new FormationListener({ ...options, provisionTimeoutMs: 500 });
    const { node, invoke } = captureHandler();
    listener.register(node);

    const started = Date.now();
    const stream = new MockStream([encodeFrame(contact)]);
    await invoke(stream);
    const elapsed = Date.now() - started;

    expect(decodeFirstFrame<FormationResultMessage>(stream.sent).reason).toBe('Formation provisioning timed out');
    expect(elapsed).toBeLessThanOrEqual(700);
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

// ── dialFormation: the sole provision-result guard on the initiator ────────────

/** A mock node whose `dialProtocol` returns a stream pre-loaded with one response frame. */
function dialNode(response: FormationResultMessage): { node: Libp2p; stream: MockStream } {
  const stream = new MockStream([encodeFrame(response)]);
  const node = {
    dialProtocol: async () => stream
  } as unknown as Libp2p;
  return { node, stream };
}

describe('dialFormation provision-result invariant', () => {
  const responderAddrs = ['/ip4/127.0.0.1/tcp/1'];

  it('returns the responder-provisioned strand on an approved result', async () => {
    const provisionResult: FormationProvisionResult = {
      strand: { strandId: 'strand-from-responder', createdBy: 'responder' },
      dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
    };
    const { node, stream } = dialNode({
      approved: true,
      partyId: RESPONDER_IDENTITY.partyId,
      cadrePeerAddrs: RESPONDER_IDENTITY.cadrePeerAddrs,
      provisionResult
    });

    const result = await dialFormation(node, { contact, responderAddrs, validateResponse: async () => true });
    expect(result).toEqual(provisionResult);
    expect(stream.closed).toBe(true);
  });

  it('throws when the responder approves but returns no provision result', async () => {
    // This is the lone guard carrying the provision-result invariant after the mode
    // discriminator was removed — an approved-but-resultless reply must abort, not
    // resolve undefined.
    const { node } = dialNode({
      approved: true,
      partyId: RESPONDER_IDENTITY.partyId,
      cadrePeerAddrs: RESPONDER_IDENTITY.cadrePeerAddrs
    });

    await expect(
      dialFormation(node, { contact, responderAddrs, validateResponse: async () => true })
    ).rejects.toThrow(/Missing provision result/);
  });

  it('throws when the responder rejects the formation', async () => {
    const { node } = dialNode({ approved: false, reason: 'Invalid token' });

    await expect(
      dialFormation(node, { contact, responderAddrs, validateResponse: async () => true })
    ).rejects.toThrow(/Formation rejected: Invalid token/);
  });

  it('bounds await-response by provisionTimeoutMs, not the tiny dial-connect stepTimeoutMs', async () => {
    // Regression for the initiator side: the result read used to share stepTimeoutMs with
    // dial-connect, so a responder doing real provisioning work could blow a 5s budget even
    // though the join would have succeeded. Delay the response frame past stepTimeoutMs but
    // within provisionTimeoutMs and confirm the dial still resolves.
    const provisionResult: FormationProvisionResult = {
      strand: { strandId: 'strand-delayed', createdBy: 'responder' },
      dbConnectionInfo: { endpoint: 'local', credentialsRef: '' }
    };
    const response: FormationResultMessage = {
      approved: true,
      partyId: RESPONDER_IDENTITY.partyId,
      cadrePeerAddrs: RESPONDER_IDENTITY.cadrePeerAddrs,
      provisionResult
    };
    class DelayedResponseStream extends MockStream {
      async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield encodeFrame(response);
      }
    }
    const stream = new DelayedResponseStream([]);
    const node = { dialProtocol: async () => stream } as unknown as Libp2p;

    const result = await dialFormation(node, {
      contact,
      responderAddrs,
      validateResponse: async () => true,
      stepTimeoutMs: 10,
      provisionTimeoutMs: 200
    });
    expect(result).toEqual(provisionResult);
  });

  it('fails the await-response read with its own timeout when the responder never answers', async () => {
    // The initiator must surface the await-response budget, not hang until the whole-session
    // timeout — and must still close the stream on the way out.
    class SilentStream extends MockStream {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return { next: () => new Promise<IteratorResult<Uint8Array>>(() => { /* never delivers a frame */ }) };
      }
    }
    const stream = new SilentStream([]);
    const node = { dialProtocol: async () => stream } as unknown as Libp2p;

    await expect(dialFormation(node, {
      contact,
      responderAddrs,
      validateResponse: async () => true,
      sessionTimeoutMs: 500,
      stepTimeoutMs: 10,
      provisionTimeoutMs: 50
    })).rejects.toThrow(/Formation await-response timed out after 50ms/);
    expect(stream.closed).toBe(true);
  });
});
