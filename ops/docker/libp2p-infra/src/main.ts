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
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

import { isWebSocketAddr, parseAnnounceAddrs, parseBooleanEnv, parseListenAddrs, parsePositiveIntEnv } from './env.js'

// This image runs a single role: a libp2p Circuit Relay v2 hop. Sereus has no global DHT to
// bootstrap — each strand is its own FRET ring, and nodes are reached by dialing a known
// participating node directly or through a relay like this one. (The former kad-DHT
// `bootstrap` role was removed once cadre-core replaced kad-DHT with FRET.)

// `/data` is the container volume; override when running the process directly on a
// workstation. The identity key is stored here, so a stable DATA_DIR means a stable peer
// id across restarts — which matters because clients pin the relay's /p2p/<peerId>.
const DATA_DIR = (process.env.DATA_DIR ?? '').trim() || '/data'
const KEY_FILE = path.join(DATA_DIR, 'libp2p-private.key.pb')

async function loadOrCreatePrivateKey () {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const stored = await readKeyFile()
  if (stored) return decodeKey(stored)
  const pk = await generateKeyPair('Ed25519')
  await fs.writeFile(KEY_FILE, privateKeyToProtobuf(pk))
  console.log(`generated a new identity key: ${KEY_FILE}`)
  return pk
}

/** The stored bytes as a key — a damaged file names itself rather than surfacing as a protobuf error. */
function decodeKey (raw: Uint8Array) {
  try {
    return privateKeyFromProtobuf(raw)
  } catch (err) {
    throw new Error(`Identity key ${KEY_FILE} is not a valid key file: ${err?.message ?? err}. Restore it from backup (ops/docs/keys.md); deleting it would change this node's peer id.`, { cause: err })
  }
}

/**
 * The stored identity key, or `undefined` when there is none yet.
 *
 * Only a missing file means "generate one" — `ops/docs/keys.md` says the key is created on
 * first start *if missing*, and every other read failure (a permission problem, a bad
 * sector, a volume that did not mount) has to stay fatal. Generating over one of those
 * would hand the node a new peer id, which every client pins as `/p2p/<peerId>` and no
 * operator would be told about.
 */
async function readKeyFile () {
  try {
    return await fs.readFile(KEY_FILE)
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined
    throw new Error(`Cannot read identity key ${KEY_FILE}: ${err?.message ?? err}. Refusing to generate a new one - that would change this node's peer id.`, { cause: err })
  }
}

const announce = parseAnnounceAddrs()
const listen = parseListenAddrs()

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
  ping: ping(),
  relay: circuitRelayServer({
    reservations: {
      applyDefaultLimit: RELAY_APPLY_DEFAULT_LIMIT,
      maxReservations: RELAY_MAX_RESERVATIONS
    }
  })
}

const node = await createLibp2p({
  privateKey: await loadOrCreatePrivateKey(),
  addresses: {
    listen,
    ...(announce ? { announce } : {})
  },
  transports: [tcp(), webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  // Tolerate peers whose event loop is saturated, without giving up on dead ones.
  //
  // libp2p pings every connection every 10 s and, by default, ABORTS it when the
  // ping times out. The ping uses an AdaptiveTimeout that widens on failure — but
  // it starts at `minTimeout` (5 s) and the abort destroys the connection on the
  // FIRST miss, so the widened timeout is never applied to the peer that earned it.
  //
  // A React Native client runs Noise's crypto in pure JavaScript under an engine
  // with no JIT (`@chainsafe/libp2p-noise` resolves its browser build there, where
  // `defaultCrypto = pureJsCrypto`). On a 2016 handset a single handshake costs
  // ~231 ms of CPU and a strand bring-up needs thousands of frames, so the JS loop
  // is saturated for long stretches and cannot answer a 5 s ping. The relay then
  // drops the connection, the client re-dials, the new connection costs another
  // handshake, and the cost of re-connecting is what prevents it ever catching up.
  //
  // Measured against a two-party relayed bring-up carrying the full measured
  // device crypto cost (gotchoices/sereus#13):
  //
  //   stock (5 s-60 s)                     0 of 3 runs completed
  //   ping every 60 s instead of 10 s      0 of 2   (it is not the frequency)
  //   ceiling raised to 120 s only         0 of 2   (it is not the ceiling)
  //   floor raised to 30 s only            2 of 3
  //   floor 30 s + ceiling 600 s (this)    4 of 4   ~90 s, i.e. slow but correct
  //
  // The floor matters most: adaptation cannot help a connection that is already
  // destroyed. Reclamation is preserved — a peer that truly stops answering is
  // still dropped, after ten minutes rather than five seconds, which is the right
  // trade for a relay whose job is to keep unreachable clients reachable.
  connectionMonitor: {
    pingTimeout: {
      minTimeout: 30_000,
      maxTimeout: 600_000
    }
  },
  services
})

await node.start()

console.log(`relay peerId=${node.peerId.toString()}`)
console.log(`relay reservations: applyDefaultLimit=${RELAY_APPLY_DEFAULT_LIMIT} maxReservations=${RELAY_MAX_RESERVATIONS}`)
console.log('listening/advertising on:')
const addrs = node.getMultiaddrs().map(ma => ma.toString())
addrs.forEach(ma => console.log(`  ${ma}`))

// Phones dial WebSockets, so surface those separately — this is the address a
// mobile client needs in its relay configuration.
const wsAddrs = addrs.filter(isWebSocketAddr)
if (wsAddrs.length > 0) {
  console.log('\nWebSocket addresses (for clients without raw TCP, e.g. React Native):')
  wsAddrs.forEach(ma => console.log(`  ${ma}`))
} else if (listen.some(isWebSocketAddr)) {
  // A non-empty ANNOUNCE_ADDRS REPLACES the advertised set rather than extending it, so a
  // fronted node that announces only its TCP address binds WebSockets and tells nobody.
  // That is silent: the listener is up, and the block above simply prints nothing.
  console.warn([
    '',
    'WARNING: listening on WebSockets but advertising no WebSocket address.',
    'ANNOUNCE_ADDRS replaces the advertised set, so clients without raw TCP (e.g. React',
    'Native) cannot reach this node. Add the address they should dial to ANNOUNCE_ADDRS -',
    'behind a TLS front that is /dns4/<host>/tcp/443/tls/ws.'
  ].join('\n'))
}
