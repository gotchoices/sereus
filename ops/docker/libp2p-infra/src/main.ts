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

const services: Record<string, any> = {
  identify: identify(),
  ping: ping()
}

if (ROLE === 'relay' || ROLE === 'bootstrap-relay') {
  services.relay = circuitRelayServer()
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
console.log('listening/advertising on:')
node.getMultiaddrs().forEach(ma => console.log(ma.toString()))


