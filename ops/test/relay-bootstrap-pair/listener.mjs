import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'

import { createBootstrapManager, DEFAULT_PROTOCOL_ID } from '@sereus/bootstrap'
import { resolveTargets } from './lib/dnsaddr.mjs'

function usage() {
  console.log(`Usage:
  yarn workspace @sereus/ops-test pair:listen -- \\
    --relay <multiaddr|/dnsaddr/...> \\
    --bootstrap <multiaddr|/dnsaddr/...> [--dns-mode auto|system|doh]

Notes:
- Intended to run on a NAT'd machine
- Dials relay + bootstrap to seed peerstore/routing
- Registers Sereus bootstrap protocol handler and waits for inbound sessions`)
}

function parseArgs(argv) {
  const args = { dnsMode: 'auto' }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--relay') args.relay = argv[++i]
    else if (a === '--bootstrap') args.bootstrap = argv[++i]
    else if (a === '--dns-mode') args.dnsMode = argv[++i] ?? 'auto'
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
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT()
    }
  })

  await node.start()

  const relayTargets = await resolveTargets(args.relay, args.dnsMode)
  const bootstrapTargets = await resolveTargets(args.bootstrap, args.dnsMode)

  await node.dial(relayTargets[0])
  await node.dial(bootstrapTargets[0])

  // Ensure we actually speak DHT to the bootstrap so we get added to routing tables.
  try {
    await node.services.dht.refreshRoutingTable()
  } catch (e) {
    console.log(`warning: dht.refreshRoutingTable failed (${e?.message ?? String(e)})`)
  }

  const hooks = {
    async validateToken(token) {
      return { mode: token.includes('initiator') ? 'initiatorCreates' : 'responderCreates', valid: true }
    },
    async validateIdentity() { return true },
    async provisionStrand(creator) {
      return {
        strand: { strandId: `str-${Date.now()}`, createdBy: creator },
        dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' }
      }
    },
    async validateResponse() { return true },
    async validateDatabaseResult() { return true }
  }

  const mgr = createBootstrapManager(hooks, { protocolId: DEFAULT_PROTOCOL_ID, enableDebugLogging: true })
  mgr.register(node)

  const addrs = node.getMultiaddrs().map(a => a.toString())
  const circuitAddrs = addrs.filter(a => a.includes('p2p-circuit'))

  console.log(`listener peerId=${node.peerId.toString()}`)
  console.log('listener addrs:')
  addrs.forEach(a => console.log(`  ${a}`))

  if (circuitAddrs.length === 0) {
    console.log('note: no p2p-circuit addresses are currently advertised')
    console.log('      a deterministic dial address is:')
    console.log(`      ${args.relay}/p2p-circuit/p2p/${node.peerId.toString()}`)
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


