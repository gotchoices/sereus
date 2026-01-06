import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import { multiaddr } from '@multiformats/multiaddr'
import { dns, RecordType } from '@multiformats/dns'
import { dnsJsonOverHttps } from '@multiformats/dns/resolvers'

function usage () {
  console.log(`Usage:
  node sereus/ops/test/check-node.mjs --target <multiaddr|/dnsaddr/...> [--relay] [--dht] [--all] [--timeout-ms N] [--dns-mode auto|system|doh]

Options:
  --target       Required. A concrete multiaddr (must include /p2p/<peerId>) or /dnsaddr/<hostname>
  --relay        Expect the remote to advertise circuit relay protocols (heuristic check)
  --dht          Run a DHT query (dht.findPeer(remotePeerId)) and report success/failure
  --all          If --target resolves to multiple addresses, test all of them (default: first only)
  --timeout-ms   Overall per-target timeout (default: 15000)
  --dns-mode     DNS resolver strategy for /dnsaddr targets:
               - auto (default): try system DNS, fall back to DoH
               - system: use OS/system resolver only
               - doh: use DNS-over-HTTPS (Cloudflare/Google)
`)
}

function parseArgs (argv) {
  const args = {
    target: null,
    relay: false,
    dht: false,
    all: false,
    timeoutMs: 15000,
    dnsMode: 'auto'
  }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') args.target = argv[++i]
    else if (a === '--relay') args.relay = true
    else if (a === '--dht') args.dht = true
    else if (a === '--all') args.all = true
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else if (a === '--dns-mode') args.dnsMode = String(argv[++i] ?? '')
    else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
    else throw new Error(`Unknown arg: ${a}`)
  }

  if (!args.target) throw new Error('Missing --target')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('Invalid --timeout-ms')
  if (!['auto', 'system', 'doh'].includes(args.dnsMode)) throw new Error('Invalid --dns-mode (use auto|system|doh)')
  return args
}

async function withTimeout (ms, fn, label = 'operation') {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(new Error(`${label} timed out after ${ms}ms`)), ms)
  try {
    return await fn(ac.signal)
  } finally {
    clearTimeout(t)
  }
}

async function resolveTargets (targetStr, { dnsMode }) {
  const ma = multiaddr(targetStr)

  const hasDnsaddr = ma.getComponents().some(c => c.name === 'dnsaddr')
  if (!hasDnsaddr) return [ma]

  // multiaddr DNS resolvers may not be registered (or may be removed). Implement
  // DNSADDR resolution directly: query _dnsaddr.<hostname> TXT records containing
  // strings like "dnsaddr=<multiaddr>".
  return await resolveDnsaddrMultiaddr(ma, { dnsMode })
}

function getPeerIdStr (ma) {
  const comp = ma.getComponents().find(c => c.name === 'p2p')
  return comp?.value ?? null
}

function makeResolver (mode) {
  if (mode === 'doh') {
    // Use public resolvers to avoid local DNS propagation/caching issues.
    return dns({
      resolvers: {
        '.': [
          dnsJsonOverHttps('https://cloudflare-dns.com/dns-query'),
          dnsJsonOverHttps('https://dns.google/resolve')
        ]
      }
    })
  }

  // system resolver
  return dns()
}

async function resolveDnsaddrMultiaddr (ma, { maxDepth = 8, dnsMode = 'auto' } = {}) {
  if (maxDepth <= 0) {
    throw new Error('dnsaddr resolution exceeded max recursion depth')
  }

  const dnsaddrComp = ma.getComponents().find(c => c.name === 'dnsaddr')
  const hostname = dnsaddrComp?.value
  if (!hostname) return [ma]

  const fqdn = `_dnsaddr.${hostname}`

  const query = async (mode) => {
    const resolver = makeResolver(mode)
    return await resolver.query(fqdn, { types: [RecordType.TXT] })
  }

  let result
  try {
    if (dnsMode === 'system') result = await query('system')
    else if (dnsMode === 'doh') result = await query('doh')
    else {
      // auto: try system, fall back to DoH on NXDOMAIN/temporary failures
      try {
        result = await query('system')
      } catch (e) {
        result = await query('doh')
      }
    }
  } catch (e) {
    const msg = e?.message ?? String(e)
    throw new Error(`dnsaddr TXT lookup failed for ${fqdn}: ${msg}`)
  }

  const peerIdFilter = getPeerIdStr(ma)
  const out = []

  for (const answer of result.Answer ?? []) {
    const addr = String(answer.data)
      .replace(/["']/g, '')
      .trim()
      .split('=')[1]

    if (!addr) continue
    if (peerIdFilter && !addr.includes(peerIdFilter)) continue

    if (addr.startsWith('/dnsaddr/')) {
      const nested = await resolveDnsaddrMultiaddr(multiaddr(addr), { maxDepth: maxDepth - 1, dnsMode })
      out.push(...nested)
    } else {
      out.push(multiaddr(addr))
    }
  }

  if (out.length === 0) {
    return [ma]
  }

  return out
}

function looksLikeRelay (protocols) {
  const s = protocols.join('\n').toLowerCase()
  // keep this heuristic loose - protocol strings vary between implementations/versions
  return s.includes('circuit') && s.includes('relay')
}

async function drainQueryEvents (iter, limit = 200) {
  const events = []
  for await (const ev of iter) {
    events.push(ev)
    if (events.length >= limit) break
    if (ev?.name === 'FINAL_PEER') break
    if (ev?.name === 'QUERY_ERROR') break
  }
  return events
}

async function checkOne (targetMa, { relay, dht, timeoutMs }) {
  const peerIdFromTarget = getPeerIdStr(targetMa)
  if (!peerIdFromTarget) {
    throw new Error(`Target multiaddr must include /p2p/<peerId>: ${targetMa.toString()}`)
  }

  const node = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0']
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ clientMode: true })
    }
  })

  await node.start()

  try {
    const conn = await withTimeout(timeoutMs, async (signal) => {
      return await node.dial(targetMa, { signal })
    }, 'dial')

    const remotePeer = conn.remotePeer
    const remotePeerStr = remotePeer.toString()

    const readPeerInfo = async () => {
      const peerInfo = await node.peerStore.get(remotePeer)
      const protocols = peerInfo.protocols ?? []
      const addrs = peerInfo.addresses?.map(a => a.multiaddr.toString()) ?? []
      return { protocols, addrs }
    }

    // Identify runs asynchronously after connect; give it a moment to populate protocols.
    let { protocols, addrs } = await readPeerInfo()
    if (protocols.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 750))
      ;({ protocols, addrs } = await readPeerInfo())
    }

    console.log(`connected peerId=${remotePeerStr}`)
    console.log(`known addrs:\n${addrs.map(a => `  ${a}`).join('\n') || '  (none)'}`)
    console.log(`protocols:\n${protocols.map(p => `  ${p}`).join('\n') || '  (none)'}`)

    try {
      const rttMs = await withTimeout(timeoutMs, async (signal) => {
        return await node.services.ping.ping(remotePeer, { signal })
      }, 'ping')
      console.log(`ping rtt=${rttMs}ms`)
    } catch (e) {
      console.log(`ping: not supported or failed (${e?.message ?? String(e)})`)
    }

    if (relay) {
      const ok = looksLikeRelay(protocols)
      if (!ok) throw new Error('relay check failed: did not see relay hop protocol in identify protocol list')
      console.log('relay check: ok (heuristic)')
    }

    if (dht) {
      const events = await withTimeout(timeoutMs, async (signal) => {
        const it = node.services.dht.findPeer(remotePeer, { signal })
        return await drainQueryEvents(it)
      }, 'dht.findPeer')

      const final = events.find(e => e?.name === 'FINAL_PEER')
      const err = events.find(e => e?.name === 'QUERY_ERROR')
      if (final) {
        console.log('dht.findPeer: ok (FINAL_PEER)')
      } else if (err) {
        throw new Error(`dht.findPeer failed (QUERY_ERROR): ${err.error?.message ?? String(err.error)}`)
      } else {
        throw new Error('dht.findPeer did not reach FINAL_PEER (unexpected end)')
      }
    }

    return { remotePeerId: remotePeerStr }
  } finally {
    try { await node.stop() } catch {}
  }
}

async function main () {
  const args = parseArgs(process.argv)
  const targets = await resolveTargets(args.target, args)

  const list = args.all ? targets : targets.slice(0, 1)
  if (targets.length > 1) {
    console.log(`resolved ${targets.length} targets; testing ${list.length} (${args.all ? '--all' : 'default first only'})`)
  }

  for (const [i, ma] of list.entries()) {
    console.log(`\n== target[${i}]: ${ma.toString()}`)
    await checkOne(ma, args)
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err))
  process.exit(1)
})


