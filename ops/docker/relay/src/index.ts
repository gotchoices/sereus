// @ts-nocheck
import fs from 'node:fs/promises'
import path from 'node:path'

import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

const DATA_DIR = process.env.DATA_DIR ?? '/data'
const KEY_FILE = process.env.KEY_FILE ?? path.join(DATA_DIR, 'libp2p-private.key.pb')

function parseListenTcp (): { host: string, port: number } {
  const raw = process.env.LISTEN_TCP ?? '0.0.0.0:4001'
  const [host, portStr] = raw.split(':')
  const port = Number(portStr)
  if (!host || !Number.isFinite(port)) throw new Error(`Invalid LISTEN_TCP: ${raw}`)
  return { host, port }
}

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

const { host, port } = parseListenTcp()
const announce = parseAnnounceAddrs()

const node = await createLibp2p({
  privateKey: await loadOrCreatePrivateKey(),
  addresses: {
    listen: [`/ip4/${host}/tcp/${port}`],
    ...(announce ? { announce } : {})
  },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    relay: circuitRelayServer()
  }
})

await node.start()

console.log(`relay peerId=${node.peerId.toString()}`)
console.log('listening/advertising on:')
node.getMultiaddrs().forEach(ma => console.log(ma.toString()))


