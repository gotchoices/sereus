/**
 * ice-config.ts — fetch the runtime ICE-server manifest and return an
 * `RTCIceServer[]` ready to drop into a WebRTC transport
 * (`webRTC({ rtcConfiguration: { iceServers: await loadIceConfig() } })`).
 *
 * Framework-free and self-contained — same constraint as `connection-path.ts`:
 * no `@serfab/cadre-core` / node deps, so the browser bundle stays lean and a
 * React Native port can mirror this file later. The only platform touch-points
 * are `fetch`, `localStorage`, and `import.meta.env`, each guarded.
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
 * Consumed by `web-webrtc-transport-to-bypass-relay` (ticket 3) — this file only
 * delivers the helper + schema; it does NOT wire the transport.
 *
 * TURN forward-pointers (do not lose when TURN is enabled):
 *  - TURN entries carry ephemeral credentials minted by a signing endpoint that
 *    does not exist yet — backlog `turn-credential-issuance-service`. Until then
 *    a well-formed manifest advertises STUN only (`turnPolicy: 'off'`).
 *  - A TURN-relayed WebRTC path is misclassified as `direct` by
 *    `connection-path.ts` (it only sees `/webrtc`) — backlog
 *    `turn-relayed-path-metrics`. Dormant while TURN is off.
 */

const LOG_PREFIX = '[reference-app-web] ice-config:';

/** localStorage key for a runtime manifest-URL override (debug / per-device). */
export const ICE_CONFIG_URL_STORAGE_KEY = 'ice-config-url';

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

/**
 * Resolve, fetch, and validate the ICE-config manifest, returning the
 * `RTCIceServer[]`. Returns `[]` on any failure (no URL configured, network
 * error, non-OK response, malformed body). Never throws.
 *
 * @param url Optional explicit manifest URL; otherwise resolved from
 *            `VITE_ICE_CONFIG_URL` then `localStorage['ice-config-url']`.
 */
export async function loadIceConfig(url?: string): Promise<RTCIceServer[]> {
  const target = resolveIceConfigUrl(url);
  if (!target) {
    // No URL configured → STUN-less but safe. Not an error; debug-level note only.
    console.debug(`${LOG_PREFIX} no manifest URL configured; running without STUN`);
    return [];
  }

  try {
    const res = await fetch(target, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`${LOG_PREFIX} fetch ${target} returned HTTP ${res.status}`);
      return [];
    }
    const data: unknown = await res.json();
    return parseIceServers(data);
  } catch (err) {
    console.warn(`${LOG_PREFIX} failed to load manifest from ${target}`, err);
    return [];
  }
}
