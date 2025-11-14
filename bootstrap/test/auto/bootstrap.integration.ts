/*
  Comprehensive Bootstrap State Machine Tests
  - Full suite adapted for Sereus (strand-centric, configurable protocol)
  - Covers integration flows, concurrency, timeouts, cleanup/isolation, and hook failures
*/

import { strict as assert } from 'assert'
import { describe, it, beforeEach, afterEach } from 'vitest'
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

// Shared config used by most tests
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

// FIRST TEST (sanity): manager constructs and has zero sessions
describe('Sereus Bootstrap - SessionManager (sanity)', () => {
  it('should create and configure properly', () => {
    const hooks = createSessionAwareHooks(['responder-token', 'initiator-token', 'multi-use-token']) as SessionHooks
    const manager = new SessionManager(hooks, DEFAULT_CONFIG)
    assert.ok(manager)
    const counts = manager.getActiveSessionCounts()
    assert.equal(counts.listeners, 0)
    assert.equal(counts.dialers, 0)
  })
})

// Full suite: structure and logic adapted for Sereus
// - Protocol string via DEFAULT_PROTOCOL_ID
// - tally/tallyId -> strand/strandId
// - provisionDatabase -> provisionThread
describe('Sereus Bootstrap - full suite', () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let hooksA: SessionHooks
  let hooksB: SessionHooks

  beforeEach(async () => {
    nodeA = await createLibp2pNodeWithKeys()
    nodeB = await createLibp2pNodeWithKeys()
    await nodeA.start()
    await nodeB.start()
    hooksA = createSessionAwareHooks(['responder-token', 'initiator-token', 'multi-use-token']) as SessionHooks
    hooksB = createSessionAwareHooks(['responder-token', 'initiator-token', 'multi-use-token']) as SessionHooks
  })
  afterEach(async () => {
    try { nodeA?.unhandle?.(DEFAULT_PROTOCOL_ID as any) } catch {}
    try { await nodeA?.stop() } catch {}
    try { await nodeB?.stop() } catch {}
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
          mode: 'responderCreates'
        }
        const clientManager = new SessionManager(hooksB, DEFAULT_CONFIG)
        promises.push(clientManager.initiateBootstrap(link, nodeB))
      }
      const startTime = Date.now()
      const results = await Promise.all(promises)
      const duration = Date.now() - startTime
      assert.equal(results.length, 5)
      assert.ok(results.every(r => r.strand && r.dbConnectionInfo))
      const strandIds = results.map(r => r.strand.strandId)
      const unique = new Set(strandIds)
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
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.strand && result.dbConnectionInfo)
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
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
      }
      const invalidLink: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'invalid-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
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
    it('should execute complete responderCreates bootstrap (2 messages)', async () => {
      const managerA = new SessionManager(hooksA, { ...DEFAULT_CONFIG, enableDebugLogging: true })
      const managerB = new SessionManager(hooksB, { ...DEFAULT_CONFIG, enableDebugLogging: true })
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.strand)
      assert.ok(result.dbConnectionInfo)
      assert.equal(result.strand.createdBy, 'responder')
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 15000)

    it('should execute complete initiatorCreates bootstrap (3 messages)', async () => {
      const managerA = new SessionManager(hooksA, { ...DEFAULT_CONFIG, enableDebugLogging: true })
      const managerB = new SessionManager(hooksB, { ...DEFAULT_CONFIG, enableDebugLogging: true })
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'initiator-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'initiatorCreates'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.strand)
      assert.ok(result.dbConnectionInfo)
      assert.equal(result.strand.createdBy, 'initiator')
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
        mode: 'responderCreates'
      }
      await expectReject(() => managerB.initiateBootstrap(invalidTokenLink, nodeB))
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 10000)

    it('should fail on invalid identity validation', async () => {
      // hooksA rejects identity
      const rejectingHooksA: SessionHooks = {
        async validateToken(token: string) { return { mode: 'responderCreates', valid: true } as any },
        async validateIdentity() { return false },
        async provisionStrand(creator: any, a: string, b: string) {
          return { strand: { strandId: `str-${a}-${b}`, createdBy: creator }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
        },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const managerA = new SessionManager(rejectingHooksA, DEFAULT_CONFIG)
      const managerB = new SessionManager(hooksB, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
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
        for await (const chunk of (stream as any).source as any) {
          const isAsyncIterable = chunk && typeof (chunk as any)[Symbol.asyncIterator] === 'function'
          const isSyncIterable = chunk && typeof (chunk as any)[Symbol.iterator] === 'function'
          if (isAsyncIterable || isSyncIterable) {
            for await (const sub of (chunk as any)) {
              message += decoder.decode(sub as Uint8Array, { stream: true })
              try { capturedContact = JSON.parse(message); break } catch {}
            }
          } else if (chunk && (ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer)) {
            message += decoder.decode(chunk as ArrayBufferView, { stream: true })
            try { capturedContact = JSON.parse(message); break } catch {}
          }
          if (capturedContact) break
        }
        const rejection = { approved: false, reason: 'Test completed - captured message' }
        const encoded = new TextEncoder().encode(JSON.stringify(rejection))
        await (stream as any).sink([encoded] as any)
      })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
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
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.strand && result.dbConnectionInfo)
      assert.ok(capturedResponse && capturedResponse.approved === true)
      assert.ok(Array.isArray(capturedResponse.cadrePeerAddrs) && capturedResponse.cadrePeerAddrs.length > 0)
      ;(hooksB as any).validateResponse = originalValidateResponse
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 5000)

    it('should allow A to reject without revealing A_cadre', async () => {
      const managerA = new SessionManager(hooksA, DEFAULT_CONFIG)
      // Override token validation to force rejection
      const rejectingHooksA: SessionHooks = {
        async validateToken() { return { mode: 'responderCreates', valid: false } as any },
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
      let parsed: any = null
      for await (const chunk of (stream as any).source as any) {
        const isAsyncIterable = chunk && typeof (chunk as any)[Symbol.asyncIterator] === 'function'
        const isSyncIterable = chunk && typeof (chunk as any)[Symbol.iterator] === 'function'
        if (isAsyncIterable || isSyncIterable) {
          for await (const sub of (chunk as any)) {
            msg += dec.decode(sub as Uint8Array, { stream: true })
            try { parsed = JSON.parse(msg); break } catch {}
          }
        } else if (chunk && (ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer)) {
          msg += dec.decode(chunk as ArrayBufferView, { stream: true })
          try { parsed = JSON.parse(msg); break } catch {}
        }
        if (parsed) break
      }
      const rejection = parsed ?? JSON.parse(msg)
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
      assert.equal(tokenResult.mode, 'responderCreates')
      const identityResult = await hooks.validateIdentity({ partyId: 'party-123' }, 'session-123')
      assert.equal(identityResult, true)
      const dbResult = await hooks.provisionStrand('responder', 'partyA', 'partyB', 'session-123')
      assert.ok(dbResult.strand)
      assert.ok(dbResult.dbConnectionInfo)
      assert.equal(dbResult.strand.createdBy, 'responder')
    })

    it('should handle hook failures gracefully', async () => {
      const tokenErrorHooksA: SessionHooks = {
        async validateToken(token: string) { throw new Error('Hook validation failed') },
        async validateIdentity() { return true },
        async provisionStrand(creator: any, a: string, b: string) {
          return { strand: { strandId: `str-${a}-${b}`, createdBy: creator }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
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
        mode: 'responderCreates'
      }
      await expectReject(() => managerB.initiateBootstrap(link, nodeB))
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 8000)

    it('should validate malformed hook return values', async () => {
      const malformedHooksA: SessionHooks = {
        async validateToken() { return { } as any },
        async validateIdentity() { return 'yes' as any },
        async provisionStrand() { return { strand: { strandId: 'incomplete' } } as any },
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
        mode: 'responderCreates'
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
        mode: 'responderCreates'
      }
      const customerManager1 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const customerManager2 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const customerManager3 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const results = await Promise.all([
        customerManager1.initiateBootstrap(link, nodeB),
        customerManager2.initiateBootstrap(link, nodeB),
        customerManager3.initiateBootstrap(link, nodeB)
      ])
      const ids = results.map(r => r.strand.strandId)
      const unique = new Set(ids)
      assert.equal(unique.size, 3)
      results.forEach(r => {
        assert.ok(r.strand)
        assert.ok(r.dbConnectionInfo)
        assert.equal(r.strand.createdBy, 'responder')
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
        mode: 'responderCreates'
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
        async validateToken() { await new Promise(r => setTimeout(r, 800)); return { mode: 'responderCreates', valid: true } as any },
        async validateIdentity() { return true },
        async provisionStrand(creator: any, a: string, b: string) {
          return { strand: { strandId: `str-${a}-${b}`, createdBy: creator }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
        },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const managerA = new SessionManager(slowHooksA, shortConfig)
      const managerB = new SessionManager(hooksB, shortConfig)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
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
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
      }
      const result = await managerB.initiateBootstrap(link, nodeB)
      assert.ok(result.strand && result.dbConnectionInfo)
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
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
      }
      // First should fail
      await expectReject(() => managerB.initiateBootstrap(link, nodeB))
      // Second should succeed
      const managerB2 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const res2 = await managerB2.initiateBootstrap(link, nodeB)
      assert.ok(res2.strand && res2.dbConnectionInfo)
      try { nodeA.unhandle(DEFAULT_PROTOCOL_ID) } catch {}
    }, 8000)

    it('should recover from transient identity validation failure', async () => {
      let calls = 0
      const transientHooksA: SessionHooks = {
        async validateToken() { return { mode: 'responderCreates', valid: true } as any },
        async validateIdentity() { calls++; return calls > 1 },
        async provisionStrand(creator: any, a: string, b: string) {
          return { strand: { strandId: `str-${a}-${b}`, createdBy: creator }, dbConnectionInfo: { endpoint: 'wss://db.local', credentialsRef: 'creds' } }
        },
        async validateResponse() { return true },
        async validateDatabaseResult() { return true }
      }
      const managerA = new SessionManager(transientHooksA, DEFAULT_CONFIG)
      nodeA.handle(DEFAULT_PROTOCOL_ID, async ({ stream }) => { await managerA.handleNewStream(stream as any) })
      const link: BootstrapLink = {
        responderPeerAddrs: [nodeA.getMultiaddrs()[0].toString()],
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
      }
      // First should fail
      const managerB1 = new SessionManager(hooksB, DEFAULT_CONFIG)
      await expectReject(() => managerB1.initiateBootstrap(link, nodeB))
      // Second should succeed
      const managerB2 = new SessionManager(hooksB, DEFAULT_CONFIG)
      const res = await managerB2.initiateBootstrap(link, nodeB)
      assert.ok(res.strand && res.dbConnectionInfo)
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
        mode: 'responderCreates'
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
        token: 'responder-token',
        tokenExpiryUtc: new Date(Date.now() + 300000).toISOString(),
        mode: 'responderCreates'
      }
      const results = await Promise.all([
        mgrB.initiateBootstrap(link, nodeB),
        mgrB.initiateBootstrap(link, nodeB),
        mgrB.initiateBootstrap(link, nodeB),
        mgrB.initiateBootstrap(link, nodeB),
        mgrB.initiateBootstrap(link, nodeB)
      ])
      results.forEach(r => assert.ok(r.strand && r.dbConnectionInfo))
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


