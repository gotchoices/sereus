import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import { peerIdFromString } from '@libp2p/peer-id'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'

import { createBootstrapManager, DEFAULT_PROTOCOL_ID } from '@sereus/bootstrap'
import { resolveTargets } from './lib/dnsaddr.mjs'

function usage() {
  console.log(`Usage:
  yarn workspace @sereus/ops-test pair:dial -- \\
    --bootstrap <multiaddr|/dnsaddr/...> \\
    --peer <peerId> [--relay <multiaddr|/dnsaddr/...>] [--dns-mode auto|system|doh] [--timeout-ms N]

Behavior:
- Dials bootstrap to join overlay
- Uses DHT peer routing (findPeer) to discover the listener addrs
- Prefers a discovered p2p-circuit addr; falls back to synthesizing via --relay
- Runs the Sereus bootstrap protocol over the resulting connection`)
}

function parseArgs(argv) {
  const args = { dnsMode: 'auto', timeoutMs: 30000 }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--bootstrap') args.bootstrap = argv[++i]
    else if (a === '--peer') args.peer = argv[++i]
    else if (a === '--relay') args.relay = argv[++i]
    else if (a === '--dns-mode') args.dnsMode = argv[++i] ?? 'auto'
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
    else throw new Error(`Unknown arg: ${a}`)
  }

  if (!args.bootstrap) throw new Error('Missing --bootstrap')
  if (!args.peer) throw new Error('Missing --peer')
  if (!['auto', 'system', 'doh'].includes(args.dnsMode)) throw new Error('Invalid --dns-mode')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('Invalid --timeout-ms')
  return args
}

async function withTimeout(ms, fn, label = 'operation') {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(new Error(`${label} timed out after ${ms}ms`)), ms)
  try {
    return await fn(ac.signal)
  } finally {
    clearTimeout(t)
  }
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

  const bootstrapTargets = await resolveTargets(args.bootstrap, args.dnsMode)
  await node.dial(bootstrapTargets[0])

  const targetPeerId = peerIdFromString(args.peer)

  const events = []
  try {
    // Give the DHT a moment to populate tables from the bootstrap connection.
    await new Promise(resolve => setTimeout(resolve, 750))
    try { await node.services.dht.refreshRoutingTable() } catch {}

    await withTimeout(args.timeoutMs, async (signal) => {
      for await (const ev of node.services.dht.findPeer(targetPeerId, { signal })) {
        events.push(ev)
        if (ev?.name === 'FINAL_PEER') break
        if (ev?.name === 'QUERY_ERROR') break
      }
    }, 'dht.findPeer')
  } catch (e) {
    // If DHT lookup fails/times out but we have a relay address, we can still test relay connectivity
    // by synthesizing the p2p-circuit dial address.
    if (!args.relay) throw e
    console.log(`warning: dht.findPeer failed (${e?.message ?? String(e)}); falling back to --relay synthesis`)
  }

  const final = events.find(e => e?.name === 'FINAL_PEER')
  const err = events.find(e => e?.name === 'QUERY_ERROR')

  const discoveredAddrs = final
    ? (final.peer?.multiaddrs ?? []).map(ma => ma.toString())
    : []

  const circuitAddr = discoveredAddrs.find(a => a.includes('p2p-circuit'))

  let dialAddr = circuitAddr
  if (!dialAddr && args.relay) {
    dialAddr = `${args.relay}/p2p-circuit/p2p/${args.peer}`
  }

  if (!dialAddr) {
    console.log('discovered peer addrs:')
    discoveredAddrs.forEach(a => console.log(`  ${a}`))
    throw new Error(`No p2p-circuit address discovered for target peer, and no --relay provided for fallback synthesis${err ? ` (QUERY_ERROR: ${err.error?.message ?? String(err.error)})` : ''}`)
  }

  const hooks = {
    async validateToken() { return { mode: 'responderCreates', valid: true } },
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

  const link = {
    responderPeerAddrs: [dialAddr],
    token: 'responder-token',
    tokenExpiryUtc: new Date(Date.now() + 60_000).toISOString(),
    mode: 'responderCreates'
  }

  console.log(`dialing via: ${dialAddr}`)
  const result = await mgr.initiateBootstrap(link, node)
  console.log('Bootstrap result:', result)
}

main().catch(err => {
  console.error(err?.stack ?? String(err))
  process.exit(1)
})


