/**
 * turn-credential-issuer — a tiny Node HTTP service that serves a
 * **dynamic ICE-config manifest** (`/ice-servers.json`) for Sereus WebRTC clients.
 *
 * When the operator has enabled the co-located coturn TURN relay, each manifest
 * fetch carries a freshly-minted, short-lived TURN credential (coturn
 * `use-auth-secret` / REST-API scheme); when TURN is off, the manifest is
 * STUN-only. The shared `static-auth-secret` (coturn `TURN_SECRET`) lives only
 * here, co-located with coturn — never in a client bundle.
 *
 * The manifest shape is exactly the `IceConfigManifest` consumed by the client
 * helper `loadIceConfig()` (`packages/reference-app-{web,rn}/.../ice-config.ts`),
 * so pointing `VITE_ICE_CONFIG_URL` / `EXPO_PUBLIC_ICE_CONFIG_URL` at this
 * service's `/ice-servers.json` is the only client-side wiring needed.
 *
 * When peer-bound issuance is enabled (`PEER_AUTH_MODE`), the caller may also prove
 * control of a libp2p node identity by signing a short statement with its Ed25519
 * identity key; the issuer then stamps the derived peer id into the credential so
 * coturn logs attribute relayed bytes to a peer id. See `src/peer-assertion.ts`.
 *
 * Built on Node built-ins (`node:http`, `node:crypto`) plus one runtime dependency
 * — `@libp2p/crypto`, the same library the clients sign with, so the derived peer
 * id matches by construction rather than by re-derivation. No framework. Listens
 * plain HTTP; the operator fronts it with their existing TLS reverse proxy (see
 * README).
 *
 * See `ops/docs/ice-servers.md` and `ops/docker/coturn/README.md`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import {
	PEER_HEADER_NAMES_CANONICAL,
	ReplayCache,
	parsePeerAssertion,
	verifyPeerAssertion,
} from './peer-assertion.js';

const LOG_PREFIX = '[turn-credential-issuer]';

type TurnPolicy = 'off' | 'gated' | 'on';

/**
 * How hard the issuer leans on peer assertions:
 *   off      - peer headers ignored entirely (today's behaviour)
 *   optional - a valid assertion earns a peer-labelled credential; no assertion
 *              still gets the existing token + rate-limited path
 *   required - no assertion means STUN-only (never a TURN entry)
 */
type PeerAuthMode = 'off' | 'optional' | 'required';

/** What the manifest reports about this particular request's caller. */
type PeerAuthState = 'off' | 'none' | 'verified';

interface IssuerConfig {
	port: number;
	stunUrls: string[];
	turnEnabled: boolean;
	turnPolicy: TurnPolicy;
	turnSecret: string;
	turnUrls: string[];
	credTtlSeconds: number;
	credId: string;
	authToken: string;
	rateLimitPerMin: number;
	trustProxy: boolean;
	corsAllowOrigin: string;
	peerAuthMode: PeerAuthMode;
	peerAuthAudience: string;
	peerAuthSkewSeconds: number;
	peerAllowList: string[];
	peerDenyList: string[];
	rateLimitPerPeerPerMin: number;
	replayCacheMax: number;
}

interface TurnCredential {
	username: string;
	credential: string;
	ttl: number;
}

/** One ICE-server entry — W3C `RTCIceServer` subset (mirrors `ice-config.ts`). */
interface IceServerEntry {
	urls: string[];
	username?: string;
	credential?: string;
}

interface IceConfigManifest {
	iceServers: IceServerEntry[];
	turnPolicy: TurnPolicy;
	generatedAt: string;
	/** Informational: whether this response's caller proved a peer identity. */
	peerAuth: PeerAuthState;
	/** Informational: the verified peer id. Present only when `peerAuth === 'verified'`. */
	peerId?: string;
}

// --- Defaults & clamps (keep in sync with env.example) ----------------------
const DEFAULT_PORT = 8080;
const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const DEFAULT_CRED_ID = 'web';
const DEFAULT_RATE_LIMIT_PER_MIN = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_PEER_AUTH_SKEW_SECONDS = 60;
const MIN_PEER_AUTH_SKEW_SECONDS = 5;
const MAX_PEER_AUTH_SKEW_SECONDS = 300;
const DEFAULT_RATE_LIMIT_PER_PEER_PER_MIN = 10;
const DEFAULT_REPLAY_CACHE_MAX = 50_000;

// --- Env parsing ------------------------------------------------------------

function envStr(name: string, def = ''): string {
	const raw = process.env[name];
	return typeof raw === 'string' && raw.length > 0 ? raw : def;
}

function envList(name: string): string[] {
	return envStr(name)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

function envBool(name: string, def: boolean): boolean {
	const raw = envStr(name);
	if (!raw) return def;
	return raw.toLowerCase() === 'true' || raw === '1';
}

function envInt(name: string, def: number): number {
	const raw = envStr(name);
	if (!raw) return def;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : def;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function parseTurnPolicy(raw: string): TurnPolicy {
	if (raw === 'gated' || raw === 'on' || raw === 'off') return raw;
	if (raw.length > 0) {
		console.warn(`${LOG_PREFIX} invalid TURN_POLICY=${JSON.stringify(raw)}; defaulting to 'off'`);
	}
	return 'off';
}

function parsePeerAuthMode(raw: string): PeerAuthMode {
	if (raw === 'off' || raw === 'optional' || raw === 'required') return raw;
	if (raw.length > 0) {
		console.warn(`${LOG_PREFIX} invalid PEER_AUTH_MODE=${JSON.stringify(raw)}; defaulting to 'off'`);
	}
	return 'off';
}

function readConfig(): IssuerConfig {
	return {
		port: envInt('ISSUER_PORT', DEFAULT_PORT),
		stunUrls: envList('STUN_URLS'),
		turnEnabled: envBool('TURN_ENABLED', false),
		turnPolicy: parseTurnPolicy(envStr('TURN_POLICY', 'off')),
		turnSecret: envStr('TURN_SECRET'),
		turnUrls: envList('TURN_URLS'),
		credTtlSeconds: clamp(envInt('CRED_TTL_SECONDS', DEFAULT_TTL_SECONDS), MIN_TTL_SECONDS, MAX_TTL_SECONDS),
		credId: envStr('CRED_ID', DEFAULT_CRED_ID),
		authToken: envStr('ISSUER_AUTH_TOKEN'),
		rateLimitPerMin: envInt('RATE_LIMIT_PER_MIN', DEFAULT_RATE_LIMIT_PER_MIN),
		trustProxy: envBool('TRUST_PROXY', false),
		corsAllowOrigin: envStr('CORS_ALLOW_ORIGIN', '*'),
		peerAuthMode: parsePeerAuthMode(envStr('PEER_AUTH_MODE', 'off')),
		peerAuthAudience: envStr('PEER_AUTH_AUDIENCE'),
		peerAuthSkewSeconds: clamp(
			envInt('PEER_AUTH_SKEW_SECONDS', DEFAULT_PEER_AUTH_SKEW_SECONDS),
			MIN_PEER_AUTH_SKEW_SECONDS,
			MAX_PEER_AUTH_SKEW_SECONDS,
		),
		peerAllowList: envList('PEER_ALLOW_LIST'),
		peerDenyList: envList('PEER_DENY_LIST'),
		rateLimitPerPeerPerMin: envInt('RATE_LIMIT_PER_PEER_PER_MIN', DEFAULT_RATE_LIMIT_PER_PEER_PER_MIN),
		replayCacheMax: envInt('REPLAY_CACHE_MAX', DEFAULT_REPLAY_CACHE_MAX),
	};
}

// --- Credential minting (coturn REST API / use-auth-secret) -----------------

/**
 * Mint an ephemeral coturn credential. coturn validates these as:
 *   username   = "<unixExpiryEpochSeconds>:<id>"
 *   credential = base64(HMAC_SHA1(static_auth_secret, username))   // STANDARD
 *               base64 with padding — NOT base64url. coturn rejects a mismatch.
 * `<id>` is sanitized so it can never contain the `:` separator.
 */
function mintTurnCredential(secret: string, id: string, ttlSeconds: number, nowSec: number): TurnCredential {
	const safeId = id.replace(/[^A-Za-z0-9._-]/g, '') || 'client';
	const expiry = nowSec + ttlSeconds;
	const username = `${expiry}:${safeId}`;
	const credential = createHmac('sha1', secret).update(username).digest('base64');
	return { username, credential, ttl: ttlSeconds };
}

/**
 * The gating matrix: a TURN entry is emitted ONLY when TURN is enabled, a secret
 * is set, at least one TURN URL is configured, and the operator's policy is
 * `gated` or `on`. Any of those false → STUN-only (TURN stays last-resort / off).
 */
function shouldEmitTurn(config: IssuerConfig): boolean {
	return (
		config.turnEnabled &&
		config.turnSecret.length > 0 &&
		config.turnUrls.length > 0 &&
		(config.turnPolicy === 'gated' || config.turnPolicy === 'on')
	);
}

/** Per-request manifest shaping. Nothing here mutates `IssuerConfig`. */
interface ManifestOptions {
	/** What to report in `peerAuth`. */
	peerAuth: PeerAuthState;
	/** Verified peer id, stamped into the manifest for operator visibility. */
	peerId?: string;
	/** Overrides `CRED_ID` as the coturn `<id>` label (the verified peer id). */
	credId?: string;
	/** This caller may not have TURN even though the gating matrix allows it. */
	suppressTurn?: boolean;
}

const UNAUTHENTICATED_MANIFEST: ManifestOptions = { peerAuth: 'off' };

/**
 * Assemble the manifest for a given clock. Pure (no I/O, no logging) so the
 * config-render smoke test can drive it across the gating matrix without a socket.
 */
function buildManifest(config: IssuerConfig, nowSec: number, options: ManifestOptions = UNAUTHENTICATED_MANIFEST): IceConfigManifest {
	const iceServers: IceServerEntry[] = [];
	if (config.stunUrls.length > 0) {
		iceServers.push({ urls: config.stunUrls });
	}
	if (shouldEmitTurn(config) && options.suppressTurn !== true) {
		const credId = options.credId ?? config.credId;
		const cred = mintTurnCredential(config.turnSecret, credId, config.credTtlSeconds, nowSec);
		iceServers.push({ urls: config.turnUrls, username: cred.username, credential: cred.credential });
	}
	return {
		iceServers,
		turnPolicy: config.turnPolicy,
		generatedAt: new Date(nowSec * 1000).toISOString(),
		peerAuth: options.peerAuth,
		...(options.peerId !== undefined ? { peerId: options.peerId } : {}),
	};
}

// --- Rate limiter (in-memory fixed window) ----------------------------------

interface RateBucket {
	count: number;
	windowStartMs: number;
}

/**
 * Trivial per-key fixed-window limiter. Intentionally approximate (a burst can
 * straddle a window boundary) — the hard backstop is coturn's `total-quota` /
 * `user-quota` / `max-bps`, which cap bandwidth regardless of credential count.
 * State is per-process and lost on restart; two replicas have independent buckets.
 */
class FixedWindowRateLimiter {
	private readonly buckets = new Map<string, RateBucket>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
	) {}

	/** Record a hit for `key`; return true if it is within the limit. */
	allow(key: string, nowMs: number): boolean {
		if (this.limit <= 0) return true; // 0 = disabled (discouraged)
		let bucket = this.buckets.get(key);
		if (!bucket || nowMs - bucket.windowStartMs >= this.windowMs) {
			bucket = { count: 0, windowStartMs: nowMs };
			this.buckets.set(key, bucket);
		}
		bucket.count += 1;
		return bucket.count <= this.limit;
	}

	/** Drop expired buckets so the Map can't grow unbounded under IP churn. */
	evictStale(nowMs: number): void {
		for (const [key, bucket] of this.buckets) {
			if (nowMs - bucket.windowStartMs >= this.windowMs) this.buckets.delete(key);
		}
	}
}

// --- HTTP helpers -----------------------------------------------------------

function setCors(res: ServerResponse, origin: string): void {
	res.setHeader('Access-Control-Allow-Origin', origin);
	res.setHeader('Vary', 'Origin');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	// The five peer-assertion headers must be listed or the browser preflight fails
	// and a signing client silently degrades to the unauthenticated path.
	res.setHeader('Access-Control-Allow-Headers', ['Authorization', 'Content-Type', ...PEER_HEADER_NAMES_CANONICAL].join(', '));
	res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
	res.end(payload);
}

/**
 * Resolve the client IP. Behind a reverse proxy the socket IP is the proxy's, so
 * with `TRUST_PROXY=true` we read the **last** (rightmost) hop of
 * `X-Forwarded-For` — the IP the immediate trusted proxy observed (assumes a
 * single trusted proxy hop). With `TRUST_PROXY=false` we ignore XFF entirely so a
 * client can't spoof its IP to evade the per-IP rate limit.
 */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
	if (trustProxy) {
		const xff = req.headers['x-forwarded-for'];
		const raw = Array.isArray(xff) ? xff.join(',') : xff;
		if (raw) {
			const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
			if (hops.length > 0) return hops[hops.length - 1];
		}
	}
	return req.socket.remoteAddress ?? 'unknown';
}

/** Extract a bearer token from the `Authorization` header or `?token=` query. */
function extractToken(req: IncomingMessage, url: URL): string | undefined {
	const auth = req.headers.authorization;
	if (typeof auth === 'string') {
		const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
		if (match) return match[1];
	}
	const q = url.searchParams.get('token');
	return q && q.length > 0 ? q : undefined;
}

/** Constant-time token compare. Length mismatch short-circuits (leaks length only). */
function tokenMatches(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

// --- Request handling -------------------------------------------------------

interface RequestContext {
	config: IssuerConfig;
	ipLimiter: FixedWindowRateLimiter;
	peerLimiter: FixedWindowRateLimiter;
	replay: ReplayCache;
	nowMs: () => number;
	nowSec: () => number;
}

/** Everything `decideIceServers` needs, lifted out of `IncomingMessage` so it is testable without a socket. */
interface AdmissionRequest {
	/** Bearer token supplied by the caller, if any. */
	token?: string;
	/** Client IP as resolved by `clientIp` — the per-IP rate-limit key. */
	ip: string;
	/** Raw request headers, for the peer-assertion parse. */
	headers: IncomingHttpHeaders;
}

interface AdmissionResult {
	status: number;
	body: unknown;
	headers: Record<string, string>;
}

const NO_STORE: Record<string, string> = { 'Cache-Control': 'no-store' };
const RETRY_AFTER_WINDOW: Record<string, string> = { 'Retry-After': '60' };

function manifestResult(config: IssuerConfig, nowSec: number, options: ManifestOptions): AdmissionResult {
	// no-store: a cached manifest would serve already-expired credentials.
	return { status: 200, body: buildManifest(config, nowSec, options), headers: NO_STORE };
}

/**
 * The admission ladder for `/ice-servers.json`. Ordering is deliberate:
 *
 *   1. shared bearer token   — a constant-time compare, so it is the cheapest gate
 *   2. per-IP rate limit     — BEFORE signature verification, so an unauthenticated
 *                              flood cannot burn Ed25519 verification CPU
 *   3. peer assertion        — parse, verify, deny list, allow list, per-peer limit
 *
 * `shouldEmitTurn` still wins over all of it: if TURN is off, unconfigured, or
 * `TURN_POLICY=off`, the manifest is STUN-only no matter how good the assertion was.
 */
async function decideIceServers(request: AdmissionRequest, ctx: RequestContext): Promise<AdmissionResult> {
	const { config } = ctx;

	// Auth gate (before rate-limit state is touched, so unauthenticated floods
	// can't pollute the bucket Map). A generic 401 — never echo the expected token.
	if (config.authToken.length > 0) {
		if (!request.token || !tokenMatches(request.token, config.authToken)) {
			return { status: 401, body: { error: 'unauthorized' }, headers: {} };
		}
	}

	if (!ctx.ipLimiter.allow(request.ip, ctx.nowMs())) {
		return { status: 429, body: { error: 'rate_limited' }, headers: RETRY_AFTER_WINDOW };
	}

	if (config.peerAuthMode === 'off') {
		return manifestResult(config, ctx.nowSec(), { peerAuth: 'off' });
	}

	return decidePeerBound(request, ctx);
}

/** The `PEER_AUTH_MODE != off` half of the ladder. Split out to keep each step readable. */
async function decidePeerBound(request: AdmissionRequest, ctx: RequestContext): Promise<AdmissionResult> {
	const { config } = ctx;

	const parsed = parsePeerAssertion(request.headers);
	if (parsed.kind === 'malformed') {
		// Loud, not silently downgraded: a half-configured client is a bug worth seeing.
		console.warn(`${LOG_PREFIX} rejecting malformed peer assertion: ${parsed.reason}`);
		return { status: 400, body: { error: 'invalid_peer_assertion' }, headers: {} };
	}

	if (parsed.kind === 'absent') {
		// `required` serves a STUN-only 200 rather than a 401: `loadIceConfig` turns a
		// non-OK response into [], which would strip STUN too and leave the node worse off.
		return manifestResult(config, ctx.nowSec(), {
			peerAuth: 'none',
			suppressTurn: config.peerAuthMode === 'required',
		});
	}

	const outcome = await verifyPeerAssertion({
		assertion: parsed.assertion,
		expectedAudience: config.peerAuthAudience,
		skewSeconds: config.peerAuthSkewSeconds,
		nowSec: ctx.nowSec(),
		nowMs: ctx.nowMs(),
		replay: ctx.replay,
	});

	if (outcome.kind === 'overloaded') {
		console.warn(`${LOG_PREFIX} WARNING: ${outcome.reason} (REPLAY_CACHE_MAX=${config.replayCacheMax}) — failing closed; raise the cap or shed load.`);
		return { status: 503, body: { error: 'unavailable' }, headers: RETRY_AFTER_WINDOW };
	}
	if (outcome.kind === 'invalid') {
		// NOTE: one log line per rejected assertion. The reason is a fixed constant (no
		// client data is echoed) and the per-IP limit bounds a single source, but a
		// distributed flood still scales log volume linearly; if that shows up as noise,
		// sample or aggregate these rather than dropping them.
		console.warn(`${LOG_PREFIX} rejecting peer assertion: ${outcome.reason}`);
		return { status: 401, body: { error: 'invalid_peer_assertion' }, headers: {} };
	}

	return admitVerifiedPeer(outcome.peerId, ctx);
}

/** Deny list → allow list → per-peer limit → mint. Runs only for a verified peer id. */
function admitVerifiedPeer(peerId: string, ctx: RequestContext): AdmissionResult {
	const { config } = ctx;

	// Before the per-peer bucket is touched: a denied peer must not be able to
	// consume limiter state at all.
	// NOTE: both lists are scanned linearly per request. Operator-curated lists are
	// tens of entries; if one ever grows to thousands, build a Set once at boot.
	if (config.peerDenyList.includes(peerId)) {
		return { status: 403, body: { error: 'peer_denied' }, headers: {} };
	}

	// Verified but not vetted is not an error — that is what `turnPolicy: gated`
	// has always meant. Serve STUN, withhold TURN.
	if (config.peerAllowList.length > 0 && !config.peerAllowList.includes(peerId)) {
		return manifestResult(config, ctx.nowSec(), { peerAuth: 'verified', peerId, suppressTurn: true });
	}

	if (!ctx.peerLimiter.allow(peerId, ctx.nowMs())) {
		return { status: 429, body: { error: 'rate_limited' }, headers: RETRY_AFTER_WINDOW };
	}

	return manifestResult(config, ctx.nowSec(), { peerAuth: 'verified', peerId, credId: peerId });
}

async function handleIceServers(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RequestContext): Promise<void> {
	const result = await decideIceServers(
		{
			token: extractToken(req, url),
			ip: clientIp(req, ctx.config.trustProxy),
			headers: req.headers,
		},
		ctx,
	);
	sendJson(res, result.status, result.body, result.headers);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
	setCors(res, ctx.config.corsAllowOrigin);

	// Preflight: a client sending `Authorization` or the peer-assertion headers
	// triggers an OPTIONS preflight; answer it so those paths don't break.
	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	const url = new URL(req.url ?? '/', 'http://localhost');

	// Liveness — no auth, no rate limit, no credential.
	if (url.pathname === '/healthz') {
		sendJson(res, 200, { ok: true });
		return;
	}

	if (req.method !== 'GET') {
		sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' });
		return;
	}

	if (url.pathname === '/ice-servers.json') {
		await handleIceServers(req, res, url, ctx);
		return;
	}

	sendJson(res, 404, { error: 'not_found' });
}

/**
 * Wrap `handleRequest` in a server. Exported so the self-test can drive the real
 * socket path (routing, CORS preflight, token extraction, the error path) rather
 * than only `decideIceServers`.
 */
function createIssuerServer(ctx: RequestContext): Server {
	return createServer((req, res) => {
		// handleRequest is async, so a synchronous throw surfaces as a rejection too —
		// this .catch is the only error path, and without it an async rejection would
		// escape as an unhandled rejection and hang the socket.
		handleRequest(req, res, ctx).catch((err: unknown) => {
			console.error(`${LOG_PREFIX} request handler error`, err);
			if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
			else res.end();
		});
	});
}

// --- Boot -------------------------------------------------------------------

function maskSecret(s: string): string {
	return s.length > 0 ? `set (${s.length} chars)` : 'empty';
}

/** Emit loud warnings for misconfigurations that silently degrade to STUN-only. */
function logEffectiveConfig(config: IssuerConfig): void {
	console.log(`${LOG_PREFIX} starting on port ${config.port}`);
	console.log(
		`${LOG_PREFIX} config: turnEnabled=${config.turnEnabled} turnPolicy=${config.turnPolicy} ` +
			`turnSecret=${maskSecret(config.turnSecret)} stunUrls=[${config.stunUrls.join(', ')}] ` +
			`turnUrls=[${config.turnUrls.join(', ')}] credTtlSeconds=${config.credTtlSeconds} credId=${config.credId} ` +
			`authToken=${maskSecret(config.authToken)} rateLimitPerMin=${config.rateLimitPerMin} ` +
			`trustProxy=${config.trustProxy} corsAllowOrigin=${config.corsAllowOrigin} ` +
			`peerAuthMode=${config.peerAuthMode} peerAuthAudience=${config.peerAuthAudience || '(empty)'} ` +
			`peerAuthSkewSeconds=${config.peerAuthSkewSeconds} peerAllowList=[${config.peerAllowList.join(', ')}] ` +
			`peerDenyList=[${config.peerDenyList.join(', ')}] ` +
			`rateLimitPerPeerPerMin=${config.rateLimitPerPeerPerMin} replayCacheMax=${config.replayCacheMax}`,
	);

	if (config.turnEnabled && config.turnSecret.length === 0) {
		console.warn(`${LOG_PREFIX} WARNING: TURN_ENABLED=true but TURN_SECRET is empty — serving STUN-only (no credential can be minted).`);
	}
	if (config.turnEnabled && config.turnUrls.length === 0) {
		console.warn(`${LOG_PREFIX} WARNING: TURN_ENABLED=true but TURN_URLS is empty — serving STUN-only (no TURN URL to advertise).`);
	}
	if (config.turnEnabled && config.turnSecret.length > 0 && config.turnPolicy === 'off') {
		console.warn(`${LOG_PREFIX} NOTE: TURN configured but TURN_POLICY=off — serving STUN-only (policy wins). Set TURN_POLICY=gated|on to issue TURN.`);
	}
	if (config.authToken.length === 0) {
		console.warn(`${LOG_PREFIX} NOTE: ISSUER_AUTH_TOKEN unset — endpoint is rate-limited but open. Set a token for production.`);
	}
	if (config.rateLimitPerMin <= 0) {
		console.warn(`${LOG_PREFIX} WARNING: RATE_LIMIT_PER_MIN=${config.rateLimitPerMin} disables per-IP rate limiting (discouraged).`);
	}
	if (config.stunUrls.length === 0 && !shouldEmitTurn(config)) {
		console.warn(`${LOG_PREFIX} WARNING: no STUN_URLS and no TURN entry — manifest will be empty (clients run STUN-less).`);
	}
	if (config.peerAuthMode !== 'off' && config.peerAuthAudience.length === 0) {
		console.warn(`${LOG_PREFIX} WARNING: PEER_AUTH_MODE=${config.peerAuthMode} but PEER_AUTH_AUDIENCE is empty — audience binding is DISABLED, so an assertion harvested by another issuer can be replayed here.`);
	}
	if (config.peerAuthMode === 'required') {
		console.warn(`${LOG_PREFIX} NOTE: PEER_AUTH_MODE=required — callers without a valid peer assertion get a STUN-only manifest (no TURN).`);
	}
	if (config.peerAuthMode !== 'off' && config.rateLimitPerPeerPerMin <= 0) {
		console.warn(`${LOG_PREFIX} WARNING: RATE_LIMIT_PER_PEER_PER_MIN=${config.rateLimitPerPeerPerMin} disables per-peer rate limiting (discouraged).`);
	}
	if (config.peerAuthMode === 'off' && (config.peerAllowList.length > 0 || config.peerDenyList.length > 0)) {
		console.warn(`${LOG_PREFIX} NOTE: PEER_ALLOW_LIST/PEER_DENY_LIST are set but PEER_AUTH_MODE=off — both lists are ignored.`);
	}
}

/**
 * Config that can only ever deny service. An audience carrying CR or LF can never
 * equal a request header value (headers cannot contain either), so every assertion
 * would fail for a reason no operator would guess. Crash loudly instead.
 */
function fatalConfigError(config: IssuerConfig): string | undefined {
	if (config.peerAuthMode !== 'off' && /[\r\n]/.test(config.peerAuthAudience)) {
		return 'PEER_AUTH_AUDIENCE contains CR or LF — no request header can ever match it, so every peer assertion would be rejected.';
	}
	if (config.replayCacheMax <= 0) {
		return `REPLAY_CACHE_MAX=${config.replayCacheMax} leaves no room to record a nonce — every verification would fail closed with 503.`;
	}
	return undefined;
}

function main(): void {
	const config = readConfig();
	logEffectiveConfig(config);

	const fatal = fatalConfigError(config);
	if (fatal) {
		console.error(`${LOG_PREFIX} FATAL: ${fatal}`);
		process.exit(1);
	}

	const ipLimiter = new FixedWindowRateLimiter(config.rateLimitPerMin, RATE_LIMIT_WINDOW_MS);
	const peerLimiter = new FixedWindowRateLimiter(config.rateLimitPerPeerPerMin, RATE_LIMIT_WINDOW_MS);
	const replay = new ReplayCache(config.replayCacheMax);
	const ctx: RequestContext = {
		config,
		ipLimiter,
		peerLimiter,
		replay,
		nowMs: () => Date.now(),
		nowSec: () => Math.floor(Date.now() / 1000),
	};

	// Periodically evict stale rate-limit buckets and spent nonces so the Maps can't
	// grow unbounded under IP/peer churn (a memory-exhaustion vector). unref so the
	// timer never holds the process open on its own.
	const evictTimer = setInterval(() => {
		const nowMs = Date.now();
		ipLimiter.evictStale(nowMs);
		peerLimiter.evictStale(nowMs);
		replay.evictExpired(nowMs);
	}, RATE_LIMIT_WINDOW_MS);
	evictTimer.unref();

	const server = createIssuerServer(ctx);

	server.listen(config.port, () => {
		console.log(`${LOG_PREFIX} listening on http://0.0.0.0:${config.port} (front with a TLS reverse proxy)`);
	});

	const shutdown = (signal: string): void => {
		console.log(`${LOG_PREFIX} received ${signal}, shutting down`);
		clearInterval(evictTimer);
		server.close(() => process.exit(0));
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run the server only when invoked as the entry point (`node dist/main.js`), so
// the pure exports below can be imported without booting a listener.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
	main();
}

export {
	buildManifest,
	mintTurnCredential,
	shouldEmitTurn,
	FixedWindowRateLimiter,
	readConfig,
	decideIceServers,
	createIssuerServer,
	fatalConfigError,
	RATE_LIMIT_WINDOW_MS,
};
export type {
	IssuerConfig,
	IceConfigManifest,
	TurnCredential,
	TurnPolicy,
	PeerAuthMode,
	PeerAuthState,
	ManifestOptions,
	AdmissionRequest,
	AdmissionResult,
	RequestContext,
};
