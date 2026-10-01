/**
 * The image's environment contract, parsed and validated in one place.
 *
 * Kept out of `main.ts` because that file carries a `@ts-nocheck` for one libp2p typing
 * quirk; everything here type-checks normally, which is what the validation rules below
 * deserve. `../README.md` documents the same contract for operators.
 */

import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'

/**
 * Listen addresses when `LISTEN_ADDRS` is unset. TCP *and* WebSockets: React Native has no
 * raw TCP transport, so a phone can only reach this over `/ws` (or `/wss` behind a TLS
 * front — see `ANNOUNCE_ADDRS`). `4002/ws` is the port the RN client and the drone configs
 * in `docs/reference-app-rn.md` already expect.
 */
export const DEFAULT_LISTEN_ADDRS = ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002/ws']

/** The multiaddrs to bind. Throws, naming `LISTEN_ADDRS`, when any entry is malformed. */
export function parseListenAddrs (): string[] {
  return parseMultiaddrList('LISTEN_ADDRS') ?? DEFAULT_LISTEN_ADDRS
}

/** The multiaddrs to advertise instead of the bound ones, or `undefined` when unset. */
export function parseAnnounceAddrs (): string[] | undefined {
  return parseMultiaddrList('ANNOUNCE_ADDRS')
}

/** Which setting produced the advertised address set — logged at startup. */
export type AnnounceSource = 'ANNOUNCE_ADDRS' | 'PUBLIC_HOST' | 'bound'

/**
 * The addresses to advertise, and which setting produced them.
 *
 * - `ANNOUNCE_ADDRS` set: used verbatim. It REPLACES the advertised set (libp2p's
 *   `addresses.announce` semantics), so it must name every transport clients need.
 * - else `PUBLIC_HOST` set: one address per bound listener, on the public host and the
 *   public port for that transport (`deriveAnnounceAddrs`).
 * - else `undefined`: libp2p advertises what it bound. Inside a container that is loopback
 *   and the bridge IP, which no client can dial — the caller warns.
 */
export function resolveAnnounce (listen: string[]): { addrs: string[] | undefined, source: AnnounceSource } {
  const explicit = parseAnnounceAddrs()
  if (explicit) return { addrs: explicit, source: 'ANNOUNCE_ADDRS' }
  const host = parsePublicHost()
  if (!host) return { addrs: undefined, source: 'bound' }
  const addrs = deriveAnnounceAddrs(listen, {
    host,
    tcpPort: parsePortEnv('PUBLIC_TCP_PORT'),
    wsPort: parsePortEnv('PUBLIC_WS_PORT')
  })
  return { addrs, source: 'PUBLIC_HOST' }
}

export interface PublicEndpoint {
  /** DNS name or IP literal clients reach this node at. */
  host: string
  /** Port clients dial for the raw-TCP listener; the bound port when absent. */
  tcpPort?: number
  /** Port clients dial for the WebSocket listener; the bound port when absent. */
  wsPort?: number
}

/**
 * One advertised address per bound listener: the bound transport, on the public host and port.
 *
 * Advertise != bind. The relay stack binds WebSockets on container port 4002 and publishes it
 * as host 4011, and a home router may forward yet another port to the host — so the public
 * port is its own setting, defaulting to the bound one (right for a process run directly on
 * the host). No `/p2p` suffix: libp2p appends this node's peer id itself.
 *
 * Only raw TCP and plain WebSockets are derived, since those are the transports this image
 * runs. Any other listener, or a port override that two differently-bound listeners would
 * share, throws naming the variable — that is the point to write `ANNOUNCE_ADDRS` by hand.
 */
export function deriveAnnounceAddrs (listen: string[], endpoint: PublicEndpoint): string[] {
  const hostPart = hostComponent(endpoint.host)
  const out = new Set<string>()
  const boundPorts = { tcp: new Set<number>(), ws: new Set<number>() }
  for (const addr of listen) {
    const components = multiaddr(addr).getComponents()
    const shape = components.map(({ name }) => name).join('/')
    const kind = shape === 'ip4/tcp' || shape === 'ip6/tcp'
      ? 'tcp'
      : shape === 'ip4/tcp/ws' || shape === 'ip6/tcp/ws' ? 'ws' : undefined
    if (kind === undefined) {
      throw new Error(`PUBLIC_HOST cannot derive an advertised address for listener ${JSON.stringify(addr)}. Set ANNOUNCE_ADDRS instead.`)
    }
    const portVar = kind === 'tcp' ? 'PUBLIC_TCP_PORT' : 'PUBLIC_WS_PORT'
    const bound = Number(components.find(({ name }) => name === 'tcp')?.value)
    boundPorts[kind].add(bound)
    const port = (kind === 'tcp' ? endpoint.tcpPort : endpoint.wsPort) ?? bound
    if (port === 0) {
      throw new Error(`PUBLIC_HOST cannot advertise listener ${JSON.stringify(addr)}: it binds an ephemeral port. Set ${portVar} or ANNOUNCE_ADDRS.`)
    }
    out.add(`${hostPart}/tcp/${port}${kind === 'ws' ? '/ws' : ''}`)
  }
  if (endpoint.tcpPort !== undefined && boundPorts.tcp.size > 1) {
    throw new Error('PUBLIC_TCP_PORT is ambiguous: TCP listeners bind more than one port. Set ANNOUNCE_ADDRS instead.')
  }
  if (endpoint.wsPort !== undefined && boundPorts.ws.size > 1) {
    throw new Error('PUBLIC_WS_PORT is ambiguous: WebSocket listeners bind more than one port. Set ANNOUNCE_ADDRS instead.')
  }
  return [...out]
}

/** `PUBLIC_HOST`, or `undefined` when unset. Rejects values that cannot be one address component. */
function parsePublicHost (): string | undefined {
  const raw = (process.env.PUBLIC_HOST ?? '').trim()
  if (!raw) return undefined
  if (/[\s/,]/.test(raw)) {
    throw new Error(`Invalid PUBLIC_HOST. Expected a bare DNS name or IP address (got ${JSON.stringify(process.env.PUBLIC_HOST)})`)
  }
  return raw
}

/**
 * The multiaddr host part for `host`: `/ip4` or `/ip6` for a literal, else `/dns4` — the form
 * `ops/docs/dnsaddr.md` publishes. An IPv6-only name needs `ANNOUNCE_ADDRS` with `/dns6`.
 */
function hostComponent (host: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return `/ip4/${host}`
  if (host.includes(':')) return `/ip6/${host.replace(/^\[|\]$/g, '')}`
  return `/dns4/${host}`
}

/** A port from env, or `undefined` when unset. Throws naming the variable when out of range. */
function parsePortEnv (name: string): number | undefined {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid ${name}. Expected a port 1-65535 (got ${JSON.stringify(process.env[name])})`)
  }
  return n
}

export function parseBooleanEnv (name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return defaultValue
  if (raw.toLowerCase() === 'true') return true
  if (raw.toLowerCase() === 'false') return false
  throw new Error(`Invalid ${name}. Expected true|false (got ${JSON.stringify(process.env[name])})`)
}

export function parsePositiveIntEnv (name: string, defaultValue: number): number {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return defaultValue
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}. Expected a positive integer (got ${JSON.stringify(process.env[name])})`)
  }
  return n
}

/**
 * Whether `addr` is dialable by a client with no raw TCP — `/ws` or `/wss`, plain or behind
 * a TLS component. Reads the parsed protocol components rather than testing the string for
 * `/ws`, which would also match a future protocol whose name merely starts that way.
 */
export function isWebSocketAddr (addr: string): boolean {
  return multiaddr(addr).getComponents().some(({ name }) => name === 'ws' || name === 'wss')
}

/**
 * A comma-separated multiaddr env var, or `undefined` when it is unset or empty.
 *
 * libp2p does not validate these for us in any useful way: a bad announce addr is stored
 * as a raw string and only parsed on the first `getMultiaddrs()`, and a bad listen addr
 * surfaces as an `InvalidMultiaddrError` thrown from inside `@multiformats/multiaddr`,
 * with a stack trace and no mention of which variable was wrong. Every other variable this
 * image reads fails at startup naming itself, so these do too.
 *
 * `packages/cadre-core/src/announce-addrs.ts` holds the same rules for the CLI side. This
 * image is a standalone deployable with its own dependency tree, outside the workspace, so
 * the rules are mirrored here rather than imported.
 */
function parseMultiaddrList (name: string): string[] | undefined {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return undefined
  const addrs = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (addrs.length === 0) {
    throw new Error(`Invalid ${name}. Expected comma-separated multiaddrs (got ${JSON.stringify(process.env[name])})`)
  }
  return addrs.map(addr => validated(name, addr))
}

/** `addr` unchanged, having proved it names a real address — env var named on failure. */
function validated (name: string, addr: string): string {
  if (parsed(name, addr).getComponents().length === 0) {
    // `/` parses into a component-less multiaddr, so it survives the non-empty check above
    // while naming nothing at all. As a listen set that is a node bound to nothing; as an
    // announce set it costs the node every address it would otherwise advertise. An
    // `env.local` whose address variable went unsubstituted is the realistic way in.
    throw new Error(`Invalid ${name}. Entry names no address: ${JSON.stringify(addr)}`)
  }
  return addr
}

/** `addr` as a multiaddr, with the env var named on a parse failure. */
function parsed (name: string, addr: string): Multiaddr {
  try {
    return multiaddr(addr)
  } catch (err) {
    throw new Error(`Invalid ${name}. Not a valid multiaddr: ${JSON.stringify(addr)}`, { cause: err })
  }
}
