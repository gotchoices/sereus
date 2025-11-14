import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { mplex } from '@libp2p/mplex'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { createBootstrapManager, DEFAULT_PROTOCOL_ID } from '../../src/bootstrap.ts'

async function main() {
  const peerId = await createEd25519PeerId()
  const node = await createLibp2p({
    peerId,
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [mplex()]
  })
  await node.start()
  console.log('Responder listening on:', node.getMultiaddrs().map(a => a.toString()))

  const hooks = {
    async validateToken(token: string) { return { mode: token.includes('initiator') ? 'initiatorCreates' : 'responderCreates', valid: true } },
    async validateIdentity() { return true },
    async provisionStrand(creator: 'initiator'|'responder', a: string, b: string) {
      return { strand: { strandId: `str-${Date.now()}`, createdBy: creator }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
    },
    async validateResponse() { return true },
    async validateDatabaseResult() { return true }
  }
  const mgr = createBootstrapManager(hooks, { protocolId: DEFAULT_PROTOCOL_ID, enableDebugLogging: true })
  mgr.register(node)
}

main().catch(err => { console.error(err); process.exit(1) })


