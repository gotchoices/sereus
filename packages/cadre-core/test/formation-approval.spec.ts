import { describe, it, expect, vi, afterEach } from 'vitest';
import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import { ed25519PublicKeyFromPrivate } from '../src/ed25519-key.js';
import {
  FormationApprovalError,
  createHttpFormationApprover,
  signFormationApproval,
  verifyFormationApproval,
  type FormationApprovalFailure,
  type FormationApprovalRequest
} from '../src/formation-approval.js';

/**
 * Covers the client side of an invite's `ValidationUrl` approval: the digest helpers
 * (sign/verify) and the HTTP transport that asks the hook.
 *
 * Nothing here touches the control database — the database re-verifies the same signature
 * against the STORED `ValidationKey` row, and `control-formation-invite.spec.ts` owns that
 * half. What these tests pin is that the client produces bytes that half will accept, and
 * that a hostile or broken hook cannot hang, flood, or fool the redeeming node.
 */

/** A disclosure with unicode, escapes, and trailing space — the transport must not touch it. */
const AWKWARD_DISCLOSURE = '{"purpose":"tëst   disclosure","n":1}  ';

function baseRequest(overrides: Partial<FormationApprovalRequest> = {}): FormationApprovalRequest {
  return {
    token: 'invite-abc',
    usageStampId: 'stamp-1',
    strandId: 'strand-1',
    peerKey: '12D3KooWJoiner',
    disclosure: AWKWARD_DISCLOSURE,
    validationUrl: 'https://approver.example/hook',
    ...overrides
  };
}

function approverKeys(): { privateKeyB64: string; validationKey: string } {
  const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
  return { privateKeyB64, validationKey: ed25519PublicKeyFromPrivate(privateKeyB64) };
}

/** Assert a rejection is a {@link FormationApprovalError} of the expected category. */
async function expectFailure(
  promise: Promise<unknown>,
  failure: FormationApprovalFailure
): Promise<FormationApprovalError> {
  const error = await promise.then(
    () => { throw new Error(`expected a ${failure} rejection, but the call resolved`); },
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(FormationApprovalError);
  expect((error as FormationApprovalError).failure).toBe(failure);
  return error as FormationApprovalError;
}

/** A `fetchImpl` that answers every call with the same response, recording what it was sent. */
function stubFetch(respond: (init?: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond(init));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * A response whose body has no reader, as React Native's fetch returns — the fallback path
 * that reads to completion via `text()` instead of streaming to the cap.
 */
function readerlessResponse(text: string, extraHeaders: Record<string, string> = {}): Response {
  return {
    status: 200,
    ok: true,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json', ...extraHeaders }),
    body: null,
    text: () => Promise.resolve(text)
  } as unknown as Response;
}

/**
 * A 200 whose body stream never enqueues, never closes, and ignores every abort, reporting
 * whether the client released the stalled body on its way out.
 */
function stallingFetch(): { fetchImpl: typeof fetch; cancelled: () => boolean } {
  let cancelled = false;
  const fetchImpl = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start() { /* never settles */ },
          cancel() { cancelled = true; }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )) as unknown as typeof fetch;
  return { fetchImpl, cancelled: () => cancelled };
}

/** A body that never ends, recording whether the client released it. */
function endlessBody(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64));
    },
    cancel() {
      cancelled = true;
    }
  });
  return { stream, cancelled: () => cancelled };
}

describe('signFormationApproval / verifyFormationApproval', () => {
  it('round-trips: an approval signed for a request verifies against that request', () => {
    const { privateKeyB64, validationKey } = approverKeys();
    const request = baseRequest();

    const approval = signFormationApproval(request, validationKey, privateKeyB64);

    expect(approval.validationKey).toBe(validationKey);
    expect(approval.validationSignature.length).toBeGreaterThan(0);
    expect(verifyFormationApproval(request, approval)).toBe(true);
  });

  // Each of the five signed fields gets its OWN case: a digest-encoding bug that only
  // separates fields by concatenation would still pass a test that mutated two at once.
  const MUTATIONS: Array<[string, Partial<FormationApprovalRequest>]> = [
    ['token', { token: 'invite-other' }],
    ['usageStampId', { usageStampId: 'stamp-2' }],
    ['strandId', { strandId: 'strand-2' }],
    ['peerKey', { peerKey: '12D3KooWOther' }],
    ['disclosure', { disclosure: `${AWKWARD_DISCLOSURE}x` }]
  ];

  for (const [field, mutation] of MUTATIONS) {
    it(`fails verification when ${field} differs from what was signed`, () => {
      const { privateKeyB64, validationKey } = approverKeys();
      const approval = signFormationApproval(baseRequest(), validationKey, privateKeyB64);

      expect(verifyFormationApproval(baseRequest(mutation), approval)).toBe(false);
    });
  }

  it('does not care about validationUrl — it is not inside the digest', () => {
    const { privateKeyB64, validationKey } = approverKeys();
    const approval = signFormationApproval(baseRequest(), validationKey, privateKeyB64);

    const moved = baseRequest({ validationUrl: 'https://elsewhere.example/hook' });
    expect(verifyFormationApproval(moved, approval)).toBe(true);
  });

  it('handles an empty disclosure, and does not conflate it with any other field', () => {
    const { privateKeyB64, validationKey } = approverKeys();
    const empty = baseRequest({ disclosure: '' });

    const approval = signFormationApproval(empty, validationKey, privateKeyB64);

    expect(verifyFormationApproval(empty, approval)).toBe(true);
    expect(verifyFormationApproval(baseRequest({ disclosure: ' ' }), approval)).toBe(false);
  });

  it('fails verification against a different approver key', () => {
    const signer = approverKeys();
    const impostor = approverKeys();
    const request = baseRequest();
    const approval = signFormationApproval(request, signer.validationKey, signer.privateKeyB64);

    const reclaimed = { ...approval, validationKey: impostor.validationKey };
    expect(verifyFormationApproval(request, reclaimed)).toBe(false);
  });

  it('returns false (never throws) for a garbage signature or key', () => {
    const request = baseRequest();
    expect(verifyFormationApproval(request, { validationKey: '!!!', validationSignature: '!!!' }))
      .toBe(false);
  });
});

describe('createHttpFormationApprover', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('posts exactly the five signed fields and returns the approval', async () => {
    const { privateKeyB64, validationKey } = approverKeys();
    const request = baseRequest();
    const expected = signFormationApproval(request, validationKey, privateKeyB64);
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(expected));

    const approval = await createHttpFormationApprover({ fetchImpl }).requestApproval(request);

    expect(approval).toEqual(expected);
    expect(verifyFormationApproval(request, approval)).toBe(true);

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('https://approver.example/hook');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeDefined();
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json'
    });

    // The body is the signed field set and nothing more — no validationUrl, no keys.
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(
      ['disclosure', 'peerKey', 'strandId', 'token', 'usageStampId']
    );
    // Byte-identical disclosure: the transport must not reformat or re-encode it.
    expect(sent['disclosure']).toBe(AWKWARD_DISCLOSURE);
  });

  it('accepts an http: hook (self-hosted LAN approvers stay usable)', async () => {
    const { privateKeyB64, validationKey } = approverKeys();
    const request = baseRequest({ validationUrl: 'http://10.0.0.5:8080/approve' });
    const expected = signFormationApproval(request, validationKey, privateKeyB64);
    const { fetchImpl } = stubFetch(() => jsonResponse(expected));

    await expect(createHttpFormationApprover({ fetchImpl }).requestApproval(request))
      .resolves.toEqual(expected);
  });

  for (const status of [401, 403]) {
    it(`treats HTTP ${status} as refused`, async () => {
      const { fetchImpl } = stubFetch(() => jsonResponse({ error: 'no' }, status));

      await expectFailure(
        createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
        'refused'
      );
    });
  }

  it('treats a 403 carrying a well-formed approval as refused — status decides, not body shape', async () => {
    const { privateKeyB64, validationKey } = approverKeys();
    const request = baseRequest();
    const approval = signFormationApproval(request, validationKey, privateKeyB64);
    const { fetchImpl } = stubFetch(() => jsonResponse(approval, 403));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(request),
      'refused'
    );
  });

  it('treats HTTP 500 as unavailable', async () => {
    const { fetchImpl } = stubFetch(() => new Response('boom', { status: 500 }));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'unavailable'
    );
  });

  it('treats a network error as unavailable, forwarding the cause', async () => {
    const cause = new TypeError('fetch failed');
    const fetchImpl = (() => Promise.reject(cause)) as unknown as typeof fetch;

    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'unavailable'
    );
    expect(error.cause).toBe(cause);
  });

  it('treats a rejected redirect as unavailable', async () => {
    // What a real fetch does with `redirect: 'error'`.
    const fetchImpl = (() =>
      Promise.reject(new TypeError('unexpected redirect'))) as unknown as typeof fetch;

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'unavailable'
    );
  });

  it('treats a followed redirect as unavailable (runtimes that ignore redirect: error)', async () => {
    const { fetchImpl } = stubFetch(() => {
      const response = jsonResponse({ validationKey: 'k', validationSignature: 's' });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'unavailable'
    );
  });

  it('treats a non-JSON 200 as malformed', async () => {
    const { fetchImpl } = stubFetch(() => new Response('<html>hi</html>', { status: 200 }));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'malformed'
    );
  });

  it('treats a 200 with an empty object as malformed', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({}));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'malformed'
    );
  });

  it('treats a 200 with a JSON array as malformed', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse([]));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'malformed'
    );
  });

  const BLANKED: Array<[string, Record<string, unknown>]> = [
    ['a blank validationKey', { validationKey: '   ', validationSignature: 'sig' }],
    ['a blank validationSignature', { validationKey: 'key', validationSignature: '' }],
    ['a missing validationSignature', { validationKey: 'key' }],
    ['a non-string validationKey', { validationKey: 7, validationSignature: 'sig' }]
  ];

  for (const [label, body] of BLANKED) {
    it(`treats ${label} as malformed`, async () => {
      const { fetchImpl } = stubFetch(() => jsonResponse(body));

      await expectFailure(
        createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
        'malformed'
      );
    });
  }

  it('rejects a body whose declared content-length is over the cap, without reading it', async () => {
    const { fetchImpl } = stubFetch(() =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(65 * 1024) }
      })
    );

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'malformed'
    );
  });

  it('stops reading an undeclared oversized body once it passes the cap', async () => {
    const chunk = new Uint8Array(8 * 1024).fill(0x20);
    const CHUNKS = 32; // 256 KiB if fully drained — four times the 64 KiB cap.
    let pulled = 0;
    const { fetchImpl } = stubFetch(() => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= CHUNKS) {
            controller.close();
            return;
          }
          pulled++;
          controller.enqueue(chunk);
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'malformed'
    );
    // Bailed early rather than buffering the whole stream.
    expect(pulled).toBeLessThan(CHUNKS);
  });

  it('releases the body of a response it refuses to read (status decided the outcome)', async () => {
    const { stream, cancelled } = endlessBody();
    const { fetchImpl } = stubFetch(() => new Response(stream, { status: 500 }));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'unavailable'
    );
    // An undrained body keeps the connection checked out; a node polling a sick hook would
    // accumulate one per redemption.
    expect(cancelled()).toBe(true);
  });

  it('releases the body of an oversized response rejected on its declared content-length', async () => {
    const { stream, cancelled } = endlessBody();
    const { fetchImpl } = stubFetch(() =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(65 * 1024) }
      })
    );

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'malformed'
    );
    expect(cancelled()).toBe(true);
  });

  // The `body.getReader` fallback (React Native's fetch): read to completion, then measure.
  it('accepts an approval from a response whose body has no reader', async () => {
    const { privateKeyB64, validationKey } = approverKeys();
    const request = baseRequest();
    const expected = signFormationApproval(request, validationKey, privateKeyB64);
    const { fetchImpl } = stubFetch(() => readerlessResponse(JSON.stringify(expected)));

    await expect(createHttpFormationApprover({ fetchImpl }).requestApproval(request))
      .resolves.toEqual(expected);
  });

  it('caps an oversized response whose body has no reader', async () => {
    const { fetchImpl } = stubFetch(() => readerlessResponse('x'.repeat(65 * 1024)));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest()),
      'malformed'
    );
  });

  for (const timeoutMs of [0, -1, Number.NaN]) {
    it(`refuses to build an approver with timeoutMs ${timeoutMs}`, () => {
      // Would abort every request before it left, reading as a permanently-down hook.
      let caught: unknown;
      try {
        createHttpFormationApprover({ timeoutMs });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FormationApprovalError);
      expect((caught as FormationApprovalError).failure).toBe('misconfigured');
    });
  }

  it('rejects a non-http(s) ValidationUrl as misconfigured, before any request', async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({}));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl })
        .requestApproval(baseRequest({ validationUrl: 'file:///etc/passwd' })),
      'misconfigured'
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects an unparseable ValidationUrl as misconfigured', async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({}));

    await expectFailure(
      createHttpFormationApprover({ fetchImpl })
        .requestApproval(baseRequest({ validationUrl: 'not a url' })),
      'misconfigured'
    );
    expect(calls).toHaveLength(0);
  });

  it('reports a missing global fetch as misconfigured, naming the global', async () => {
    vi.stubGlobal('fetch', undefined);

    const error = await expectFailure(
      createHttpFormationApprover().requestApproval(baseRequest()),
      'misconfigured'
    );
    expect(error.message).toContain('globalThis.fetch');
  });

  it('aborts and reports unavailable when the hook never answers', async () => {
    let aborted = false;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted by signal'));
        });
      })) as unknown as typeof fetch;

    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl, timeoutMs: 25 }).requestApproval(baseRequest()),
      'unavailable'
    );
    expect(aborted).toBe(true);
    expect(error.message).toContain('within 25ms');
  });

  it('rejects a pre-aborted caller signal as unavailable, without contacting the hook', async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({}));
    const caller = new AbortController();
    caller.abort();

    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl }).requestApproval(baseRequest(), caller.signal),
      'unavailable'
    );
    expect(error.message).toContain('cancelled');
    // The hook was never asked — an abandoned redemption must not spend an approval.
    expect(calls).toHaveLength(0);
  });

  it('relays a mid-flight caller abort into the request and reports it as cancelled', async () => {
    let aborted = false;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted by signal'));
        });
      })) as unknown as typeof fetch;
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 10);

    // A 10s client budget: a prompt rejection can only have come from the caller's abort.
    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl, timeoutMs: 10_000 })
        .requestApproval(baseRequest(), caller.signal),
      'unavailable'
    );
    expect(aborted).toBe(true);
    expect(error.message).toContain('cancelled');
  });

  it('times out a hook that answers headers instantly and then dribbles the body', async () => {
    let aborted = false;
    const { fetchImpl } = stubFetch((init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"validationKey":'));
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            controller.error(new Error('aborted by signal'));
          });
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl, timeoutMs: 25 }).requestApproval(baseRequest()),
      'unavailable'
    );
    // The timer must still be armed while the body is being read, not cleared at headers.
    expect(aborted).toBe(true);
    expect(error.message).toContain('within 25ms');
  });

  it('clears the abort timer on the success path (no dangling timer keeps the loop alive)', async () => {
    vi.useFakeTimers();
    try {
      const { privateKeyB64, validationKey } = approverKeys();
      const request = baseRequest();
      const { fetchImpl } = stubFetch(() =>
        jsonResponse(signFormationApproval(request, validationKey, privateKeyB64))
      );

      await createHttpFormationApprover({ fetchImpl, timeoutMs: 10_000 }).requestApproval(request);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the abort timer on the failure path too', async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl } = stubFetch(() => jsonResponse({ error: 'no' }, 403));

      await expectFailure(
        createHttpFormationApprover({ fetchImpl, timeoutMs: 10_000 }).requestApproval(baseRequest()),
        'refused'
      );

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // The budget is the only thing bounding these: `stallingFetch()` answers with a 200 whose body
  // never enqueues, never closes, and ignores the abort entirely, so a client that still trusted
  // `fetch` to reject on abort would hang until vitest's own suite timeout, not the asserted
  // failure category alone.
  it('bounds a stalled body read to timeoutMs even when the runtime ignores the abort', async () => {
    const started = Date.now();
    const { fetchImpl, cancelled } = stallingFetch();

    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl, timeoutMs: 50 }).requestApproval(baseRequest()),
      'unavailable'
    );

    expect(error.message).toContain('50ms');
    expect(Date.now() - started).toBeLessThan(2_000);
    // Giving up is only half of it: the stalled body has to be released too, or a node asking a
    // silent hook once per redemption leaks a connection each time.
    expect(cancelled()).toBe(true);
  }, 10_000);

  it('bounds a stalled body read to the caller abort even when the runtime ignores it', async () => {
    const started = Date.now();
    const caller = new AbortController();
    const abortAt = setTimeout(() => caller.abort(), 25);
    const { fetchImpl, cancelled } = stallingFetch();

    // A 30s client budget: a prompt rejection can only have come from the caller's abort, not
    // the timer — proving the caller-cancellation bound is enforced independently of fetch.
    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl, timeoutMs: 30_000 })
        .requestApproval(baseRequest(), caller.signal),
      'unavailable'
    );
    clearTimeout(abortAt);

    expect(error.message).toContain('cancelled');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled()).toBe(true);
  }, 10_000);

  it('settles on the budget expiring, not on a fetch that rejects synchronously from its own abort listener', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('distinctive rejection from the fetch stub, not the budget'));
        });
      })) as unknown as typeof fetch;

    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl, timeoutMs: 25 }).requestApproval(baseRequest()),
      'unavailable'
    );

    // If `controller.abort()` ever fired before the deadline's own rejection, this fetch stub's
    // synchronous-on-abort rejection would win the race and the caller would see "could not be
    // reached" instead of the budget's own timeout wording.
    expect(error.message).toContain('within 25ms');
  }, 10_000);

  it('discards the body of a response that arrives after the budget already expired', async () => {
    const { stream, cancelled } = endlessBody();
    let deliver!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => { deliver = resolve; });
    const fetchImpl = (() => late) as unknown as typeof fetch;

    const error = await expectFailure(
      createHttpFormationApprover({ fetchImpl, timeoutMs: 25 }).requestApproval(baseRequest()),
      'unavailable'
    );
    expect(error.message).toContain('within 25ms');

    // A fetch that ignored the abort still delivers eventually, and nobody is left to read what
    // it delivers — so the abandoned response's body has to be released, not left checked out.
    deliver(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));
    await vi.waitFor(() => { expect(cancelled()).toBe(true); });
  }, 10_000);
});
