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
import { multiaddr } from '@multiformats/multiaddr'

import { resolveTargets } from './lib/dnsaddr.mjs'

const TEST_PROTOCOL = '/sereus/ops/test/relay-bootstrap-pair/1.0.0'

function usage() {
  console.log(`Usage:
  yarn workspace @sereus/ops-test pair:dial -- \\
    --bootstrap <multiaddr|/dnsaddr/...> \\
    [--peer <peerId>] [--relay <multiaddr|/dnsaddr/...>] [--dial-addr <multiaddr>] [--dns-mode auto|system|doh] [--timeout-ms N] [--verbose]

Behavior:
- Dials bootstrap to join overlay
- Uses DHT peer routing (findPeer) to discover the listener addrs
- Prefers a discovered p2p-circuit addr; falls back to synthesizing via --relay
- Opens a test protocol stream over the resulting connection and exchanges a request/response`)
}

function parseArgs(argv) {
  const args = { dnsMode: 'auto', timeoutMs: 30000, verbose: false }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--bootstrap') args.bootstrap = argv[++i]
    else if (a === '--peer') args.peer = argv[++i]
    else if (a === '--relay') args.relay = argv[++i]
    else if (a === '--dial-addr') args.dialAddr = argv[++i]
    else if (a === '--dns-mode') args.dnsMode = argv[++i] ?? 'auto'
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else if (a === '--verbose') args.verbose = true
    else if (a === '--bootstrap-check') args.bootstrapCheck = true
    else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
    else throw new Error(`Unknown arg: ${a}`)
  }

  if (!args.bootstrap) throw new Error('Missing --bootstrap')
  if (!['auto', 'system', 'doh'].includes(args.dnsMode)) throw new Error('Invalid --dns-mode')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('Invalid --timeout-ms')
  if (!args.peer && !args.dialAddr) throw new Error('Missing --peer (or provide --dial-addr)')

  if (!args.peer && args.dialAddr) {
    const ma = multiaddr(args.dialAddr)
    const comps = ma.getComponents().filter(c => c.name === 'p2p')
    const pid = comps.at(-1)?.value
    if (!pid) throw new Error(`--dial-addr must include trailing /p2p/<peerId>: ${args.dialAddr}`)
    args.peer = pid
  }

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
  if (args.verbose) {
    console.log(`bootstrap targets (${bootstrapTargets.length}):`)
    bootstrapTargets.forEach(ma => console.log(`  ${ma.toString()}`))
  }
  await node.dial(bootstrapTargets[0])

  // Optional: validate the bootstrap node is answering DHT queries.
  if (args.bootstrapCheck) {
    const bootstrapPeerIdStr = bootstrapTargets[0].getComponents().find(c => c.name === 'p2p')?.value
    if (!bootstrapPeerIdStr) {
      throw new Error(`Bootstrap multiaddr is missing /p2p/<peerId>: ${bootstrapTargets[0].toString()}`)
    }

    const bootstrapPeerId = peerIdFromString(bootstrapPeerIdStr)
    const events = []
    await withTimeout(args.timeoutMs, async (signal) => {
      for await (const ev of node.services.dht.findPeer(bootstrapPeerId, { signal })) {
        events.push(ev)
        if (ev?.name === 'FINAL_PEER') break
        if (ev?.name === 'QUERY_ERROR') break
      }
    }, 'bootstrap dht.findPeer')

    const ok = events.some(e => e?.name === 'FINAL_PEER')
    if (!ok) {
      const err = events.find(e => e?.name === 'QUERY_ERROR')
      throw new Error(`bootstrap dht.findPeer failed${err ? ` (QUERY_ERROR: ${err.error?.message ?? String(err.error)})` : ''}`)
    }
    console.log('bootstrap dht check: ok')
  }

  const targetPeerId = peerIdFromString(args.peer)

  // Phase 1: explicit dial address (bypass discovery)
  if (args.dialAddr) {
    console.log(`dialing via (explicit --dial-addr): ${args.dialAddr}`)
    const stream = await node.dialProtocol(multiaddr(args.dialAddr), [TEST_PROTOCOL], { runOnLimitedConnection: true })
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({ hello: 'world', targetPeer: args.peer }) + '\n')
    if (args.verbose) console.log(`[dialer] writing bytes=${payload.byteLength}`)

    async function* out() { yield payload }
    await stream.sink(out()).catch((e) => {
      console.log(`[dialer] write failed: ${e?.message ?? String(e)}`)
      throw e
    })
    try { stream.closeWrite?.() } catch {}

    const decoder = new TextDecoder()
    let msg = ''
    for await (const chunk of stream.source) {
      msg += decoder.decode(chunk.subarray ? chunk.subarray() : chunk, { stream: true })
      if (msg.includes('\n')) break
    }
    console.log('pair response:', msg.trim())
    return
  }

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
    const relayTargets = await resolveTargets(args.relay, args.dnsMode)
    if (args.verbose) {
      console.log(`relay targets (${relayTargets.length}):`)
      relayTargets.forEach(ma => console.log(`  ${ma.toString()}`))
    }

    // Ensure the relay peer is in the peerstore and we have a non-relayed connection to it.
    await node.dial(relayTargets[0])

    // IMPORTANT: use the *resolved* relay multiaddr (includes /p2p/<relayPeerId>)
    dialAddr = `${relayTargets[0].toString()}/p2p-circuit/p2p/${args.peer}`
  }

  if (!dialAddr) {
    console.log('discovered peer addrs:')
    discoveredAddrs.forEach(a => console.log(`  ${a}`))
    throw new Error(`No p2p-circuit address discovered for target peer, and no --relay provided for fallback synthesis${err ? ` (QUERY_ERROR: ${err.error?.message ?? String(err.error)})` : ''}`)
  }

  console.log(`dialing via: ${dialAddr}`)
  const stream = await node.dialProtocol(multiaddr(dialAddr), [TEST_PROTOCOL], { runOnLimitedConnection: true })
  const encoder = new TextEncoder()
  const payload = encoder.encode(JSON.stringify({ hello: 'world', targetPeer: args.peer }) + '\n')
  if (args.verbose) console.log(`[dialer] writing bytes=${payload.byteLength}`)

  async function* out() { yield payload }
  await stream.sink(out()).catch((e) => {
    console.log(`[dialer] write failed: ${e?.message ?? String(e)}`)
    throw e
  })
  try { stream.closeWrite?.() } catch {}

  const decoder = new TextDecoder()
  let msg = ''
  for await (const chunk of stream.source) {
    msg += decoder.decode(chunk.subarray ? chunk.subarray() : chunk, { stream: true })
    if (msg.includes('\n')) break
  }
  console.log('pair response:', msg.trim())
}

main().catch(err => {
  console.error(err?.stack ?? String(err))
  process.exit(1)
})


