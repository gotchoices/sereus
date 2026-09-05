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
 * image is a standalone deployable with its own dependency tree — still on libp2p 2.x while
 * the workspace is on 3.x — so the rules are mirrored here rather than imported.
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
