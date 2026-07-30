import debug from 'debug';
import {
  concat as uint8ArrayConcat,
  fromString as uint8ArrayFromString,
  toString as uint8ArrayToString
} from 'uint8arrays';
import { sign, verify } from '@optimystic/quereus-plugin-crypto';
import { formationVouchMessage } from './control-database.js';

const log = debug('sereus:cadre:formation-approval');

/** Abort an unanswered approval request after this long when no `timeoutMs` is supplied. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Largest approval response body this client will read (64 KiB). An approval is two short
 * base64url strings; anything approaching this is a broken or hostile hook, and reading it
 * unbounded would let that hook stream a redeeming node out of memory mid-formation.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Everything ONE approval is bound to — the five fields inside the approver's signed digest
 * (see `formationVouchMessage`), plus the hook to ask.
 *
 * Every field is fixed BEFORE the hook is contacted: the redeeming node mints the nonce and
 * knows the strand, the peer, and the disclosure text it is about to write. That ordering is
 * what makes the resulting signature usable — an approval signed over a nonce the node did not
 * insert fails `FormationUsage.Authorized` at commit.
 */
export interface FormationApprovalRequest {
  /** Invitation token being redeemed. */
  token: string;
  /** Single-use nonce for THIS redemption, already minted by the redeeming node. */
  usageStampId: string;
  /** The strand (network) being joined. */
  strandId: string;
  /** The joining peer (written to `FormationUsage.PeerId`). */
  peerId: string;
  /**
   * The EXACT text that will be written to `FormationUsage.Disclosure`. The approver signs
   * these bytes verbatim and MUST NOT re-serialize them — the redeeming node computes this
   * string once and uses the identical string for both the signature and the insert.
   */
  disclosure: string;
  /**
   * The invite's `ValidationUrl` (the hook to contact). NOT part of the signed digest: it says
   * where to ask, not what is being approved.
   */
  validationUrl: string;
}

/**
 * The five signed fields on their own — what `formationVouchMessage` consumes, and the exact
 * JSON body posted to the hook. Derived from {@link FormationApprovalRequest} by subtraction so
 * a field added to the request must be consciously routed here (or the build breaks) rather
 * than silently dropping out of the digest.
 */
type FormationVouchFields = Omit<FormationApprovalRequest, 'validationUrl'>;

/** An approver's answer: which key vouched, and its signature over the request's digest. */
export interface FormationApproval {
  /** Public key the approval claims; must match an enrolled `ValidationKey` row. */
  validationKey: string;
  /** base64url ed25519 signature over `formationVouchMessage(request)`. */
  validationSignature: string;
}

/**
 * Something that can obtain an approval for a redemption. The HTTP hook
 * ({@link createHttpFormationApprover}) is the production implementation; tests and embedded
 * deployments can supply their own.
 *
 * Rejects with a {@link FormationApprovalError} — never resolves to a "no". A caller that
 * receives a resolved {@link FormationApproval} may still find it does not verify; use
 * {@link verifyFormationApproval} before writing.
 */
export interface FormationApprover {
  requestApproval(request: FormationApprovalRequest): Promise<FormationApproval>;
}

/**
 * Why an approval could not be obtained. The four cases route differently: `refused` is a
 * final answer, `unavailable` may succeed on a later attempt, and `malformed` /
 * `misconfigured` are operator errors that retrying never fixes.
 */
export type FormationApprovalFailure =
  /** The hook answered, and the answer is no. */
  | 'refused'
  /** Could not get an answer (network error, timeout, non-2xx status, redirect). */
  | 'unavailable'
  /** Got an answer that is not a usable approval (not JSON, missing/blank fields, oversized). */
  | 'malformed'
  /** The `ValidationUrl` or the runtime is unusable (bad scheme, no `fetch`). */
  | 'misconfigured';

/**
 * Failure to obtain an approval, carrying the {@link FormationApprovalFailure} category the
 * caller switches on to pick the rejection reason a would-be joiner is told.
 */
export class FormationApprovalError extends Error {
  constructor(
    readonly failure: FormationApprovalFailure,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'FormationApprovalError';
  }
}

/**
 * The five fields the approver signs, lifted out of the request. Written as an explicit
 * destructure (not a spread-and-delete) so the object posted to the hook can never pick up a
 * field the digest does not cover — in particular the `validationUrl`.
 */
function vouchFields(request: FormationApprovalRequest): FormationVouchFields {
  const { token, usageStampId, strandId, peerId, disclosure } = request;
  return { token, usageStampId, strandId, peerId, disclosure };
}

/**
 * Approver side: produce the approval for a request. Used by tests, and by anyone writing a
 * hook in TypeScript.
 *
 * `privateKeyB64`'s public half must be the key enrolled as the `ValidationKey` row the
 * redeeming node's control database will verify against — pass that same public key as
 * `validationKey` (derive it with `ed25519PublicKeyFromPrivate` if you only hold the seed).
 * Signing with a key that is not enrolled produces a perfectly valid signature that the
 * database still rejects.
 *
 * @param request - The redemption being approved (all five signed fields).
 * @param validationKey - base64url ed25519 public key that this approval claims.
 * @param privateKeyB64 - base64url 32-byte ed25519 seed to sign with.
 */
export function signFormationApproval(
  request: FormationApprovalRequest,
  validationKey: string,
  privateKeyB64: string
): FormationApproval {
  const validationSignature = sign(
    formationVouchMessage(vouchFields(request)),
    privateKeyB64,
    'ed25519',
    'bytes',
    'base64url',
    'base64url'
  ) as string;
  return { validationKey, validationSignature };
}

/**
 * Redeeming side: does this approval actually verify against the bytes we are about to write?
 *
 * A LOCAL PRE-CHECK, not the authority. It turns a bad approval into a legible rejection
 * instead of an opaque `CHECK constraint failed: Authorized` at commit, and it catches the
 * ordinary drift case (the hook signed a different nonce/strand/peer than the one we hold).
 * It cannot substitute for the database check: this verifies against the key the approval
 * itself names, whereas `FormationUsage.Authorized` verifies against the STORED
 * `ValidationKey` row — which is what stops a redeemer approving itself with a key of its own
 * choosing.
 *
 * Returns a boolean and never throws (same contract as `verifyPeerAuthorization`): malformed
 * base64url, a garbage key, or any crypto failure resolves to `false`, logged at debug.
 */
export function verifyFormationApproval(
  request: FormationApprovalRequest,
  approval: FormationApproval
): boolean {
  try {
    return verify(
      formationVouchMessage(vouchFields(request)),
      approval.validationSignature,
      approval.validationKey,
      'ed25519',
      'bytes',
      'base64url',
      'base64url'
    );
  } catch (error) {
    log('verifyFormationApproval failed: %o', error);
    return false;
  }
}

/**
 * Resolve and validate the hook URL before anything is sent.
 *
 * `http:` stays permitted — a self-hosted hook on a LAN is a real deployment — but note that
 * it puts the disclosure text on the wire in clear, and lets anyone on the path see who is
 * joining which strand. Prefer `https:` for a hook reachable off-link.
 */
function parseHookUrl(validationUrl: string): URL {
  let url: URL;
  try {
    url = new URL(validationUrl);
  } catch (error) {
    throw new FormationApprovalError(
      'misconfigured',
      `ValidationUrl is not a valid URL: ${validationUrl}`,
      { cause: error }
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FormationApprovalError(
      'misconfigured',
      `ValidationUrl scheme "${url.protocol}" is not supported; use http: or https:`
    );
  }
  return url;
}

/**
 * The `fetch` this approver will call: the injected one, else the global.
 *
 * Bound to `globalThis` because an unbound global `fetch` is an illegal invocation in browsers
 * (and in any runtime whose `fetch` is a branded method rather than a plain function).
 */
function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) {
    return fetchImpl;
  }
  if (typeof globalThis.fetch !== 'function') {
    throw new FormationApprovalError(
      'misconfigured',
      'No fetch implementation: globalThis.fetch is missing and no fetchImpl was supplied'
    );
  }
  return globalThis.fetch.bind(globalThis);
}

/**
 * Read the response body as text, refusing anything over {@link MAX_RESPONSE_BYTES}.
 *
 * Two paths, because `Response.body` is not universally a stream (React Native's fetch has no
 * `body` reader): stream and stop at the cap where possible, otherwise read to completion and
 * measure. The declared `content-length` is checked first so an honest oversized response is
 * rejected without reading it at all — but it is only a hint, so the actual bytes are counted
 * either way.
 */
async function readCappedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new FormationApprovalError(
      'malformed',
      `Approval response declares ${declared} bytes, over the ${MAX_RESPONSE_BYTES}-byte cap`
    );
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    assertUnderCap(uint8ArrayFromString(text, 'utf8').byteLength);
    return text;
  }
  return readCappedStream(body.getReader());
}

/** Drain a body stream, aborting the read the moment the accumulated bytes pass the cap. */
async function readCappedStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      assertUnderCap(total);
      chunks.push(value);
    }
  } finally {
    // Releases the connection when we bailed early; a no-op on a fully-drained stream.
    void reader.cancel().catch((error: unknown) => log('response cancel failed: %o', error));
  }
  return uint8ArrayToString(uint8ArrayConcat(chunks, total), 'utf8');
}

function assertUnderCap(bytes: number): void {
  if (bytes > MAX_RESPONSE_BYTES) {
    throw new FormationApprovalError(
      'malformed',
      `Approval response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`
    );
  }
}

/** A blank (or whitespace-only) field is as unusable as a missing one — both are `malformed`. */
function requireField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FormationApprovalError(
      'malformed',
      `Approval response is missing a usable "${field}"`
    );
  }
  return value;
}

/** Parse a 2xx body into an approval, rejecting anything that is not the documented shape. */
function parseApproval(text: string): FormationApproval {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FormationApprovalError('malformed', 'Approval response is not JSON', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FormationApprovalError('malformed', 'Approval response is not a JSON object');
  }
  const body = parsed as Record<string, unknown>;
  return {
    validationKey: requireField(body, 'validationKey'),
    validationSignature: requireField(body, 'validationSignature')
  };
}

/**
 * Map a response's STATUS — never its body shape — onto a failure. A `403` carrying a
 * well-formed approval is still a refusal: the hook said no, and a redeeming node that read
 * the body anyway would let a hook accidentally approve by echoing.
 */
function assertApprovingStatus(response: Response, origin: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new FormationApprovalError(
      'refused',
      `Approval hook ${origin} refused this redemption (HTTP ${response.status})`
    );
  }
  if (!response.ok) {
    throw new FormationApprovalError(
      'unavailable',
      `Approval hook ${origin} answered HTTP ${response.status}`
    );
  }
  // Belt and braces for runtimes that ignore `redirect: 'error'` rather than rejecting.
  if (response.redirected) {
    throw new FormationApprovalError(
      'unavailable',
      `Approval hook ${origin} redirected; re-publish the ValidationUrl instead of chasing it`
    );
  }
}

/**
 * Ask an outside approval service, over HTTP, whether a would-be joiner may redeem an
 * invitation. Contacted by the INVITING party's node (the formation responder) during
 * redemption — never by the joiner, which neither mints the nonce nor performs the write.
 *
 * Wire contract (documented for hook operators in `docs/api.md`):
 *
 * - `POST <ValidationUrl>`, `content-type: application/json`, `accept: application/json`.
 * - Body is exactly the five signed fields — `{ token, usageStampId, strandId, peerId,
 *   disclosure }` — and nothing else. No owner keys, no bootstrap addresses, no membership
 *   keys ever reach the hook.
 * - `200` with `{ "validationKey": "...", "validationSignature": "..." }` is an approval.
 * - `401` / `403` is a refusal; any other non-2xx, a network error, a timeout, or a redirect
 *   is `unavailable`; a 2xx that is not a usable approval is `malformed`.
 *
 * Cross-platform by construction: global `fetch` + `AbortController` only, no `node:` imports.
 */
export function createHttpFormationApprover(options?: {
  /**
   * Abort the request after this long, INCLUDING the body read. Default 10s. Must stay under
   * the responder's provisioning budget — a hook that stalls must not stall formation.
   */
  timeoutMs?: number;
  /** Injectable for tests / non-standard runtimes. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}): FormationApprover {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl;

  return {
    async requestApproval(request: FormationApprovalRequest): Promise<FormationApproval> {
      const doFetch = resolveFetch(fetchImpl);
      const url = parseHookUrl(request.validationUrl);
      // Origin only in messages: a ValidationUrl's path/query may carry a hook secret, and
      // these strings reach logs and the joiner's rejection reason.
      const origin = url.origin;

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await doFetch(url.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(vouchFields(request)),
          redirect: 'error',
          signal: controller.signal
        });
        assertApprovingStatus(response, origin);
        const approval = parseApproval(await readCappedText(response));
        log('approval obtained from %s for token %s', origin, request.token);
        return approval;
      } catch (error) {
        if (error instanceof FormationApprovalError) {
          throw error;
        }
        throw new FormationApprovalError(
          'unavailable',
          timedOut
            ? `Approval hook ${origin} did not answer within ${timeoutMs}ms`
            : `Approval hook ${origin} could not be reached`,
          { cause: error }
        );
      } finally {
        // Cleared on EVERY exit path: a leaked abort timer keeps a node's event loop alive.
        clearTimeout(timer);
      }
    }
  };
}
