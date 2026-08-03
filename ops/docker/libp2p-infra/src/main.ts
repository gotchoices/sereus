// @ts-nocheck
import fs from 'node:fs/promises'
import path from 'node:path'

import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
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

const DATA_DIR = '/data'
const KEY_FILE = path.join(DATA_DIR, 'libp2p-private.key.pb')

function parseAnnounceAddrs (): string[] | undefined {
  const raw = (process.env.ANNOUNCE_ADDRS ?? '').trim()
  if (!raw) return undefined
  return raw.split(',').map(s => s.trim()).filter(Boolean)
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
// reservation with a data/duration cap and marks the resulting connection "limited" -
// libp2p then refuses newStream()/inbound streams on it unless the caller opts in with
// runOnLimitedConnection, which none of the db-p2p services or sereus control protocols do.
// This relay is unauthenticated, so lifting the cap trades a bandwidth brake for usable
// relayed traffic; RELAY_APPLY_DEFAULT_LIMIT=true restores libp2p's default for a public
// deployment that wants the brake back.
const RELAY_APPLY_DEFAULT_LIMIT = parseBooleanEnv('RELAY_APPLY_DEFAULT_LIMIT', false)
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
    listen: ['/ip4/0.0.0.0/tcp/4001'],
    ...(announce ? { announce } : {})
  },
  transports: [tcp()],
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
node.getMultiaddrs().forEach(ma => console.log(ma.toString()))


