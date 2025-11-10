/*
  Port of Taleus Bootstrap State Machine Tests
  - Full suite copied and adapted to Sereus (thread-centric, configurable protocol)
  - All tests are initially skipped EXCEPT the first sanity test
*/

import { strict as assert } from 'assert'
import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createLibp2p, Libp2p } from 'libp2p'
import { createEd25519PeerId, exportToProtobuf, createFromProtobuf } from '@libp2p/peer-id-factory'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { mplex } from '@libp2p/mplex'
import {
  SessionManager,
  ListenerSession,
  DialerSession,
  createBootstrapManager,
  DEFAULT_PROTOCOL_ID,
  type SessionConfig,
  type BootstrapLink,
  type BootstrapResult,
  type SessionHooks
} from '../../src/bootstrap.js'
import { createSessionAwareHooks } from '../helpers/consumerMocks.js'

// Shared config used by most tests (mirrors Taleus DEFAULT_CONFIG)
const DEFAULT_CONFIG: SessionConfig = {
  sessionTimeoutMs: 30000,
  stepTimeoutMs: 5000,
  maxConcurrentSessions: 100,
  protocolId: DEFAULT_PROTOCOL_ID
}

function createLibp2pNode(port: number = 0): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [mplex()],
    connectionManager: { dialTimeout: 5000 }
  })
}

// Ensure peerIds carry private keys (Noise requires it)
async function createLibp2pNodeWithKeys(port: number = 0): Promise<Libp2p> {
  // Some environments yield PeerIds without a private key recognized by Noise unless re-imported
  const generated = await createEd25519PeerId()
  const reimported = await createFromProtobuf(exportToProtobuf(generated))
  const peerId = reimported
  return createLibp2p({
    peerId,
    addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [mplex()],
    connectionManager: { dialTimeout: 5000 }
  })
}

// FIRST TEST (active): identical in spirit to Taleus - manager constructs and has zero sessions
describe('Sereus Bootstrap - SessionManager (sanity)', () => {
  it('should create and configure properly', () => {
    const hooks = createSessionAwareHooks(['stock-token', 'foil-token', 'multi-use-token']) as SessionHooks
    const manager = new SessionManager(hooks, DEFAULT_CONFIG)
    assert.ok(manager)
    const counts = manager.getActiveSessionCounts()
    assert.equal(counts.listeners, 0)
    assert.equal(counts.dialers, 0)
  })
})

// Enable the stock role 2-message flow as the first integration test
describe('Sereus Bootstrap - integration (stock 2-message)', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let hooksA: SessionHooks
  let hooksB: SessionHooks

  beforeAll(async () => {
    const pidA = await createFromProtobuf(exportToProtobuf(await createEd25519PeerId()))
    const pidB = await createFromProtobuf(exportToProtobuf(await createEd25519PeerId()))
    nodeA = await createLibp2p({
      peerId: pidA,
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [mplex()],
      connectionManager: { dialTimeout: 5000 }
    })
    nodeB = await createLibp2p({
      peerId: pidB,
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [mplex()],
      connectionManager: { dialTimeout: 5000 }
    })
    await nodeA.start()
    await nodeB.start()
    hooksA = createSessionAwareHooks(['stock-token']) as SessionHooks
    hooksB = createSessionAwareHooks(['stock-token']) as SessionHooks
  })
  afterAll(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
    await nodeA?.stop()
    await nodeB?.stop()
  })

  it('should execute complete stock role bootstrap (2 messages)', async () => {
    const managerA = new SessionManager(hooksA, { ...DEFAULT_CONFIG, enableDebugLogging: true, stepTimeoutMs: 8000, sessionTimeoutMs: 15000 })
    const managerB = new SessionManager(hooksB, { ...DEFAULT_CONFIG, enableDebugLogging: true, stepTimeoutMs: 8000, sessionTimeoutMs: 15000 })
    managerA.register(nodeA)
    const addrs = nodeA.getMultiaddrs().map(a => a.toString())
    const picked = addrs.find(a => a.includes('/p2p/')) || (addrs[0] ? `${addrs[0]}/p2p/${(nodeA as any).peerId.toString()}` : '')
    const addr = picked
    const link: BootstrapLink = {
      responderPeerAddrs: [addr],
      token: 'stock-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    const result = await managerB.initiateBootstrap(link, nodeB)
    assert.ok(result.thread)
    assert.ok(result.dbConnectionInfo)
    assert.equal(result.thread.createdBy, 'stock')
    try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
  }, 10000)
})

describe('Sereus Bootstrap - integration (foil 3-message and rejection)', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let hooksA: SessionHooks
  let hooksB: SessionHooks

  beforeAll(async () => {
    nodeA = await createLibp2pNode()
    nodeB = await createLibp2pNode()
    await nodeA.start()
    await nodeB.start()
    hooksA = createSessionAwareHooks(['foil-token', 'stock-token']) as SessionHooks
    hooksB = createSessionAwareHooks(['foil-token', 'stock-token']) as SessionHooks
  })
  afterAll(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
    await nodeA?.stop()
    await nodeB?.stop()
  })
  afterEach(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
  })

  it('should execute complete foil role bootstrap (3 messages)', async () => {
    const managerA = new SessionManager(hooksA, { ...DEFAULT_CONFIG, enableDebugLogging: true, stepTimeoutMs: 8000, sessionTimeoutMs: 15000 })
    const managerB = new SessionManager(hooksB, { ...DEFAULT_CONFIG, enableDebugLogging: true, stepTimeoutMs: 8000, sessionTimeoutMs: 15000 })
    managerA.register(nodeA)
    const addrs = nodeA.getMultiaddrs().map(a => a.toString())
    const picked = addrs.find(a => a.includes('/p2p/')) || (addrs[0] ? `${addrs[0]}/p2p/${(nodeA as any).peerId.toString()}` : '')
    const link: BootstrapLink = {
      responderPeerAddrs: [picked],
      token: 'foil-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'foil'
    }
    const result = await managerB.initiateBootstrap(link, nodeB)
    assert.ok(result.thread)
    assert.ok(result.dbConnectionInfo)
    assert.equal(result.thread.createdBy, 'foil')
  }, 15000)

  it('should reject invalid token', async () => {
    const managerA = new SessionManager(hooksA, { ...DEFAULT_CONFIG, enableDebugLogging: true, stepTimeoutMs: 8000, sessionTimeoutMs: 15000 })
    const managerB = new SessionManager(hooksB, { ...DEFAULT_CONFIG, enableDebugLogging: true, stepTimeoutMs: 8000, sessionTimeoutMs: 15000 })
    managerA.register(nodeA)
    const addr = nodeA.getMultiaddrs()[0]?.toString() || ''
    const link: BootstrapLink = {
      responderPeerAddrs: [addr],
      token: 'invalid-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    let threw = false
    try {
      await managerB.initiateBootstrap(link, nodeB)
    } catch {
      threw = true
    }
    assert.ok(threw, 'expected invalid token to be rejected')
  }, 10000)
})

describe('Sereus Bootstrap - concurrent multi-use token scenarios', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let hooksA: SessionHooks
  let hooksB: SessionHooks

  beforeAll(async () => {
    nodeA = await createLibp2pNode()
    nodeB = await createLibp2pNode()
    await nodeA.start()
    await nodeB.start()
    hooksA = createSessionAwareHooks(['multi-use-token']) as SessionHooks
    hooksB = createSessionAwareHooks(['multi-use-token']) as SessionHooks
  })
  afterAll(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
    await nodeA?.stop()
    await nodeB?.stop()
  })
  afterEach(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
  })

  it('should handle multiple customers with same merchant token', async () => {
    const merchantManager = new SessionManager(hooksA, { ...DEFAULT_CONFIG, enableDebugLogging: true })
    merchantManager.register(nodeA)
    const addr = nodeA.getMultiaddrs()[0]?.toString() || ''
    const link: BootstrapLink = {
      responderPeerAddrs: [addr],
      token: 'multi-use-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    const customerManager1 = new SessionManager(hooksB, DEFAULT_CONFIG)
    const customerManager2 = new SessionManager(hooksB, DEFAULT_CONFIG)
    const customerManager3 = new SessionManager(hooksB, DEFAULT_CONFIG)
    const results = await Promise.all([
      customerManager1.initiateBootstrap(link, nodeB),
      customerManager2.initiateBootstrap(link, nodeB),
      customerManager3.initiateBootstrap(link, nodeB)
    ])
    const ids = new Set(results.map(r => r.thread.threadId))
    assert.equal(ids.size, 3)
    results.forEach(r => {
      assert.ok(r.thread)
      assert.ok(r.dbConnectionInfo)
      assert.equal(r.thread.createdBy, 'stock')
    })
  }, 15000)
})

describe('Sereus Bootstrap - timeout and recovery', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let hooksB: SessionHooks

  beforeAll(async () => {
    nodeA = await createLibp2pNode()
    nodeB = await createLibp2pNode()
    await nodeA.start()
    await nodeB.start()
    hooksB = createSessionAwareHooks(['stock-token']) as SessionHooks
  })
  afterAll(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
    await nodeA?.stop()
    await nodeB?.stop()
  })
  afterEach(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
  })

  it('should timeout sessions exceeding configured step limits', async () => {
    const slowHooksA: SessionHooks = {
      async validateToken() { await new Promise(r => setTimeout(r, 800)); return { role: 'stock', valid: true } },
      async validateIdentity() { return true },
      async provisionThread(role: any, a: string, b: string) {
        return { thread: { threadId: `thr-${a}-${b}`, createdBy: role }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
      },
      async validateResponse() { return true },
      async validateDatabaseResult() { return true }
    }
    const shortConfig = { ...DEFAULT_CONFIG, enableDebugLogging: true, sessionTimeoutMs: 1000, stepTimeoutMs: 500 }
    const managerA = new SessionManager(slowHooksA, shortConfig)
    const managerB = new SessionManager(hooksB, shortConfig)
    managerA.register(nodeA)
    const addr = nodeA.getMultiaddrs()[0]?.toString() || ''
    const link: BootstrapLink = {
      responderPeerAddrs: [addr],
      token: 'stock-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    let timedOut = false
    try {
      await managerB.initiateBootstrap(link, nodeB)
    } catch (e: any) {
      timedOut = /timeout/i.test(String(e?.message))
    }
    assert.ok(timedOut, 'expected a timeout due to slow token validation')
  }, 5000)
})

describe('Sereus Bootstrap - cleanup and isolation', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let hooksA: SessionHooks
  let hooksB: SessionHooks

  beforeAll(async () => {
    nodeA = await createLibp2pNode()
    nodeB = await createLibp2pNode()
    await nodeA.start()
    await nodeB.start()
    hooksA = createSessionAwareHooks(['stock-token']) as SessionHooks
    hooksB = createSessionAwareHooks(['stock-token']) as SessionHooks
  })
  afterAll(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
    await nodeA?.stop()
    await nodeB?.stop()
  })
  afterEach(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
  })

  it('should clean up sessions after completion', async () => {
    const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
    managerA.register(nodeA)
    const counts0 = managerA.getActiveSessionCounts()
    assert.equal(counts0.listeners, 0)
    assert.equal(counts0.dialers, 0)

    const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
    const addr = nodeA.getMultiaddrs()[0]?.toString() || ''
    const link: BootstrapLink = {
      responderPeerAddrs: [addr],
      token: 'stock-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    const result = await managerB.initiateBootstrap(link, nodeB)
    assert.ok(result.thread && result.dbConnectionInfo)
    await new Promise(r => setTimeout(r, 50))
    const counts1 = managerA.getActiveSessionCounts()
    assert.equal(counts1.listeners, 0)
    assert.equal(counts1.dialers, 0)
  }, 8000)

  it('should isolate session failures from other sessions', async () => {
    const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
    managerA.register(nodeA)
    const validLink: BootstrapLink = {
      responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
      token: 'stock-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    const invalidLink: BootstrapLink = {
      responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
      token: 'invalid-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    const mgrValid = new SessionManager(hooksB, DEFAULT_CONFIG)
    const mgrInvalid = new SessionManager(hooksB, DEFAULT_CONFIG)
    const [res1, res2] = await Promise.allSettled([
      mgrValid.initiateBootstrap(validLink, nodeB),
      mgrInvalid.initiateBootstrap(invalidLink, nodeB)
    ])
    assert.equal(res1.status, 'fulfilled')
    assert.equal(res2.status, 'rejected')
    const counts = managerA.getActiveSessionCounts()
    assert.equal(counts.listeners, 0)
    assert.equal(counts.dialers, 0)
  }, 10000)
})

describe('Sereus Bootstrap - hook failures and malformed returns', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let hooksB: SessionHooks

  beforeAll(async () => {
    nodeA = await createLibp2pNode()
    nodeB = await createLibp2pNode()
    await nodeA.start()
    await nodeB.start()
    hooksB = createSessionAwareHooks(['stock-token', 'foil-token']) as SessionHooks
  })
  afterAll(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
    await nodeA?.stop()
    await nodeB?.stop()
  })
  afterEach(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
  })

  it('should handle token validation hook throwing', async () => {
    const tokenErrorHooksA: SessionHooks = {
      async validateToken() { throw new Error('Hook validation failed') },
      async validateIdentity() { return true },
      async provisionThread(role: any, a: string, b: string) {
        return { thread: { threadId: `thr-${a}-${b}`, createdBy: role }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
      },
      async validateResponse() { return true },
      async validateDatabaseResult() { return true }
    }
    const managerA = new SessionManager(tokenErrorHooksA, DEFAULT_CONFIG)
    const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
    managerA.register(nodeA)
    const addr = nodeA.getMultiaddrs()[0]?.toString() || ''
    const link: BootstrapLink = {
      responderPeerAddrs: [addr],
      token: 'stock-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    let rejected = false
    try { await managerB.initiateBootstrap(link, nodeB) } catch { rejected = true }
    assert.ok(rejected, 'expected rejection due to token validation failure')
  }, 10000)

  it('should handle provisioning hook throwing', async () => {
    // Fail on initiator (dialer) provisioning path by making its provisionThread throw
    const provisionErrorHooksB: SessionHooks = {
      async validateToken() { return { mode: 'initiatorCreates', valid: true } as any },
      async validateIdentity() { return true },
      async provisionThread() { throw new Error('provision failed') },
      async validateResponse() { return true },
      async validateDatabaseResult() { return true }
    }
    const managerA = new SessionManager(hooksB, DEFAULT_CONFIG)
    const managerB = new SessionManager(provisionErrorHooksB, DEFAULT_CONFIG)
    managerA.register(nodeA)
    const addr = nodeA.getMultiaddrs()[0]?.toString() || ''
    const link: BootstrapLink = {
      responderPeerAddrs: [addr],
      token: 'foil-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'foil'
    }
    let rejected = false
    try { await managerB.initiateBootstrap(link, nodeB) } catch { rejected = true }
    assert.ok(rejected, 'expected rejection due to provisioning failure on initiator side')
  }, 10000)

  it('should reject malformed hook return values', async () => {
    const malformedHooksA: SessionHooks = {
      // missing valid flag
      async validateToken() { return { role: 'stock' } as any },
      async validateIdentity() { return 'yes' as any },
      async provisionThread() { return { thread: { threadId: 'incomplete' } } as any },
      async validateResponse() { return true },
      async validateDatabaseResult() { return true }
    }
    const managerA = new SessionManager(malformedHooksA, DEFAULT_CONFIG)
    const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
    managerA.register(nodeA)
    const addr = nodeA.getMultiaddrs()[0]?.toString() || ''
    const link: BootstrapLink = {
      responderPeerAddrs: [addr],
      token: 'stock-token',
      tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
      initiatorRole: 'stock'
    }
    let rejected = false
    try { await managerB.initiateBootstrap(link, nodeB) } catch { rejected = true }
    assert.ok(rejected, 'expected rejection due to malformed hook returns')
  }, 10000)
})

// FULL PORT (initially skipped). We keep structure and logic, but adapt:
// - '/taleus/bootstrap/1.0.0' -> DEFAULT_PROTOCOL_ID
// - tally/tallyId -> thread/threadId
// - provisionDatabase -> provisionThread
describe.skip('Sereus Bootstrap (ported Taleus suite)', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let hooksA: SessionHooks
  let hooksB: SessionHooks

  beforeAll(async () => {
    nodeA = await createLibp2pNode()
    nodeB = await createLibp2pNode()
    await nodeA.start()
    await nodeB.start()
  })
  afterAll(async () => {
    await nodeA?.stop()
    await nodeB?.stop()
  })
  beforeEach(() => {
    hooksA = createSessionAwareHooks(['stock-token', 'foil-token', 'multi-use-token']) as SessionHooks
    hooksB = createSessionAwareHooks(['stock-token', 'foil-token', 'multi-use-token']) as SessionHooks
  })

  describe('SessionManager', () => {
    it('should handle multiple concurrent sessions without blocking', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => {
        await managerA.handleNewStream(stream as any)
      })
      const promises: Promise<BootstrapResult>[] = []
      for (let i = 0; i < 5; i++) {
        const link: BootstrapLink = {
          responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
          token: 'multi-use-token',
          tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
          initiatorRole: 'stock'
        }
        const clientManager = new SessionManager(hooksB, DEFAULT_CONFIG)
        promises.push(clientManager.initiateBootstrap(link, nodeB))
      }
      const startTime = Date.now()
      const results = await Promise.all(promises)
      const duration = Date.now() - startTime
      assert.equal(results.length, 5)
      assert.ok(results.every(r => r.thread && r.dbConnectionInfo))
      const threadIds = results.map(r => r.thread.threadId)
      const unique = new Set(threadIds)
      assert.equal(unique.size, 5)
      assert.ok(duration < 2000)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 8000)

    it('should clean up sessions after completion', async () => {
      const manager = new SessionManager(hooksA, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await manager.handleNewStream(stream as any) })
      const initialCounts = manager.getActiveSessionCounts()
      assert.equal(initialCounts.listeners, 0)
      assert.equal(initialCounts.dialers, 0)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.thread && result.dbConnectionInfo)
      await new Promise(r => setTimeout(r, 50))
      const finalCounts = manager.getActiveSessionCounts()
      assert.equal(finalCounts.listeners, 0)
      assert.equal(finalCounts.dialers, 0)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 5000)

    it('should isolate session failures from other sessions', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const mgrValid = new SessionManager(hooksB, DEFAULT_CONFIG)
      const mgrInvalid = new SessionManager(hooksB, DEFAULT_CONFIG)
      const validLink: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const invalidLink: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'invalid-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const [res1, res2] = await Promise.allSettled([
        mgrValid.initiateBootstrap(validLink, nodeB),
        mgrInvalid.initiateBootstrap(invalidLink, nodeB)
      ])
      assert.equal(res1.status, 'fulfilled')
      assert.equal(res2.status, 'rejected')
      const counts = managerA.getActiveSessionCounts()
      assert.equal(counts.listeners, 0)
      assert.equal(counts.dialers, 0)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 6000)
  })

  describe('Message Flow Integration', () => {
    it('should execute complete stock role bootstrap (2 messages)', async () => {
      const managerA = new SessionManager(hooksA, { ...DEFAULT_CONFIG, enableDebugLogging: true })
      const managerB = new SessionManager(hooksB, { ...DEFAULT_CONFIG, enableDebugLogging: true })
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.thread)
      assert.ok(result.dbConnectionInfo)
      assert.equal(result.thread.createdBy, 'stock')
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 15000)

    it('should execute complete foil role bootstrap (3 messages)', async () => {
      const managerA = new SessionManager(hooksA, { ...DEFAULT_CONFIG, enableDebugLogging: true })
      const managerB = new SessionManager(hooksB, { ...DEFAULT_CONFIG, enableDebugLogging: true })
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'foil-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'foil'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.thread)
      assert.ok(result.dbConnectionInfo)
      assert.equal(result.thread.createdBy, 'foil')
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 15000)

    it('should handle rejection scenarios gracefully', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const invalidTokenLink: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'invalid-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      await expectReject(() => managerB.initiateBootstrap(invalidTokenLink, nodeB))
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 10000)

    it('should fail on invalid identity validation', async () => {
      // hooksA rejects identity
      const rejectingHooksA: SessionHooks = {
        async validateToken(token: string) { return { role: 'stock', valid: true } },
        async validateIdentity() { return false },
        async provisionThread(role: any, a: string, b: string) {
          return { thread: { threadId: `thr-${a}-${b}`, createdBy: role }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
        },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const managerA = new SessionManager(rejectingHooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      await expectReject(() => managerB.initiateBootstrap(link, nodeB))
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 8000)
  })

  describe('Cadre Disclosure Timing (Method 6 Compliance)', () => {
    it('should send B_cadre in InboundContact message', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      let capturedContact: any = null
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => {
        const decoder = new TextDecoder()
        let message = ''
        for await (const chunk of (stream as any).source) {
          message += decoder.decode(chunk, { stream: true })
        }
        capturedContact = JSON.parse(message)
        const rejection = { approved: false, reason: 'Test completed - captured message' }
        const encoded = new TextEncoder().encode(JSON.stringify(rejection))
        await (stream as any).sink([encoded] as any)
      })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      await expectReject(() => managerB.initiateBootstrap(link, nodeB))
      assert.ok(capturedContact && Array.isArray(capturedContact.cadrePeerAddrs) && capturedContact.cadrePeerAddrs.length > 0)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 3000)

    it('should send A_cadre in ProvisioningResult message (post-validation)', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      let capturedResponse: any = null
      const originalValidateResponse = hooksB.validateResponse.bind(hooksB)
      ;(hooksB as any).validateResponse = async (response: any, sessionId: string) => {
        capturedResponse = response
        return originalValidateResponse(response, sessionId)
      }
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.thread && result.dbConnectionInfo)
      assert.ok(capturedResponse && capturedResponse.approved === true)
      assert.ok(Array.isArray(capturedResponse.cadrePeerAddrs) && capturedResponse.cadrePeerAddrs.length > 0)
      ;(hooksB as any).validateResponse = originalValidateResponse
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 5000)

    it('should allow A to reject without revealing A_cadre', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      // Override token validation to force rejection
      const rejectingHooksA: SessionHooks = {
        async validateToken() { return { role: 'stock', valid: false } },
        async validateIdentity() { return true },
        async provisionThread() { throw new Error('unreached') },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const rejectMgrA = new SessionManager(rejectingHooksA, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await rejectMgrA.handleNewStream(stream as any) })
      // Dial directly to capture rejection
      const { multiaddr } = await import('@multiformats/multiaddr')
      const responderAddr = multiaddr(nodeA.getMultiaddrs()[0].toString())
      const stream = await (nodeB as any).dialProtocol(responderAddr, DEFAULT_PROTOCOL_ID)
      const contact = {
        token: 'invalid-token',
        partyId: 'test-session',
        identityBundle: { partyId: 'test-session' },
        cadrePeerAddrs: ['b1.local', 'b2.local']
      }
      const enc = new TextEncoder().encode(JSON.stringify(contact))
      await (stream as any).sink([enc])
      const dec = new TextDecoder()
      let msg = ''
      for await (const chunk of (stream as any).source) { msg += dec.decode(chunk, { stream: true }) }
      const rejection = JSON.parse(msg)
      assert.equal(rejection.approved, false)
      assert.ok(!rejection.cadrePeerAddrs || rejection.cadrePeerAddrs.length === 0)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 5000)
  })

  describe('Hook Integration', () => {
    it('should call hooks with proper session context', async () => {
      const hooks = createSessionAwareHooks(['test-token']) as any
      const tokenResult = await hooks.validateToken('test-token', 'session-123')
      assert.equal(tokenResult.valid, true)
      assert.equal(tokenResult.role, 'stock')
      const identityResult = await hooks.validateIdentity({ partyId: 'party-123' }, 'session-123')
      assert.equal(identityResult, true)
      const dbResult = await hooks.provisionThread('stock', 'partyA', 'partyB', 'session-123')
      assert.ok(dbResult.thread)
      assert.ok(dbResult.dbConnectionInfo)
      assert.equal(dbResult.thread.createdBy, 'stock')
    })

    it('should handle hook failures gracefully', async () => {
      const tokenErrorHooksA: SessionHooks = {
        async validateToken(token: string) { throw new Error('Hook validation failed') },
        async validateIdentity() { return true },
        async provisionThread(role: any, a: string, b: string) {
          return { thread: { threadId: `thr-${a}-${b}`, createdBy: role }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
        },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const managerA = new SessionManager(tokenErrorHooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'error-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      await expectReject(() => managerB.initiateBootstrap(link, nodeB))
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 8000)

    it('should validate malformed hook return values', async () => {
      const malformedHooksA: SessionHooks = {
        async validateToken() { return { role: 'stock' } as any },
        async validateIdentity() { return 'yes' as any },
        async provisionThread() { return { thread: { threadId: 'incomplete' } } as any },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const managerA = new SessionManager(malformedHooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'test-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      await expectReject(() => managerB.initiateBootstrap(link, nodeB))
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 6000)
  })

  describe('Concurrent Multi-Use Token Scenarios', () => {
    it('should handle multiple customers with same merchant token', async () => {
      const merchantManager = new SessionManager(hooksA, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await merchantManager.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'multi-use-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const customerManager1 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const customerManager2 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const customerManager3 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const results = await Promise.all([
        customerManager1.initiateBootstrap(link, nodeB),
        customerManager2.initiateBootstrap(link, nodeB),
        customerManager3.initiateBootstrap(link, nodeB)
      ])
      const ids = results.map(r => r.thread.threadId)
      const unique = new Set(ids)
      assert.equal(unique.size, 3)
      results.forEach(r => {
        assert.ok(r.thread)
        assert.ok(r.dbConnectionInfo)
        assert.equal(r.thread.createdBy, 'stock')
      })
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 15000)

    it('should maintain isolation with mixed valid/invalid requests', async () => {
      const merchantManager = new SessionManager(hooksA, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await merchantManager.handleNewStream(stream as any) })
      const linkBase: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'multi-use-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const customer1 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const customer2 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const invalidCustomer = new SessionManager(hooksB, DEFAULT_CONFIG)
      const customer3 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const results = await Promise.allSettled([
        customer1.initiateBootstrap({ ...linkBase }, nodeB),
        customer2.initiateBootstrap({ ...linkBase }, nodeB),
        invalidCustomer.initiateBootstrap({ ...linkBase, token: 'invalid-token' }, nodeB),
        customer3.initiateBootstrap({ ...linkBase }, nodeB)
      ])
      const success = results.filter(r => r.status === 'fulfilled').length
      const failure = results.filter(r => r.status === 'rejected').length
      assert.equal(success, 3)
      assert.equal(failure, 1)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 8000)
  })

  describe('Timeout and Error Recovery', () => {
    it('should timeout sessions exceeding configured step limits', async () => {
      const shortConfig: SessionConfig = { sessionTimeoutMs: 1000, stepTimeoutMs: 500, maxConcurrentSessions: 10, protocolId: DEFAULT_PROTOCOL_ID, enableDebugLogging: true }
      const slowHooksA: SessionHooks = {
        async validateToken() { await new Promise(r => setTimeout(r, 800)); return { role: 'stock', valid: true } },
        async validateIdentity() { return true },
        async provisionThread(role: any, a: string, b: string) {
          return { thread: { threadId: `thr-${a}-${b}`, createdBy: role }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
        },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const managerA = new SessionManager(slowHooksA, shortConfig)
      const managerB = new SessionManager(hooksB, shortConfig)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      await expectReject(() => managerB.initiateBootstrap(link, nodeB))
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 3000)

    it('should recover with subsequent successful session after timeout', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.thread && result.dbConnectionInfo)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 6000)

    it('should handle network failures and succeed on retry', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      let attempt = 0
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => {
        attempt++
        if (attempt === 1) {
          try { (stream as any).close?.(); (stream as any).closeWrite?.() } catch {}
          return
        }
        await managerA.handleNewStream(stream as any)
      })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      // First should fail
      await expectReject(() => managerB.initiateBootstrap(link, nodeB))
      // Second should succeed
      const managerB2 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const res2 = await managerB2.initiateBootstrap(link, nodeB)
      assert.ok(res2.thread && res2.dbConnectionInfo)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 8000)

    it('should recover from transient identity validation failure', async () => {
      let calls = 0
      const transientHooksA: SessionHooks = {
        async validateToken() { return { role: 'stock', valid: true } },
        async validateIdentity() { calls++; return calls > 1 },
        async provisionThread(role: any, a: string, b: string) {
          return { thread: { threadId: `thr-${a}-${b}`, createdBy: role }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
        },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const managerA = new SessionManager(transientHooksA, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      // First should fail
      const managerB1 = new SessionManager(hooksB, DEFAULT_CONFIG)
      await expectReject(() => managerB1.initiateBootstrap(link, nodeB))
      // Second should succeed
      const managerB2 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const res = await managerB2.initiateBootstrap(link, nodeB)
      assert.ok(res.thread && res.dbConnectionInfo)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 6000)
  })

  describe('Performance and Resource Management', () => {
    it('should limit concurrent sessions to configured maximum', async () => {
      const limitedConfig: SessionConfig = { sessionTimeoutMs: 10000, stepTimeoutMs: 2000, maxConcurrentSessions: 2, protocolId: DEFAULT_PROTOCOL_ID, enableDebugLogging: true }
      const limitedManagerA = new SessionManager(hooksA, limitedConfig)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await limitedManagerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'multi-use-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const promises: Promise<BootstrapResult>[] = []
      for (let i = 0; i < 4; i++) {
        const mgrB = new SessionManager(hooksB, DEFAULT_CONFIG)
        promises.push(mgrB.initiateBootstrap(link, nodeB))
      }
      const results = await Promise.allSettled(promises)
      const successes = results.filter(r => r.status === 'fulfilled').length
      assert.ok(successes >= 2)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 15000)

    it('should clean up resources after multiple sessions', async () => {
      const manager = new SessionManager(hooksA, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await manager.handleNewStream(stream as any) })
      const mgrB = new SessionManager(hooksB, DEFAULT_CONFIG)
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'stock-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        initiatorRole: 'stock'
      }
      const results = await Promise.all([
        mgrB.initiateBootstrap(link, nodeB),
        mgrB.initiateBootstrap(link, nodeB),
        mgrB.initiateBootstrap(link, nodeB),
        mgrB.initiateBootstrap(link, nodeB),
        mgrB.initiateBootstrap(link, nodeB)
      ])
      results.forEach(r => assert.ok(r.thread && r.dbConnectionInfo))
      await new Promise(r => setTimeout(r, 100))
      const counts = manager.getActiveSessionCounts()
      assert.equal(counts.listeners, 0)
      assert.equal(counts.dialers, 0)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 8000)
  })
})

// Small helper to assert rejections without failing type inference
async function expectReject(fn: () => Promise<unknown>) {
  let failed = false
  try {
    await fn()
  } catch {
    failed = true
  }
  if (!failed) throw new Error('Expected rejection but operation succeeded')
}


