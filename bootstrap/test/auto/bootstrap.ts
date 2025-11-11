/*
  Bootstrap tests:
  - Enable only the first sanity test.
*/
import { strict as assert } from 'assert'
import { describe, it, beforeEach } from 'vitest'
import { SessionManager, type SessionConfig } from '../../src/bootstrap.js'
import { createSessionAwareHooks } from '../helpers/consumerMocks.js'

const DEFAULT_CONFIG: SessionConfig = {
  sessionTimeoutMs: 30000,
  stepTimeoutMs: 5000,
  maxConcurrentSessions: 100
}

describe('Sereus Bootstrap State Machine (sanity)', () => {
  it('should create and configure properly', () => {
  const hooks = createSessionAwareHooks(['responder-token', 'initiator-token', 'multi-use-token']) as any
    const manager = new SessionManager(hooks, DEFAULT_CONFIG)
    assert.ok(manager)
    const counts = manager.getActiveSessionCounts()
    assert.equal(counts.listeners, 0)
    assert.equal(counts.dialers, 0)
  })
})

// The comprehensive suite lives in bootstrap.integration.ts


