import { strict as assert } from 'assert'
import { describe, it, beforeEach, afterEach } from 'vitest'
import { createLibp2p, Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { mplex } from '@libp2p/mplex'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'

const TEST_PROTOCOL = '/test/json/1.0.0'

interface LibP2PStream {
  source: AsyncIterable<Uint8Array>
  sink(source: AsyncIterable<Uint8Array>): Promise<void>
  closeWrite?(): void
  close?(): void
}

async function writeJson(stream: LibP2PStream, obj: unknown): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(obj))
  async function* one() { yield encoded }
  await stream.sink(one())
}

async function readJson(stream: LibP2PStream): Promise<unknown> {
  const decoder = new TextDecoder()
  let message = ''
  for await (const chunk of stream.source) message += decoder.decode(chunk, { stream: true })
  if (!message.trim()) throw new Error('No data received')
  return JSON.parse(message)
}

async function createNode(port = 0): Promise<Libp2p> {
  const peerId = await createEd25519PeerId()
  return createLibp2p({
    peerId,
    addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [mplex()],
    connectionManager: { dialTimeout: 5000 }
  })
}

describe('libp2p basic streams (sanity)', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p

  beforeEach(async () => {
    nodeA = await createNode()
    nodeB = await createNode()
    await nodeA.start(); await nodeB.start()
  })
  afterEach(async () => {
    try { nodeA.unhandle(TEST_PROTOCOL) } catch {}
    await nodeA.stop(); await nodeB.stop()
  })

  it('sends and receives JSON', async () => {
    const payload = { hello: 'world' }
    let received: any = null

    nodeA.handle(TEST_PROTOCOL, async ({ stream }) => {
      received = await readJson(stream as LibP2PStream)
    })

    const stream = await nodeB.dialProtocol(nodeA.getMultiaddrs()[0], TEST_PROTOCOL) as LibP2PStream
    await writeJson(stream, payload)
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(received, payload)
  }, 10000)
})


