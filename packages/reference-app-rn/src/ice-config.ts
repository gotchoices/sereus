/**
 * ice-config.ts — fetch the runtime ICE-server manifest and return an
 * `IceServer[]` ready to drop into a WebRTC transport's `iceServers` field.
 *
 * React Native port of `reference-app-web/src/lib/ice-config.ts`. The logic,
 * validation, peer-assertion wire format, never-throws contract, and 5 s fetch
 * deadline are identical; only three platform touch-points differ:
 *
 *  - Build-time URL env var: `EXPO_PUBLIC_ICE_CONFIG_URL` (Expo inlines
 *    `EXPO_PUBLIC_`-prefixed vars into the Hermes bundle at build time).
 *    The Vite counterpart is `VITE_ICE_CONFIG_URL`.
 *  - `localStorage` is absent in RN — the per-device override seam is omitted.
 *    A debug-override path (e.g. SecureStore/AsyncStorage) is out of scope here;
 *    file a separate ticket if wanted.
 *  - `RTCIceServer` is a DOM type. Expo's `tsconfig.base` does pull in the `dom`
 *    lib (so DOM types resolve), but we keep a local structural `IceServer` (W3C
 *    RTCIceServer subset) anyway, to stay decoupled from `dom` and portable. The
 *    WebRTC transport (`cadre-phone.ts`) passes the `IceServer[]` straight into
 *    `rtcConfiguration.iceServers` — structurally assignable to `RTCIceServer[]`,
 *    so no per-element mapping is needed.
 *
 * Framework-free by design: the peer-assertion signing capability is *injected*
 * as a structural interface ({@link IceConfigPeerSigner}) — this file owns the
 * wire format and imports no crypto library, so the two copies stay mirrors and
 * neither drags `@libp2p/crypto` into its bundle.
 *
 * `fetch` is a global in RN (Hermes) — no import needed.
 * `AbortController` is present in Hermes/RN 0.79; no polyfill is needed.
 * Do NOT use `AbortSignal.timeout` — use explicit `setTimeout` + `clearTimeout`.
 * `crypto.getRandomValues` comes from the `react-native-get-random-values` polyfill
 * loaded in `polyfills/hermes.js` (only `getRandomValues`, NOT `randomUUID` — see
 * `uuid.ts`).
 *
 * Policy: STUN-first, TURN off by default. Any failure (no URL, network error,
 * non-OK HTTP, malformed body, timeout) returns `[]`. Never throws. No hard-coded
 * third-party STUN fallback — STUN-less is degraded but safe (libp2p relay).
 */

const LOG_PREFIX = '[reference-app-rn] ice-config:';

/**
 * Manifest-fetch deadline — mirrors the web file. One deadline covers the whole
 * call, including the unauthenticated retry below, so a hostile host cannot double
 * the boot/resume stall by rejecting the assertion.
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

/** W3C RTCIceServer subset (no `dom` lib in RN tsconfig). */
export interface IceServer {
	urls: string | string[];
	username?: string;
	credential?: string;
}

export interface IceConfigManifest {
	iceServers: IceServer[];
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
 * Typed fixture mirroring `ops/docker/coturn/ice-servers.example.json`. Exists
 * so the schema is checked at compile time and stays in sync with the operator
 * example — mirrors the web file's `exampleIceConfigManifest`.
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
 * (`cadre-phone.ts`) supplies a real one via `peerKeySigner(privateKey)`.
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
	/** Explicit manifest URL; otherwise resolved from `EXPO_PUBLIC_ICE_CONFIG_URL`. */
	url?: string;
	/** When present, the request carries a signed peer assertion. */
	signer?: IceConfigPeerSigner;
}

/** Read the build-time manifest URL from the Expo public env var. */
function envConfigUrl(): string | undefined {
	const raw = process.env.EXPO_PUBLIC_ICE_CONFIG_URL;
	return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Resolve the manifest URL: explicit arg → env var → none. */
export function resolveIceConfigUrl(explicit?: string): string | undefined {
	if (explicit && explicit.length > 0) return explicit;
	return envConfigUrl();
}

/**
 * The audience string a peer assertion binds to: the target URL with the query
 * and fragment stripped, and **nothing else normalized**. The issuer compares it
 * to its configured `PEER_AUTH_AUDIENCE` character for character, so a trailing
 * slash or an `http`/`https` difference is a mismatch — see `ops/docs/ice-servers.md`.
 *
 * Derived from the URL actually fetched (never hoisted to module scope).
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
 * assertion be replayed within the acceptance window. (`uuid.ts` uses `Math.random`
 * — that is fine for demo identifiers and NOT fine here.)
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
 * Validate one entry into a clean `IceServer`, or `null` if malformed. Only
 * the known optional string fields are carried over (no `any` passthrough).
 */
function toIceServer(entry: unknown): IceServer | null {
	if (typeof entry !== 'object' || entry === null) return null;
	const rec = entry as Record<string, unknown>;
	if (!isValidUrls(rec.urls)) return null;

	const server: IceServer = { urls: rec.urls as string | string[] };
	if (typeof rec.username === 'string') server.username = rec.username;
	if (typeof rec.credential === 'string') server.credential = rec.credential;
	return server;
}

/**
 * Validate a parsed manifest into an `IceServer[]`. Strict-but-lenient: the
 * top level must carry an `iceServers` array, but individual malformed entries
 * are dropped (with a warning) rather than failing the whole load.
 */
export function parseIceServers(data: unknown): IceServer[] {
	if (typeof data !== 'object' || data === null) {
		console.warn(`${LOG_PREFIX} manifest is not an object; ignoring`);
		return [];
	}
	const { iceServers } = data as Record<string, unknown>;
	if (!Array.isArray(iceServers)) {
		console.warn(`${LOG_PREFIX} manifest.iceServers is not an array; ignoring`);
		return [];
	}

	const servers: IceServer[] = [];
	for (const entry of iceServers) {
		const server = toIceServer(entry);
		if (server) servers.push(server);
		else console.warn(`${LOG_PREFIX} dropping malformed iceServers entry`, entry);
	}
	return servers;
}

/** One attempt: a parsed manifest, the non-OK status, or the failure it raised. */
type ManifestAttempt =
	| { kind: 'servers'; servers: IceServer[] }
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
 *  - a thrown failure — mirrors the web copy, where attaching the five
 *    `X-Sereus-Peer-*` headers turns a cross-origin fetch into a **preflighted**
 *    one and a manifest host that does not answer that `OPTIONS` fails the request
 *    with a CORS error indistinguishable from a network error. RN's `fetch` is not
 *    CORS-bound, so that exact trap is web-only, but the two copies stay mirrors
 *    and a retry here is equally harmless: a genuinely dead network costs one extra
 *    doomed fetch inside the same deadline.
 */
function shouldRetryUnauthenticated(attempt: ManifestAttempt): boolean {
	if (attempt.kind === 'error') return true;
	return attempt.kind === 'status' && ASSERTION_RETRY_STATUSES.includes(attempt.status);
}

/** Why we are falling back — the audience is the field operators most often get wrong. */
function retryReason(attempt: ManifestAttempt, audience: string): string {
	const cause = attempt.kind === 'status' ? `HTTP ${attempt.status}` : 'the request failed outright';
	return `${LOG_PREFIX} peer assertion not accepted — ${cause}, audience "${audience}"; retrying unauthenticated`;
}

/**
 * Resolve, fetch, and validate the ICE-config manifest, returning the
 * `IceServer[]`. Returns `[]` on any failure (no URL, network error, non-OK
 * response, malformed body, timeout). Never throws.
 *
 * With `options.signer` the request carries a peer assertion (see
 * {@link buildPeerAssertionHeaders}). If that attempt fails in any way the
 * assertion could have caused — a skewed device clock, an operator who moved the
 * audience, a deny-listed peer, a full replay cache — the call retries **once**
 * without the headers rather than degrading to `[]`, which would strip STUN as well
 * and leave the node worse off. A retry is never itself retried, and both attempts
 * share the one abort deadline.
 */
export async function loadIceConfig(options?: LoadIceConfigOptions): Promise<IceServer[]> {
	const target = resolveIceConfigUrl(options?.url);
	if (!target) {
		console.debug(`${LOG_PREFIX} no manifest URL configured; running without STUN`);
		return [];
	}

	const audience = iceConfigAudience(target);
	// Signed BEFORE the deadline starts, so signing time never eats the fetch budget.
	const assertionHeaders = options?.signer
		? await tryBuildPeerAssertionHeaders(options.signer, audience)
		: undefined;

	// One controller + one timer for BOTH attempts.
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
