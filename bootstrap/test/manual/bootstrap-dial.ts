import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { mplex } from '@libp2p/mplex'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { createBootstrapManager, DEFAULT_PROTOCOL_ID, type BootstrapLink } from '../../src/bootstrap.ts'

async function main() {
  const addr = process.argv[2]
  if (!addr) {
    console.error('Usage: ts-node bootstrap-dial.ts <multiaddr>')
    process.exit(1)
  }
  const peerId = await createEd25519PeerId()
  const node = await createLibp2p({
    peerId,
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [mplex()]
  })
  await node.start()

  const hooks = {
    async validateToken() { return { mode: 'responderCreates' as const, valid: true } },
    async validateIdentity() { return true },
    async provisionThread(creator: 'initiator'|'responder', a: string, b: string) {
      return { thread: { threadId: `thr-${Date.now()}`, createdBy: creator }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
    },
    async validateResponse() { return true },
    async validateDatabaseResult() { return true }
  }
  const mgr = createBootstrapManager(hooks, { protocolId: DEFAULT_PROTOCOL_ID, enableDebugLogging: true })
  const link: BootstrapLink = {
    responderPeerAddrs: [addr],
    token: 'responder-token',
    tokenExpiryUtc: new Date(Date.now() + 60_000).toISOString(),
    mode: 'responderCreates'
  }
  const result = await mgr.initiateBootstrap(link, node)
  console.log('Bootstrap result:', result)
}

main().catch(err => { console.error(err); process.exit(1) })


