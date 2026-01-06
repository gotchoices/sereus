import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'

import { resolveTargets } from './lib/dnsaddr.mjs'

const TEST_PROTOCOL = '/sereus/ops/test/relay-bootstrap-pair/1.0.0'

function usage() {
  console.log(`Usage:
  yarn workspace @sereus/ops-test pair:listen -- \\
    --relay <multiaddr|/dnsaddr/...> \\
    --bootstrap <multiaddr|/dnsaddr/...> [--dns-mode auto|system|doh] [--verbose]

Notes:
- Intended to run on a NAT'd machine
- Dials relay + bootstrap to seed peerstore/routing
- Registers an ops test protocol handler and waits for inbound sessions`)
}

function parseArgs(argv) {
  const args = { dnsMode: 'auto', verbose: false }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--relay') args.relay = argv[++i]
    else if (a === '--bootstrap') args.bootstrap = argv[++i]
    else if (a === '--dns-mode') args.dnsMode = argv[++i] ?? 'auto'
    else if (a === '--verbose') args.verbose = true
    else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
    else throw new Error(`Unknown arg: ${a}`)
  }

  if (!args.relay) throw new Error('Missing --relay')
  if (!args.bootstrap) throw new Error('Missing --bootstrap')
  if (!['auto', 'system', 'doh'].includes(args.dnsMode)) throw new Error('Invalid --dns-mode')
  return args
}

async function main() {
  const args = parseArgs(process.argv)

  const peerId = await createEd25519PeerId()

  const node = await createLibp2p({
    peerId,
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      // Keep at least one connection open (helps prevent the relay reservation connection being pruned)
      minConnections: 1,
      maxConnections: 32
    },
    services: {
      identify: identify(),
      ping: ping(),
      // For bootstrap-only peer routing, the listener needs to participate enough that
      // the bootstrap node can learn/store it in routing tables. Server mode allows
      // the bootstrap peer to open DHT protocol streams back over the existing connection.
      dht: kadDHT({ clientMode: false })
    }
  })

  await node.start()

  const relayTargets = await resolveTargets(args.relay, args.dnsMode)
  const bootstrapTargets = await resolveTargets(args.bootstrap, args.dnsMode)

  if (args.verbose) {
    console.log(`relay targets (${relayTargets.length}):`)
    relayTargets.forEach(ma => console.log(`  ${ma.toString()}`))
    console.log(`bootstrap targets (${bootstrapTargets.length}):`)
    bootstrapTargets.forEach(ma => console.log(`  ${ma.toString()}`))
  }

  // Listen on the relay via /p2p-circuit so we advertise a relayed address.
  // This is required for "bootstrap-only discovery" (`dht.findPeer`) to return a usable p2p-circuit address.
  const relayPeerIdStr = relayTargets[0].getComponents().find(c => c.name === 'p2p')?.value
  if (!relayPeerIdStr) throw new Error(`Relay multiaddr is missing /p2p/<peerId>: ${relayTargets[0].toString()}`)
  const relayPeerId = peerIdFromString(relayPeerIdStr)

  const transports = node.components.transportManager.getTransports()
  const relayTransport = transports.find(t => t?.[Symbol.toStringTag] === '@libp2p/circuit-relay-v2-transport' && t?.reservationStore != null)
  if (!relayTransport) throw new Error('Could not find circuit relay transport instance on this libp2p node')

  if (args.verbose) {
    relayTransport.reservationStore.addEventListener('relay:created-reservation', (evt) => {
      console.log(`[listener] relay reservation created for relay=${evt.detail.relay.toString()}`)
    })
    relayTransport.reservationStore.addEventListener('relay:removed', (evt) => {
      console.log(`[listener] relay reservation removed for relay=${evt.detail.relay.toString()}`)
    })
  }

  const relayListenAddr = multiaddr(relayTargets[0].toString()).encapsulate('/p2p-circuit')
  await node.components.transportManager.listen([relayListenAddr])

  if (args.verbose) {
    console.log(`[listener] hasReservation(relay)=${relayTransport.reservationStore.hasReservation(relayPeerId)}`)
    const r = relayTransport.reservationStore.getReservation(relayPeerId)
    console.log(`[listener] reservation.expire=${r?.expire ?? '(none)'} addrs=${r?.addrs?.length ?? 0}`)
  }

  // Keep the relay connection alive so STOP streams can be opened back to us.
  // Without this, relayed dials can fail if the relay/client connection is pruned.
  setInterval(() => {
    // best-effort
    void node.services.ping.ping(relayPeerId).catch(() => {})
  }, 20_000)

  // Dial bootstrap AFTER we have a relayed addr, so identify can advertise p2p-circuit addrs to the DHT overlay.
  await node.dial(bootstrapTargets[0])

  // Ensure we actually speak DHT to the bootstrap so we get added to routing tables.
  try {
    await node.services.dht.refreshRoutingTable()
  } catch (e) {
    console.log(`warning: dht.refreshRoutingTable failed (${e?.message ?? String(e)})`)
  }

  await node.handle(TEST_PROTOCOL, async ({ stream, connection }) => {
    if (args.verbose) {
      console.log(`[listener] inbound stream from=${connection.remotePeer.toString()} protocol=${TEST_PROTOCOL}`)
    }

    const decoder = new TextDecoder()
    let msg = ''
    for await (const chunk of stream.source) {
      // chunk may be a Uint8ArrayList
      msg += decoder.decode(chunk.subarray ? chunk.subarray() : chunk, { stream: true })
      if (msg.includes('\n')) break
    }

    if (args.verbose) {
      console.log(`[listener] received bytes=${msg.length} msg=${JSON.stringify(msg.trim())}`)
    }

    const response = JSON.stringify({
      ok: true,
      received: msg.trim(),
      fromPeer: connection.remotePeer.toString(),
      listenerPeer: node.peerId.toString()
    })

    const encoder = new TextEncoder()
    async function* out() { yield encoder.encode(response + '\n') }
    await stream.sink(out()).catch((e) => {
      console.log(`[listener] write failed: ${e?.message ?? String(e)}`)
      throw e
    })
    try { stream.closeWrite?.() } catch {}

    if (args.verbose) {
      console.log('[listener] response sent')
    }
  }, { runOnLimitedConnection: true })

  const addrs = node.getMultiaddrs().map(a => a.toString())
  const circuitAddrs = addrs.filter(a => a.includes('p2p-circuit'))

  console.log(`listener peerId=${node.peerId.toString()}`)
  console.log('listener addrs:')
  addrs.forEach(a => console.log(`  ${a}`))

  // Always print a deterministic dial address that includes the relay PeerId.
  console.log('copy/paste dial address (via relay):')
  console.log(`  ${relayTargets[0].toString()}/p2p-circuit/p2p/${node.peerId.toString()}`)

  if (circuitAddrs.length === 0) {
    console.log('note: no p2p-circuit addresses are currently advertised')
    console.log('      (this can happen briefly; you can still use the copy/paste dial address above)')
  } else {
    console.log('listener relayed addrs (p2p-circuit):')
    circuitAddrs.forEach(a => console.log(`  ${a}`))
  }

  process.stdin.resume()
}

main().catch(err => {
  console.error(err?.stack ?? String(err))
  process.exit(1)
})


