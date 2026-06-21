/**
 * turn-credential-issuer — a tiny, dependency-free Node HTTP service that serves a
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
 * Built with Node built-ins only (`node:http`, `node:crypto`) — no framework, no
 * runtime deps, mirroring `ops/docker/libp2p-infra/`. Listens plain HTTP; the
 * operator fronts it with their existing TLS reverse proxy (see README).
 *
 * See `ops/docs/ice-servers.md` and `ops/docker/coturn/README.md`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

const LOG_PREFIX = '[turn-credential-issuer]';

type TurnPolicy = 'off' | 'gated' | 'on';

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
}

// --- Defaults & clamps (keep in sync with env.example) ----------------------
const DEFAULT_PORT = 8080;
const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const DEFAULT_CRED_ID = 'web';
const DEFAULT_RATE_LIMIT_PER_MIN = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

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

/**
 * Assemble the manifest for a given clock. Pure (no I/O, no logging) so the
 * config-render smoke test can drive it across the gating matrix without a socket.
 */
function buildManifest(config: IssuerConfig, nowSec: number): IceConfigManifest {
	const iceServers: IceServerEntry[] = [];
	if (config.stunUrls.length > 0) {
		iceServers.push({ urls: config.stunUrls });
	}
	if (shouldEmitTurn(config)) {
		const cred = mintTurnCredential(config.turnSecret, config.credId, config.credTtlSeconds, nowSec);
		iceServers.push({ urls: config.turnUrls, username: cred.username, credential: cred.credential });
	}
	return {
		iceServers,
		turnPolicy: config.turnPolicy,
		generatedAt: new Date(nowSec * 1000).toISOString(),
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
	res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
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
	limiter: FixedWindowRateLimiter;
	nowMs: () => number;
	nowSec: () => number;
}

function handleIceServers(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RequestContext): void {
	const { config, limiter } = ctx;

	// Auth gate (before rate-limit state is touched, so unauthenticated floods
	// can't pollute the bucket Map). A generic 401 — never echo the expected token.
	if (config.authToken.length > 0) {
		const provided = extractToken(req, url);
		if (!provided || !tokenMatches(provided, config.authToken)) {
			sendJson(res, 401, { error: 'unauthorized' });
			return;
		}
	}

	const ip = clientIp(req, config.trustProxy);
	if (!limiter.allow(ip, ctx.nowMs())) {
		sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
		return;
	}

	const manifest = buildManifest(config, ctx.nowSec());
	// no-store: a cached manifest would serve already-expired credentials.
	sendJson(res, 200, manifest, { 'Cache-Control': 'no-store' });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
	setCors(res, ctx.config.corsAllowOrigin);

	// Preflight: a future client sending `Authorization` triggers an OPTIONS
	// preflight; answer it so the header-token path doesn't break.
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
		handleIceServers(req, res, url, ctx);
		return;
	}

	sendJson(res, 404, { error: 'not_found' });
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
			`trustProxy=${config.trustProxy} corsAllowOrigin=${config.corsAllowOrigin}`,
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
}

function main(): void {
	const config = readConfig();
	logEffectiveConfig(config);

	const limiter = new FixedWindowRateLimiter(config.rateLimitPerMin, RATE_LIMIT_WINDOW_MS);
	const ctx: RequestContext = {
		config,
		limiter,
		nowMs: () => Date.now(),
		nowSec: () => Math.floor(Date.now() / 1000),
	};

	// Periodically evict stale rate-limit buckets so the Map can't grow unbounded
	// under IP churn (a memory-exhaustion vector). unref so it never holds the
	// process open on its own.
	const evictTimer = setInterval(() => limiter.evictStale(Date.now()), RATE_LIMIT_WINDOW_MS);
	evictTimer.unref();

	const server = createServer((req, res) => {
		try {
			handleRequest(req, res, ctx);
		} catch (err) {
			console.error(`${LOG_PREFIX} request handler error`, err);
			if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
			else res.end();
		}
	});

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

export { buildManifest, mintTurnCredential, shouldEmitTurn, FixedWindowRateLimiter, readConfig };
export type { IssuerConfig, IceConfigManifest, TurnCredential, TurnPolicy };
