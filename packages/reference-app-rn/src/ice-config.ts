/**
 * ice-config.ts — fetch the runtime ICE-server manifest and return an
 * `IceServer[]` ready to drop into a WebRTC transport's `iceServers` field.
 *
 * React Native port of `reference-app-web/src/lib/ice-config.ts`. The logic,
 * validation, never-throws contract, and 5 s fetch deadline are identical; only
 * three platform touch-points differ:
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
 * `fetch` is a global in RN (Hermes) — no import needed.
 * `AbortController` is present in Hermes/RN 0.79; no polyfill is needed.
 * Do NOT use `AbortSignal.timeout` — use explicit `setTimeout` + `clearTimeout`.
 *
 * Policy: STUN-first, TURN off by default. Any failure (no URL, network error,
 * non-OK HTTP, malformed body, timeout) returns `[]`. Never throws. No hard-coded
 * third-party STUN fallback — STUN-less is degraded but safe (libp2p relay).
 */

const LOG_PREFIX = '[reference-app-rn] ice-config:';

/** Manifest-fetch deadline — mirrors the web file. */
const FETCH_TIMEOUT_MS = 5_000;

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

/**
 * Resolve, fetch, and validate the ICE-config manifest, returning the
 * `IceServer[]`. Returns `[]` on any failure (no URL, network error, non-OK
 * response, malformed body, timeout). Never throws.
 *
 * @param url Optional explicit manifest URL; otherwise resolved from
 *            `EXPO_PUBLIC_ICE_CONFIG_URL`.
 */
export async function loadIceConfig(url?: string): Promise<IceServer[]> {
	const target = resolveIceConfigUrl(url);
	if (!target) {
		console.debug(`${LOG_PREFIX} no manifest URL configured; running without STUN`);
		return [];
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(target, {
			headers: { accept: 'application/json' },
			signal: controller.signal,
		});
		if (!res.ok) {
			console.warn(`${LOG_PREFIX} fetch ${target} returned HTTP ${res.status}`);
			return [];
		}
		const data: unknown = await res.json();
		return parseIceServers(data);
	} catch (err) {
		console.warn(`${LOG_PREFIX} failed to load manifest from ${target}`, err);
		return [];
	} finally {
		clearTimeout(timer);
	}
}
