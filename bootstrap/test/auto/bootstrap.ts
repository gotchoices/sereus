/*
  Port of Taleus Bootstrap tests:
  - Enable only the very first original test.
  - All remaining Taleus tests will be ported next and initially skipped.
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

// The full Taleus suite will be ported and initially skipped in a follow-up commit.


