import { dns, RecordType } from '@multiformats/dns'
import { dnsJsonOverHttps } from '@multiformats/dns/resolvers'
import { multiaddr } from '@multiformats/multiaddr'

function makeResolver(mode) {
  if (mode === 'doh') {
    return dns({
      resolvers: {
        '.': [
          dnsJsonOverHttps('https://cloudflare-dns.com/dns-query'),
          dnsJsonOverHttps('https://dns.google/resolve')
        ]
      }
    })
  }

  return dns()
}

function getPeerIdStr(ma) {
  const comp = ma.getComponents().find(c => c.name === 'p2p')
  return comp?.value ?? null
}

async function resolveDnsaddrMultiaddr(ma, { maxDepth = 8, dnsMode = 'auto' } = {}) {
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
      try {
        result = await query('system')
      } catch {
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

  return out.length > 0 ? out : [ma]
}

export async function resolveTargets(targetStr, dnsMode = 'auto') {
  const ma = multiaddr(targetStr)
  const hasDnsaddr = ma.getComponents().some(c => c.name === 'dnsaddr')
  if (!hasDnsaddr) return [ma]
  return await resolveDnsaddrMultiaddr(ma, { dnsMode })
}


