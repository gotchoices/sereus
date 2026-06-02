import dgram from 'node:dgram'
import { randomBytes } from 'node:crypto'

// check-stun.mjs — send a STUN Binding request to a coturn (or any STUN) server
// and print the mapped server-reflexive address it sees us coming from. This is
// the address-discovery step a WebRTC peer relies on to attempt a DIRECT
// connection. Dependency-free (node dgram), mirrors check-node.mjs ergonomics.
//
// REQUIRES a deployed, publicly reachable STUN server — NOT agent-runnable in CI
// (there is no local STUN server to bind against). Run it manually after deploy.

const STUN_BINDING_REQUEST = 0x0001
const STUN_BINDING_SUCCESS = 0x0101
const MAGIC_COOKIE = 0x2112a442
const ATTR_MAPPED_ADDRESS = 0x0001
const ATTR_XOR_MAPPED_ADDRESS = 0x0020

function usage () {
  console.log(`Usage:
  node sereus/ops/test/check-stun.mjs --host <stun-host> [--port N] [--timeout-ms N]

Options:
  --host        Required. STUN server hostname or IP (e.g. stun.sereus.org)
  --port        STUN UDP port (default: 3478)
  --timeout-ms  Overall timeout (default: 5000)

Example:
  node sereus/ops/test/check-stun.mjs --host stun.sereus.org --port 3478
`)
}

function parseArgs (argv) {
  const args = { host: null, port: 3478, timeoutMs: 5000 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') args.host = argv[++i]
    else if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
    else throw new Error(`Unknown arg: ${a}`)
  }
  if (!args.host) throw new Error('Missing --host')
  if (!Number.isFinite(args.port) || args.port <= 0) throw new Error('Invalid --port')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('Invalid --timeout-ms')
  return args
}

function buildBindingRequest () {
  const txId = randomBytes(12)
  const msg = Buffer.alloc(20)
  msg.writeUInt16BE(STUN_BINDING_REQUEST, 0)
  msg.writeUInt16BE(0, 2) // message length (no attributes)
  msg.writeUInt32BE(MAGIC_COOKIE, 4)
  txId.copy(msg, 8)
  return { msg, txId }
}

function parseMappedAddress (attrType, value) {
  // Common layout: 1 byte reserved, 1 byte family (0x01 IPv4, 0x02 IPv6),
  // 2 bytes port, then 4 (IPv4) or 16 (IPv6) bytes of address.
  const family = value.readUInt8(1)
  let port = value.readUInt16BE(2)
  const xor = attrType === ATTR_XOR_MAPPED_ADDRESS

  if (xor) port ^= (MAGIC_COOKIE >>> 16) & 0xffff

  if (family === 0x01) {
    const raw = Buffer.from(value.subarray(4, 8))
    if (xor) {
      const cookie = Buffer.alloc(4)
      cookie.writeUInt32BE(MAGIC_COOKIE, 0)
      for (let i = 0; i < 4; i++) raw[i] ^= cookie[i]
    }
    return { family: 'IPv4', address: `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`, port }
  }
  if (family === 0x02) {
    // IPv6 XOR uses magic cookie || transaction id; we only print the family for now.
    return { family: 'IPv6', address: '(IPv6 — not decoded)', port }
  }
  return null
}

function parseResponse (buf, txId) {
  if (buf.length < 20) throw new Error('response too short')
  const type = buf.readUInt16BE(0)
  if (type !== STUN_BINDING_SUCCESS) {
    throw new Error(`unexpected STUN message type 0x${type.toString(16).padStart(4, '0')} (wanted Binding Success 0x0101)`)
  }
  if (buf.readUInt32BE(4) !== MAGIC_COOKIE) throw new Error('bad magic cookie')
  if (!buf.subarray(8, 20).equals(txId)) throw new Error('transaction id mismatch')

  const length = buf.readUInt16BE(2)
  let offset = 20
  const end = 20 + length
  let mapped = null
  let xorMapped = null

  while (offset + 4 <= end && offset + 4 <= buf.length) {
    const attrType = buf.readUInt16BE(offset)
    const attrLen = buf.readUInt16BE(offset + 2)
    const value = buf.subarray(offset + 4, offset + 4 + attrLen)
    if (attrType === ATTR_XOR_MAPPED_ADDRESS) xorMapped = parseMappedAddress(attrType, value)
    else if (attrType === ATTR_MAPPED_ADDRESS) mapped = parseMappedAddress(attrType, value)
    offset += 4 + attrLen + ((4 - (attrLen % 4)) % 4) // 32-bit aligned padding
  }

  return xorMapped ?? mapped
}

async function main () {
  const args = parseArgs(process.argv)
  const { msg, txId } = buildBindingRequest()
  const socket = dgram.createSocket('udp4')

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${args.timeoutMs}ms (no STUN response from ${args.host}:${args.port}). Is the server deployed and UDP ${args.port} reachable?`))
    }, args.timeoutMs)

    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    socket.on('message', (buf) => {
      clearTimeout(timer)
      try { resolve(parseResponse(buf, txId)) } catch (e) { reject(e) }
    })

    socket.send(msg, args.port, args.host, (err) => {
      if (err) { clearTimeout(timer); reject(err) }
    })
  }).finally(() => { try { socket.close() } catch {} })

  if (!result) throw new Error('no MAPPED-ADDRESS / XOR-MAPPED-ADDRESS in STUN response')
  console.log(`stun ok: ${args.host}:${args.port} sees you at ${result.address}:${result.port} (${result.family})`)
}

main().catch((err) => {
  console.error(err?.stack ?? String(err))
  process.exit(1)
})
