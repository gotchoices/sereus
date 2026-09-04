// @ts-nocheck
// NOTE: the `@ts-nocheck` is load-bearing only for `createLibp2p({ privateKey })`: npm resolves a
// second, nested `@libp2p/interface` under `@multiformats/dns`, so the key types are nominally
// incompatible. Everything else in this file type-checks clean with the directive removed - if a
// future dependency bump collapses that duplicate, drop it rather than keeping the whole file
// unchecked.
import fs from 'node:fs/promises'
import path from 'node:path'

import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { kadDHT } from '@libp2p/kad-dht'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

type Role = 'relay' | 'bootstrap' | 'bootstrap-relay'

const ROLE = (process.env.SEREUS_ROLE ?? '').trim() as Role
if (!ROLE || !['relay', 'bootstrap', 'bootstrap-relay'].includes(ROLE)) {
  throw new Error(`Missing/invalid SEREUS_ROLE. Expected one of: relay|bootstrap|bootstrap-relay (got ${JSON.stringify(process.env.SEREUS_ROLE)})`)
}

// `/data` is the container volume; override when running the process directly
// on a workstation (see chat's scripts/relay.sh).  The identity key is stored
// here, so a stable DATA_DIR means a stable peer id across restarts — which
// matters because clients pin the relay's /p2p/<peerId> in their config.
const DATA_DIR = (process.env.DATA_DIR ?? '').trim() || '/data'
const KEY_FILE = path.join(DATA_DIR, 'libp2p-private.key.pb')

function parseAnnounceAddrs (): string[] | undefined {
  const raw = (process.env.ANNOUNCE_ADDRS ?? '').trim()
  if (!raw) return undefined
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Listen addresses.  Defaults to TCP *and* WebSockets: React Native has no raw
 * TCP transport, so a phone can only reach this over `/ws` (or `/wss` behind a
 * TLS front — see ANNOUNCE_ADDRS).  Override to listen on one transport only.
 */
const DEFAULT_LISTEN_ADDRS = ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002/ws']

function parseListenAddrs (): string[] {
  const raw = (process.env.LISTEN_ADDRS ?? '').trim()
  if (!raw) return DEFAULT_LISTEN_ADDRS
  const addrs = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (addrs.length === 0) {
    throw new Error(`Invalid LISTEN_ADDRS. Expected comma-separated multiaddrs (got ${JSON.stringify(process.env.LISTEN_ADDRS)})`)
  }
  return addrs
}

function parseBooleanEnv (name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return defaultValue
  if (raw.toLowerCase() === 'true') return true
  if (raw.toLowerCase() === 'false') return false
  throw new Error(`Invalid ${name}. Expected true|false (got ${JSON.stringify(process.env[name])})`)
}

function parsePositiveIntEnv (name: string, defaultValue: number): number {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return defaultValue
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}. Expected a positive integer (got ${JSON.stringify(process.env[name])})`)
  }
  return n
}

async function loadOrCreatePrivateKey () {
  await fs.mkdir(DATA_DIR, { recursive: true })
  try {
    const raw = await fs.readFile(KEY_FILE)
    return privateKeyFromProtobuf(raw)
  } catch {
    const pk = await generateKeyPair('Ed25519')
    await fs.writeFile(KEY_FILE, privateKeyToProtobuf(pk))
    return pk
  }
}

const announce = parseAnnounceAddrs()

// @libp2p/circuit-relay-v2 defaults to applyDefaultLimit: true, which stamps every
// reservation with a ~128 KiB / 2 min cap and marks the resulting connection "limited" -
// libp2p then refuses newStream()/inbound streams on it unless BOTH sides opt in with
// runOnLimitedConnection. Only the sereus strand wake/addr protocols opt in; db-p2p's four
// database services (repo, cluster, sync, block-transfer) register their handlers without it,
// as does seed delivery, so their relayed streams are aborted outright - and even the
// opted-in protocols still die once a relayed connection crosses the cap.
// This relay is unauthenticated, so lifting the cap trades a bandwidth brake for usable
// relayed traffic; RELAY_APPLY_DEFAULT_LIMIT=true restores libp2p's default for a public
// deployment that wants the brake back.
const RELAY_APPLY_DEFAULT_LIMIT = parseBooleanEnv('RELAY_APPLY_DEFAULT_LIMIT', false)
// NOTE: 500 slots is sized well past any cadre this repo describes, and the store is one Map
// entry per peer, so the cost is negligible. Two conditions would make it worth revisiting:
// a party relay whose members exhaust 500 slots (raise this), or sustained circuit setup past
// circuitRelayServer's maxOutboundStopStreams default of 300 - that cap is on concurrent
// connection SETUP, not on held reservations, so it only bites if hundreds of clients dial
// through at the same instant.
const RELAY_MAX_RESERVATIONS = parsePositiveIntEnv('RELAY_MAX_RESERVATIONS', 500)

const services: Record<string, any> = {
  identify: identify(),
  ping: ping()
}

if (ROLE === 'relay' || ROLE === 'bootstrap-relay') {
  services.relay = circuitRelayServer({
    reservations: {
      applyDefaultLimit: RELAY_APPLY_DEFAULT_LIMIT,
      maxReservations: RELAY_MAX_RESERVATIONS
    }
  })
}

if (ROLE === 'bootstrap' || ROLE === 'bootstrap-relay') {
  services.dht = kadDHT({ clientMode: false })
}

const node = await createLibp2p({
  privateKey: await loadOrCreatePrivateKey(),
  addresses: {
    listen: parseListenAddrs(),
    ...(announce ? { announce } : {})
  },
  transports: [tcp(), webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services
})

await node.start()

console.log(`${ROLE} peerId=${node.peerId.toString()}`)
if (ROLE === 'relay' || ROLE === 'bootstrap-relay') {
  console.log(`relay reservations: applyDefaultLimit=${RELAY_APPLY_DEFAULT_LIMIT} maxReservations=${RELAY_MAX_RESERVATIONS}`)
}
console.log('listening/advertising on:')
const addrs = node.getMultiaddrs().map(ma => ma.toString())
addrs.forEach(ma => console.log(`  ${ma}`))

// Phones dial WebSockets, so surface those separately — this is the address a
// mobile client needs in its relay configuration.
const wsAddrs = addrs.filter(ma => ma.includes('/ws'))
if (wsAddrs.length > 0) {
  console.log('\nWebSocket addresses (for clients without raw TCP, e.g. React Native):')
  wsAddrs.forEach(ma => console.log(`  ${ma}`))
}


