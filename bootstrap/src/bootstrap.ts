/*
 * Sereus Bootstrap Session Manager
 *
 * Generic invitation-based bootstrap over libp2p to provision a shared strand (DB).
 * Protocol string is configurable; default provided.
 */

import type { Libp2p } from 'libp2p'
import { multiaddr as toMultiaddr } from '@multiformats/multiaddr'

export const DEFAULT_PROTOCOL_ID = '/sereus/bootstrap/1.0.0'

// Dialog party (generic)
export type DialogParty = 'initiator' | 'responder'

// Generic mode describing who provisions the DB/strand
// responderCreates: responder provisions and returns info in Response (2-message)
// initiatorCreates: initiator provisions after approval and sends DB info (3-message)
export type BootstrapMode = 'responderCreates' | 'initiatorCreates'

export type ListenerState = 'L_PROCESS_CONTACT' | 'L_SEND_RESPONSE' | 'L_AWAIT_DATABASE' | 'L_DONE' | 'L_FAILED'
export type DialerState = 'D_SEND_CONTACT' | 'D_AWAIT_RESPONSE' | 'D_PROVISION_DATABASE' | 'D_DONE' | 'D_FAILED'

// Minimal libp2p stream surface
export interface LibP2PStream {
  source: AsyncIterable<Uint8Array>
  sink(source: AsyncIterable<Uint8Array>): Promise<void>
  closeWrite?(): void
  close?(): void
}

export interface SessionConfig {
  sessionTimeoutMs: number
  stepTimeoutMs: number
  maxConcurrentSessions: number
  enableDebugLogging?: boolean
  protocolId?: string
}

export interface SessionHooks {
  // Return Mode (preferred)
  validateToken(token: string, sessionId: string): Promise<{ mode: BootstrapMode, valid: boolean }>
  validateIdentity(identity: unknown, sessionId: string): Promise<boolean>
  provisionStrand(creator: DialogParty, creatorPartyId: string, otherPartyId: string, sessionId: string): Promise<ProvisionResult>
  validateResponse(response: unknown, sessionId: string): Promise<boolean>
  validateDatabaseResult(result: unknown, sessionId: string): Promise<boolean>
}

export interface BootstrapLink {
  responderPeerAddrs: string[]
  token: string
  tokenExpiryUtc: string
  // Explicit mode (who creates the DB)
  mode?: BootstrapMode
  identityRequirements?: string
  protocolId?: string
}

export interface InboundContactMessage {
  token: string
  partyId: string
  identityBundle: unknown
  cadrePeerAddrs: string[]
}

export interface ProvisioningResultMessage {
  approved: boolean
  reason?: string
  partyId?: string
  cadrePeerAddrs?: string[]
  provisionResult?: ProvisionResult
}

export interface DatabaseResultMessage {
  strand: { strandId: string, createdBy: DialogParty }
  dbConnectionInfo: { endpoint: string, credentialsRef: string }
}

export interface ProvisionResult {
  strand: { strandId: string, createdBy: DialogParty }
  dbConnectionInfo: { endpoint: string, credentialsRef: string }
}

export interface BootstrapResult {
  strand: { strandId: string, createdBy: DialogParty }
  dbConnectionInfo: { endpoint: string, credentialsRef: string }
}

async function writeJson(stream: LibP2PStream, obj: unknown, closeAfter = false): Promise<void> {
  const jsonData = JSON.stringify(obj)
  const encoded = new TextEncoder().encode(jsonData)
  async function* one() { yield encoded }
  await stream.sink(one())
  if (closeAfter) {
    if (stream.closeWrite) stream.closeWrite()
    else if (stream.close) stream.close()
  }
}

async function readJson<T = unknown>(stream: LibP2PStream): Promise<T> {
  const decoder = new TextDecoder()
  let message = ''
  for await (const chunk of stream.source) {
    // Some libp2p implementations yield iterables of Uint8Array "sub-chunks"
    const maybeIterable = chunk as unknown as Iterable<Uint8Array>
    if (chunk instanceof Uint8Array) {
      message += decoder.decode(chunk, { stream: true })
    } else if (maybeIterable && typeof (maybeIterable as any)[Symbol.iterator] === 'function') {
      for (const part of maybeIterable) {
        message += decoder.decode(part, { stream: true })
      }
    } else {
      // Fallback: attempt to decode directly
      // @ts-ignore
      message += decoder.decode(chunk, { stream: true })
    }
    // Try to parse incrementally to avoid hanging on streams that don't close
    try {
      const trimmed = message.trim()
      if (trimmed.length > 0) {
        return JSON.parse(trimmed) as T
      }
    } catch {
      // keep buffering until valid JSON is received
    }
  }
  if (!message.trim()) throw new Error('Received empty data from stream')
  return JSON.parse(message.trim()) as T
}

export class SessionManager {
  private listenerSessions = new Map<string, ListenerSession>()
  private dialerSessions = new Map<string, DialerSession>()
  private sessionCounter = 0

  constructor(
    private hooks: SessionHooks,
    private config: SessionConfig = {
      sessionTimeoutMs: 30000,
      stepTimeoutMs: 5000,
      maxConcurrentSessions: 100,
      protocolId: DEFAULT_PROTOCOL_ID
    }
  ) {}

  private generateSessionId(): string {
    return `session-${Date.now()}-${++this.sessionCounter}`
  }

  // Helper to register/unregister libp2p protocol handlers
  register(node: Libp2p, protocolId?: string): void {
    const pid = protocolId || this.config.protocolId || DEFAULT_PROTOCOL_ID
    node.handle(pid, async ({ stream }) => {
      await this.handleNewStream(stream as any)
    })
  }
  unregister(node: Libp2p, protocolId?: string): void {
    const pid = protocolId || this.config.protocolId || DEFAULT_PROTOCOL_ID
    try { node.unhandle(pid) } catch {}
  }

  async handleNewStream(stream: LibP2PStream): Promise<void> {
    if (this.listenerSessions.size >= this.config.maxConcurrentSessions) {
      await writeJson(stream, { approved: false, reason: 'Too many concurrent sessions' }, true)
      return
    }
    const sessionId = this.generateSessionId()
    const session = new ListenerSession(sessionId, stream, this.hooks, this.config)
    this.listenerSessions.set(sessionId, session)
    session.execute().catch(() => {}).finally(() => this.listenerSessions.delete(sessionId))
  }

  async initiateBootstrap(link: BootstrapLink, node: Libp2p): Promise<BootstrapResult> {
    const sessionId = this.generateSessionId()
    const session = new DialerSession(sessionId, link, node, this.hooks, this.config)
    this.dialerSessions.set(sessionId, session)
    try { return await session.execute() } finally { this.dialerSessions.delete(sessionId) }
  }

  getActiveSessionCounts(): { listeners: number, dialers: number } {
    return { listeners: this.listenerSessions.size, dialers: this.dialerSessions.size }
  }
}

function tokenInfoToMode(tokenInfo: { mode?: BootstrapMode }): BootstrapMode {
  if (tokenInfo.mode) return tokenInfo.mode
  // Default to responderCreates if unspecified
  return 'responderCreates'
}
function linkToMode(link: BootstrapLink): BootstrapMode {
  if (link.mode) return link.mode
  return 'responderCreates'
}

export class ListenerSession {
  private state: ListenerState = 'L_PROCESS_CONTACT'
  private startTime = Date.now()
  private tokenInfo: { mode?: BootstrapMode, valid: boolean } | null = null
  private contactMessage: InboundContactMessage | null = null
  private provisionResult: ProvisionResult | null = null

  constructor(
    private sessionId: string,
    private stream: LibP2PStream,
    private hooks: SessionHooks,
    private config: SessionConfig
  ) {}

  async execute(): Promise<void> {
    try {
      await this.withTimeout(this.config.sessionTimeoutMs, async () => {
        await this.processContact()
        await this.sendResponse()
        if (tokenInfoToMode(this.tokenInfo!) === 'initiatorCreates') await this.awaitDatabase()
        this.transitionTo('L_DONE')
        this.closeStream()
      })
    } catch (e) {
      this.transitionTo('L_FAILED', e)
      throw e
    }
  }

  private async processContact(): Promise<void> {
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] processContact: waiting for contact`)
    const msg = await this.withStepTimeout(() => readJson<InboundContactMessage>(this.stream))
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] received contact`, msg)
    this.contactMessage = msg
    const tokenInfo = await this.withStepTimeout(() => this.hooks.validateToken(msg.token, this.sessionId))
    this.tokenInfo = tokenInfo as any
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] token validated`, tokenInfo)
    if (!this.tokenInfo?.valid) { await this.sendRejection('Invalid token'); throw new Error('Invalid token') }
    const okId = await this.withStepTimeout(() => this.hooks.validateIdentity(msg.identityBundle, this.sessionId))
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] identity validated=${okId}`)
    if (!okId) { await this.sendRejection('Invalid identity'); throw new Error('Invalid identity') }
    const mode = tokenInfoToMode(this.tokenInfo!)
    if (mode === 'responderCreates') {
      if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] provisioning (responderCreates mode)`)
      this.provisionResult = await this.withStepTimeout(() => this.hooks.provisionStrand('responder', this.sessionId, msg.partyId, this.sessionId))
      if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] provisioned`, this.provisionResult)
    }
  }

  private async sendResponse(): Promise<void> {
    this.transitionTo('L_SEND_RESPONSE')
    if (!this.tokenInfo || !this.contactMessage) throw new Error('Invalid state')
    const response: ProvisioningResultMessage = {
      approved: true,
      partyId: this.sessionId,
      cadrePeerAddrs: ['cadre-a-1.local', 'cadre-a-2.local'],
      provisionResult: this.provisionResult || undefined
    }
    // Close write after sending to signal end-of-message to the peer
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] sending response`, response)
    await this.withStepTimeout(() => writeJson(this.stream, response, true))
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] response sent and write-closed`)
  }

  private async awaitDatabase(): Promise<void> {
    this.transitionTo('L_AWAIT_DATABASE')
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] awaiting database message`)
    const db = await this.withStepTimeout(() => readJson<DatabaseResultMessage>(this.stream))
    const valid = await this.withStepTimeout(() => this.hooks.validateDatabaseResult(db, this.sessionId))
    if (!valid) throw new Error('Invalid database result')
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] database message accepted`)
  }

  private transitionTo(s: ListenerState, _e?: unknown): void { this.state = s }
  private async withTimeout<T>(ms: number, op: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Session timeout after ${ms}ms`)), ms)
      op().then(resolve).catch(reject).finally(() => clearTimeout(t))
    })
  }
  private withStepTimeout<T>(op: () => Promise<T>): Promise<T> { return this.withTimeout(this.config.stepTimeoutMs, op) }
  private async sendRejection(reason: string): Promise<void> { await writeJson(this.stream, { approved: false, reason }, true) }
  private closeStream(): void { try { this.stream.closeWrite?.(); this.stream.close?.() } catch {} }
}

export class DialerSession {
  private state: DialerState = 'D_SEND_CONTACT'
  private startTime = Date.now()
  private stream: LibP2PStream | null = null
  private responseMessage: ProvisioningResultMessage | null = null

  constructor(
    private sessionId: string,
    private link: BootstrapLink,
    private node: Libp2p,
    private hooks: SessionHooks,
    private config: SessionConfig
  ) {}

  async execute(): Promise<BootstrapResult> {
    try {
      return await this.withTimeout(this.config.sessionTimeoutMs, async () => {
        this.stream = await this.connectAndSend()
        this.responseMessage = await this.awaitResponse()
        const mode = linkToMode(this.link)
        if (mode === 'initiatorCreates') {
          return await this.provisionAndSendDatabase()
        } else {
          if (!this.responseMessage.provisionResult) throw new Error('Missing provision result for responderCreates mode')
          this.closeStream()
          return this.responseMessage.provisionResult
        }
      })
    } catch (e) {
      this.state = 'D_FAILED'
      throw e
    }
  }

  private async connectAndSend(): Promise<LibP2PStream> {
    const responderAddr = toMultiaddr(this.link.responderPeerAddrs[0])
    const pid = this.link.protocolId || this.config.protocolId || DEFAULT_PROTOCOL_ID
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] dialing`, responderAddr.toString(), 'pid', pid)
    const stream = await this.withStepTimeout(async () => (await this.node.dialProtocol(responderAddr, pid)) as LibP2PStream)
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] dialed; sending contact`)
    const contact: InboundContactMessage = {
      token: this.link.token,
      partyId: this.sessionId,
      identityBundle: { partyId: this.sessionId },
      cadrePeerAddrs: ['cadre-b-1.local', 'cadre-b-2.local']
    }
    // Close write to signal message boundary; keep read side open to receive response
    await this.withStepTimeout(() => writeJson(stream, contact, true))
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] contact sent and write-closed`)
    return stream
  }

  private async awaitResponse(): Promise<ProvisioningResultMessage> {
    if (!this.stream) throw new Error('No stream')
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] awaiting response`)
    const response = await this.withStepTimeout(() => readJson<ProvisioningResultMessage>(this.stream!))
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] response received`, response)
    if (!response.approved) throw new Error(`Bootstrap rejected: ${response.reason || 'No reason provided'}`)
    const ok = await this.withStepTimeout(() => this.hooks.validateResponse(response, this.sessionId))
    if (!ok) throw new Error('Invalid response from peer')
    return response
  }

  private async provisionAndSendDatabase(): Promise<BootstrapResult> {
    if (!this.responseMessage) throw new Error('No response message available')
    let provision: ProvisionResult
    try {
      provision = await this.withStepTimeout(() => this.hooks.provisionStrand('initiator', this.sessionId, this.responseMessage!.partyId!, this.sessionId))
    } catch (e: any) {
      this.state = 'D_FAILED'
      throw new Error(`Provisioning failed: ${e?.message || String(e)}`)
    }
    const dbMsg: DatabaseResultMessage = { strand: provision.strand, dbConnectionInfo: provision.dbConnectionInfo }
    const pid = this.link.protocolId || this.config.protocolId || DEFAULT_PROTOCOL_ID
    const maddr = toMultiaddr(this.link.responderPeerAddrs[0])
    const newStream = await this.withStepTimeout(async () => (await this.node.dialProtocol(maddr, pid)) as LibP2PStream)
    await this.withStepTimeout(() => writeJson(newStream, dbMsg, true))
    this.closeStream()
    return provision
  }

  private async withTimeout<T>(ms: number, op: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Session timeout after ${ms}ms`)), ms)
      op().then(resolve).catch(reject).finally(() => clearTimeout(t))
    })
  }
  private withStepTimeout<T>(op: () => Promise<T>): Promise<T> { return this.withTimeout(this.config.stepTimeoutMs, op) }
  private closeStream(): void { try { this.stream?.closeWrite?.(); this.stream?.close?.() } catch {} }
}

export function createBootstrapManager(hooks: SessionHooks, config?: Partial<SessionConfig>): SessionManager {
  const full: SessionConfig = {
    sessionTimeoutMs: 30000,
    stepTimeoutMs: 5000,
    maxConcurrentSessions: 100,
    enableDebugLogging: false,
    protocolId: DEFAULT_PROTOCOL_ID,
    ...config
  }
  return new SessionManager(hooks, full)
}


