import { describe, it } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { mplex } from '@libp2p/mplex'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { strict as assert } from 'assert'

describe('PeerId sanity', () => {
  it('libp2p-generated peerId should have private key (or Noise should accept)', async () => {
    const node = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [mplex()],
    })
    await node.start()
    // This may not expose privateKey, but should be acceptable to Noise if internal keypair exists.
    const hasPriv = Boolean((node as any).peerId && (node as any).peerId.privateKey)
    // Don't assert here; just log for inspection
    // eslint-disable-next-line no-console
    console.log('libp2p-generated peerId privateKey present:', hasPriv)
    await node.stop()
  })

  it('factory-generated Ed25519 peerId should expose a privateKey', async () => {
    const pid = await createEd25519PeerId()
    const hasPriv = Boolean((pid as any).privateKey)
    // eslint-disable-next-line no-console
    console.log('factory peerId privateKey present:', hasPriv)
    // At minimum, ensure it is truthy in our environment
    assert.ok(hasPriv, 'factory-generated peerId missing privateKey')
  })
})


