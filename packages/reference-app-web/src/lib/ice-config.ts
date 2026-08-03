/**
 * ice-config.ts — fetch the runtime ICE-server manifest and return an
 * `RTCIceServer[]` ready to drop into a WebRTC transport
 * (`webRTC({ rtcConfiguration: { iceServers: await loadIceConfig() } })`).
 *
 * Framework-free and self-contained — same constraint as `connection-path.ts`:
 * no `@serfab/cadre-core` / node deps, so the browser bundle stays lean and the
 * React Native port (`reference-app-rn/src/ice-config.ts`) stays a mirror. The
 * only platform touch-points are `fetch`, `localStorage`, `crypto.getRandomValues`,
 * and `import.meta.env`, each guarded. The peer-assertion signing capability is
 * *injected* as a structural interface ({@link IceConfigPeerSigner}) — this file
 * owns the wire format and never imports a crypto library.
 *
 * Why a runtime manifest (not a build-time constant or a libp2p multiaddr):
 * ICE servers are `stun:`/`turn:` URLs, not multiaddrs, so the libp2p DNSADDR
 * resolver can't carry them. Fetching at startup lets operators rotate/scale
 * STUN/TURN without an app rebuild. See `ops/docs/ice-servers.md`.
 *
 * Policy: STUN-first, TURN off by default. There is **no** hard-coded
 * third-party fallback (e.g. Google STUN) — on any failure we return `[]`.
 * STUN-less is degraded-but-safe (peers fall back to the libp2p relay) and never
 * leaks connection metadata to a third party. `loadIceConfig` never throws; it
 * logs and returns `[]`.
 *
 * `cadre-web.ts` (`startCadre`) consumes this helper to populate the WebRTC
 * transport's `rtcConfiguration.iceServers`; this file only delivers the helper +
 * schema and never instantiates a transport itself.
 *
 * TURN notes (do not lose when TURN is enabled):
 *  - TURN entries carry ephemeral credentials minted per-request by the
 *    `turn-credential-issuer` service (`ops/docker/turn-credential-issuer/`),
 *    which serves this manifest dynamically. Point `VITE_ICE_CONFIG_URL` at the
 *    issuer's `/ice-servers.json`; the `username`/`credential` passthrough below
 *    carries the minted pair. When TURN is off (or `turnPolicy: 'off'`) the issuer
 *    serves a STUN-only manifest.
 *  - When the issuer runs with `PEER_AUTH_MODE=optional|required` it can bind that
 *    credential to the caller's node identity. That needs a client change — pass a
 *    {@link IceConfigPeerSigner} and this file attaches the five `X-Sereus-Peer-*`
 *    headers. Without a signer the request is unauthenticated, exactly as before.
 *  - A TURN-relayed WebRTC path is misclassified as `direct` by
 *    `connection-path.ts` (it only sees `/webrtc`) — backlog
 *    `web-turn-relayed-path-detection`. Dormant while TURN is off.
 */

const LOG_PREFIX = '[reference-app-web] ice-config:';

/** localStorage key for a runtime manifest-URL override (debug / per-device). */
export const ICE_CONFIG_URL_STORAGE_KEY = 'ice-config-url';

/**
 * Manifest-fetch deadline. `loadIceConfig` is awaited during node startup
 * (`cadre-web.ts` → `startCadre`, before `new CadreNode(...)`), so an unbounded
 * fetch against a misbehaving manifest host would stall boot indefinitely. Cap
 * it: on timeout we abort and
 * fall back to the STUN-less-but-safe `[]` path, the same as any other failure.
 *
 * One deadline covers the whole call, including the unauthenticated retry below —
 * a hostile host must not be able to double the boot stall by rejecting the
 * assertion.
 */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Domain-separation tag on line 1 of the signed peer assertion. Must match the
 * issuer's `ASSERTION_DOMAIN` byte for byte
 * (`ops/docker/turn-credential-issuer/src/peer-assertion.ts`).
 */
const ASSERTION_DOMAIN = 'sereus.turn-issuer.v1';

/** Nonce size in bytes; rendered as 32 lowercase hex chars on the wire. */
const NONCE_BYTES = 16;

/**
 * Statuses that mean "your peer assertion was not accepted" and are reachable
 * ONLY from the assertion path, so retrying without it is a genuinely different
 * request: 400 (malformed header set), 401 (bad signature / skewed clock /
 * replayed nonce), 403 (deny-listed peer), 503 (issuer's replay cache full).
 *
 * Deliberately excludes 429: the issuer's per-IP limit fires before the assertion
 * is even parsed, so an unsigned retry hits the same wall.
 */
const ASSERTION_RETRY_STATUSES: readonly number[] = [400, 401, 403, 503];

/**
 * Runtime ICE-config manifest. Deliberately shaped like the W3C `RTCIceServer[]`
 * container so `iceServers` drops straight into `rtcConfiguration`. Mirrors
 * `ops/docker/coturn/ice-servers.example.json`.
 */
export interface IceConfigManifest {
  iceServers: RTCIceServer[];
  /** Informational operator intent; clients use whatever `iceServers` are present. */
  turnPolicy?: 'off' | 'gated' | 'on';
  /** ISO-8601 timestamp the manifest was generated; aids cache/version debugging. */
  generatedAt?: string;
  /**
   * Informational: how the issuer treated this request's peer assertion — `off`
   * (peer-bound issuance disabled), `none` (no assertion presented), `verified`
   * (signature checked). Never load-bearing here; `parseIceServers` reads only
   * `iceServers`.
   */
  peerAuth?: 'off' | 'none' | 'verified';
  /** Informational: the peer id the issuer derived, present only when verified. */
  peerId?: string;
}

/**
 * Typed fixture mirroring `ops/docker/coturn/ice-servers.example.json`. Exists so
 * the schema is checked at compile time (typecheck / svelte-check) and stays in
 * sync with the operator-facing example.
 */
export const exampleIceConfigManifest: IceConfigManifest = {
  iceServers: [{ urls: ['stun:stun.sereus.org:3478'] }],
  turnPolicy: 'off',
  generatedAt: '2026-06-02T00:00:00Z',
};

/**
 * The signing capability `loadIceConfig` needs to prove this node owns its
 * identity. Structural mirror of `@serfab/cadre-core`'s `PeerKeySigner` — declared
 * rather than imported so this file keeps its no-dependency property; the caller
 * (`cadre-web.ts`) supplies a real one via `peerKeySigner(privateKey)`.
 */
export interface IceConfigPeerSigner {
  /** base58btc peer id of the node key. */
  readonly peerId: string;
  /** base64url of the libp2p protobuf-encoded public key. */
  readonly publicKeyB64: string;
  /** Sign the UTF-8 bytes of `message`; resolves to a base64url signature. */
  sign(message: string): Promise<string>;
}

export interface LoadIceConfigOptions {
  /** Explicit manifest URL; otherwise resolved from env then localStorage. */
  url?: string;
  /** When present, the request carries a signed peer assertion. */
  signer?: IceConfigPeerSigner;
}

/** Read the build-time manifest URL (`VITE_ICE_CONFIG_URL`), never `any`. */
function envConfigUrl(): string | undefined {
  const raw = import.meta.env.VITE_ICE_CONFIG_URL;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Read the runtime override from localStorage, guarded for non-DOM hosts. */
function storedConfigUrl(): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(ICE_CONFIG_URL_STORAGE_KEY);
    return raw && raw.length > 0 ? raw : undefined;
  } catch (err) {
    // localStorage can throw (privacy mode, disabled storage) — log, don't fail.
    console.warn(`${LOG_PREFIX} localStorage read failed`, err);
    return undefined;
  }
}

/** Resolve the manifest URL: explicit arg → env → localStorage → none. */
export function resolveIceConfigUrl(explicit?: string): string | undefined {
  if (explicit && explicit.length > 0) return explicit;
  return envConfigUrl() ?? storedConfigUrl();
}

/**
 * The audience string a peer assertion binds to: the target URL with the query
 * and fragment stripped, and **nothing else normalized**. The issuer compares it
 * to its configured `PEER_AUTH_AUDIENCE` character for character, so a trailing
 * slash or an `http`/`https` difference is a mismatch. A *relative* manifest URL
 * signs a relative audience — the page origin the browser resolves the fetch
 * against never enters the signed string. See `ops/docs/ice-servers.md`.
 *
 * Derived from the URL actually fetched (never hoisted to module scope) so the
 * `localStorage` override repointing the manifest also repoints the audience.
 */
export function iceConfigAudience(url: string): string {
  let cut = url.length;
  for (const marker of ['?', '#']) {
    const at = url.indexOf(marker);
    if (at !== -1 && at < cut) cut = at;
  }
  return url.slice(0, cut);
}

/**
 * Build the exact bytes the issuer verifies: five LF-separated lines, no trailing
 * newline. Byte-identical to the issuer's `peerAssertionMessage`; the pinned test
 * vector in `test/ice-config.spec.ts` locks the two together.
 */
export function peerAssertionMessage(
  audience: string,
  peerId: string,
  issuedAtSec: number,
  nonce: string,
): string {
  return [ASSERTION_DOMAIN, audience, peerId, String(issuedAtSec), nonce].join('\n');
}

/**
 * 16 CSPRNG bytes as 32 lowercase hex chars — the issuer's replay handle.
 *
 * Hex rather than base64url so neither copy of this file needs a base64 encoder.
 * `crypto.getRandomValues` and nothing else: a predictable nonce lets a captured
 * assertion be replayed within the acceptance window.
 */
export function randomNonceHex(): string {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable; cannot mint a peer-assertion nonce');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Sign a fresh assertion and render it as the five `X-Sereus-Peer-*` headers.
 * All-or-nothing: the issuer treats a partial header set as malformed.
 */
export async function buildPeerAssertionHeaders(
  signer: IceConfigPeerSigner,
  audience: string,
  issuedAtSec: number,
): Promise<Record<string, string>> {
  const nonce = randomNonceHex();
  const signature = await signer.sign(peerAssertionMessage(audience, signer.peerId, issuedAtSec, nonce));
  return {
    'X-Sereus-Peer-Key': signer.publicKeyB64,
    'X-Sereus-Peer-Aud': audience,
    'X-Sereus-Peer-Ts': String(issuedAtSec),
    'X-Sereus-Peer-Nonce': nonce,
    'X-Sereus-Peer-Sig': signature,
  };
}

/**
 * Assertion headers, or `undefined` if anything about signing failed. Identity
 * trouble must not stop a node from booting — an unauthenticated manifest fetch
 * is still strictly better than no STUN at all.
 */
async function tryBuildPeerAssertionHeaders(
  signer: IceConfigPeerSigner,
  audience: string,
): Promise<Record<string, string> | undefined> {
  try {
    return await buildPeerAssertionHeaders(signer, audience, Math.floor(Date.now() / 1000));
  } catch (err) {
    console.warn(`${LOG_PREFIX} could not build a peer assertion; continuing unauthenticated`, err);
    return undefined;
  }
}

/** True when `urls` is a non-empty string or a string[] of non-empty strings. */
function isValidUrls(urls: unknown): urls is string | string[] {
  if (typeof urls === 'string') return urls.length > 0;
  if (Array.isArray(urls)) {
    return urls.length > 0 && urls.every((u) => typeof u === 'string' && u.length > 0);
  }
  return false;
}

/**
 * Validate one entry into a clean `RTCIceServer`, or `null` if malformed. Only
 * the known optional string fields are carried over (no `any` passthrough).
 */
function toIceServer(entry: unknown): RTCIceServer | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  if (!isValidUrls(rec.urls)) return null;

  const server: RTCIceServer = { urls: rec.urls };
  if (typeof rec.username === 'string') server.username = rec.username;
  if (typeof rec.credential === 'string') server.credential = rec.credential;
  return server;
}

/**
 * Validate a parsed manifest into an `RTCIceServer[]`. Strict-but-lenient: the
 * top level must carry an `iceServers` array, but individual malformed entries
 * are dropped (with a warning) rather than failing the whole load.
 */
export function parseIceServers(data: unknown): RTCIceServer[] {
  if (typeof data !== 'object' || data === null) {
    console.warn(`${LOG_PREFIX} manifest is not an object; ignoring`);
    return [];
  }
  const { iceServers } = data as Record<string, unknown>;
  if (!Array.isArray(iceServers)) {
    console.warn(`${LOG_PREFIX} manifest.iceServers is not an array; ignoring`);
    return [];
  }

  const servers: RTCIceServer[] = [];
  for (const entry of iceServers) {
    const server = toIceServer(entry);
    if (server) servers.push(server);
    else console.warn(`${LOG_PREFIX} dropping malformed iceServers entry`, entry);
  }
  return servers;
}

/** One attempt: a parsed manifest, the non-OK status, or the failure it raised. */
type ManifestAttempt =
  | { kind: 'servers'; servers: RTCIceServer[] }
  | { kind: 'status'; status: number }
  | { kind: 'error' };

/**
 * One fetch + parse, never throwing: a network error, an abort, or malformed JSON
 * all become `{ kind: 'error' }` after being logged. Every failure mode is a value
 * here so the retry decision below can be made in one place.
 */
async function fetchManifest(
  target: string,
  signal: AbortSignal,
  assertionHeaders: Record<string, string> | undefined,
): Promise<ManifestAttempt> {
  try {
    const res = await fetch(target, {
      headers: { accept: 'application/json', ...assertionHeaders },
      signal,
    });
    if (!res.ok) {
      console.warn(`${LOG_PREFIX} fetch ${target} returned HTTP ${res.status}`);
      return { kind: 'status', status: res.status };
    }
    const data: unknown = await res.json();
    return { kind: 'servers', servers: parseIceServers(data) };
  } catch (err) {
    console.warn(`${LOG_PREFIX} failed to load manifest from ${target}`, err);
    return { kind: 'error' };
  }
}

/**
 * Should a failed *signed* attempt be retried without the assertion? Only when the
 * failure is one the assertion itself could have caused:
 *
 *  - `400`/`401`/`403`/`503` — statuses reachable only from the assertion path.
 *    `429` is deliberately absent (see {@link ASSERTION_RETRY_STATUSES}).
 *  - a thrown failure — because attaching the five `X-Sereus-Peer-*` headers turns
 *    a cross-origin fetch into a **preflighted** one, and a manifest host that does
 *    not answer that `OPTIONS` (a plain static file server, as opposed to the
 *    issuer, which does) fails the request with a CORS error that reaches us as an
 *    indistinguishable network error. Retrying unsigned restores the pre-assertion
 *    "simple request" and gets STUN back. A genuinely dead network costs one extra
 *    doomed fetch inside the same deadline.
 */
function shouldRetryUnauthenticated(attempt: ManifestAttempt): boolean {
  if (attempt.kind === 'error') return true;
  return attempt.kind === 'status' && ASSERTION_RETRY_STATUSES.includes(attempt.status);
}

/** Why we are falling back — the audience is the field operators most often get wrong. */
function retryReason(attempt: ManifestAttempt, audience: string): string {
  const cause = attempt.kind === 'status'
    ? `HTTP ${attempt.status}`
    : 'the request failed outright (a cross-origin host that does not answer the CORS preflight for X-Sereus-Peer-* headers looks exactly like this)';
  return `${LOG_PREFIX} peer assertion not accepted — ${cause}, audience "${audience}"; retrying unauthenticated`;
}

/**
 * Resolve, fetch, and validate the ICE-config manifest, returning the
 * `RTCIceServer[]`. Returns `[]` on any failure (no URL configured, network
 * error, non-OK response, malformed body). Never throws.
 *
 * With `options.signer` the request carries a peer assertion (see
 * {@link buildPeerAssertionHeaders}). If that attempt fails in any way the
 * assertion could have caused — a skewed device clock, an operator who moved the
 * audience, a deny-listed peer, a full replay cache, or a CORS preflight the host
 * does not answer — the call retries **once** without the headers rather than
 * degrading to `[]`, which would strip STUN as well and leave the node worse off.
 * A retry is never itself retried, and both attempts share the one abort deadline.
 */
export async function loadIceConfig(options?: LoadIceConfigOptions): Promise<RTCIceServer[]> {
  const target = resolveIceConfigUrl(options?.url);
  if (!target) {
    // No URL configured → STUN-less but safe. Not an error; debug-level note only.
    console.debug(`${LOG_PREFIX} no manifest URL configured; running without STUN`);
    return [];
  }

  const audience = iceConfigAudience(target);
  // Signed BEFORE the deadline starts, so signing time never eats the fetch budget.
  const assertionHeaders = options?.signer
    ? await tryBuildPeerAssertionHeaders(options.signer, audience)
    : undefined;

  // Bound the fetch so a hung manifest host can't stall node startup. On the
  // deadline we abort, `fetchManifest` reports the AbortError as `error`, and we
  // land on the safe `[]` fallback. `clearTimeout` in `finally` avoids a dangling
  // timer on the happy path. One controller + one timer for BOTH attempts.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const attempt = await fetchManifest(target, controller.signal, assertionHeaders);
    if (attempt.kind === 'servers') return attempt.servers;
    if (!assertionHeaders || !shouldRetryUnauthenticated(attempt)) return [];
    // Deadline already blown — a retry on an aborted signal cannot succeed.
    if (controller.signal.aborted) return [];

    console.warn(retryReason(attempt, audience));
    const retry = await fetchManifest(target, controller.signal, undefined);
    return retry.kind === 'servers' ? retry.servers : [];
  } catch (err) {
    // Belt-and-braces: `fetchManifest` already swallows its own failures, so
    // reaching here means something unexpected. The never-throws contract holds.
    console.warn(`${LOG_PREFIX} failed to load manifest from ${target}`, err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
