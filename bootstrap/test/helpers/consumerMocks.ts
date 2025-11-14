/*
  Session-aware hooks for bootstrap testing (strand-oriented)
*/

import type { SessionHooks, ProvisionResult, BootstrapMode, DialogParty } from '../../src/bootstrap.js'

export function createSessionAwareHooks(validTokens: string[] = ['test-token']): SessionHooks {
  const tokenDatabase = new Map<string, { mode?: BootstrapMode, valid: boolean, multiUse: boolean }>()
  const provisioningDatabase = new Map<string, ProvisionResult>()
  const sessionLogs = new Map<string, any[]>()

  validTokens.forEach(token => {
    if (token === 'responder-token') tokenDatabase.set(token, { mode: 'responderCreates', valid: true, multiUse: false })
    else if (token === 'initiator-token') tokenDatabase.set(token, { mode: 'initiatorCreates', valid: true, multiUse: false })
    else if (token === 'multi-use-token') tokenDatabase.set(token, { mode: 'responderCreates', valid: true, multiUse: true })
    else tokenDatabase.set(token, { mode: 'responderCreates', valid: true, multiUse: false })
  })

  function log(sessionId: string, activity: any) {
    if (!sessionLogs.has(sessionId)) sessionLogs.set(sessionId, [])
    sessionLogs.get(sessionId)!.push({ ...activity, ts: Date.now() })
  }

  return {
    async validateToken(token: string, sessionId: string) {
      log(sessionId, { action: 'validateToken', token })
      const info = tokenDatabase.get(token)
      if (!info) return { mode: 'responderCreates', valid: false }
      return { mode: info.mode, valid: info.valid }
    },
    async validateIdentity(identity: any, sessionId: string) {
      log(sessionId, { action: 'validateIdentity' })
      return !!(identity && typeof identity === 'object' && (identity.partyId || identity.id))
    },
    async provisionStrand(creator: DialogParty, partyA: string, partyB: string, sessionId: string) {
      log(sessionId, { action: 'provisionStrand', creator, partyA, partyB })
      const id = `str-${partyA}-${partyB}-${Date.now()}`
      const result: ProvisionResult = {
        strand: { strandId: id, createdBy: creator },
        dbConnectionInfo: { endpoint: `wss://db-${id}.example.com`, credentialsRef: `creds-${id}` }
      }
      provisioningDatabase.set(sessionId, result)
      return result
    },
    async validateResponse(response: any, sessionId: string) {
      log(sessionId, { action: 'validateResponse' })
      return response && typeof response.approved === 'boolean'
    },
    async validateDatabaseResult(result: any, sessionId: string) {
      log(sessionId, { action: 'validateDatabaseResult' })
      return result && result.strand && result.dbConnectionInfo
    }
  }
}


