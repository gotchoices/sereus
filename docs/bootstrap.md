# Sereus Bootstrap – Protocol and Implementation Notes

This document captures protocol/usage details from the original Taleus bootstrap design, adapted for Sereus. It supplements `sereus/bootstrap/README.md` with rationale, flows, and security notes so Taleus can be retired without losing important knowledge.

## Scope
- Invitation-based establishment of a shared thread (SQL DB) between participants.
- Transport: libp2p streams. Consensus/data-layer handled by Quereus/Optimystic.
- Roles are logical; apps decide semantics. Library supports two primary flows and rejection.

## Protocol Identity
- Default: `/sereus/bootstrap/1.0.0`.
- Apps may override per manager (`config.protocolId`) and/or per initiation (`link.protocolId`) to use domain-specific IDs (e.g., `/mychips/bootstrap/1.0.0`).

## Message Types (Canonical Shapes)

```ts
// 1) Initiator → Responder
interface InboundContactMessage {
  token: string                    // application-defined intent; may encode role, scope, expiry
  partyId: string                  // initiator identity (peer/node id or app id)
  identityBundle: unknown          // opaque to protocol; app validates
  cadrePeerAddrs: string[]         // initiator’s nominated nodes
}

// 2) Responder → Initiator (after validation)
interface ProvisioningResultMessage {
  approved: boolean
  reason?: string                  // present if approved=false
  partyId?: string                 // responder id (if approved)
  cadrePeerAddrs?: string[]        // responder’s nodes (if approved)
  provisionResult?: ProvisionResult // present in 2-msg flow
}

// 3) Initiator → Responder (foil flow; NEW stream)
interface DatabaseResultMessage {
  thread: { threadId: string; createdBy: 'stock'|'foil' }
  dbConnectionInfo: { endpoint: string; credentialsRef: string }
}
```

Notes:
- `identityBundle` is protocol-opaque; provide app validators via hooks.
- `dbConnectionInfo` typically contains an endpoint and a reference to credentials stored out-of-band.

## Flows

### Stock Role (2 messages)
1. Initiator sends InboundContact.
2. Responder validates token/identity, provisions thread, and replies with ProvisioningResult (includes provisionResult).

### Foil Role (3 messages)
1. Initiator sends InboundContact.
2. Responder validates token/identity and replies with ProvisioningResult (no provisionResult yet).
3. Initiator provisions thread and sends DatabaseResult on a NEW stream.

### Rejection Flow
- Responder returns `approved=false` with `reason` and discloses no responder cadre.

## libp2p Stream Lifecycle
- Use single-use streams per message exchange.
- In the foil (3-message) flow, step 3 MUST open a NEW stream with `dialProtocol()`; do not reuse the original stream after it has been read to completion.

## Security & Privacy
- Cadre disclosure timing (Method 6):
  - InboundContact discloses initiator’s cadre.
  - ProvisioningResult discloses responder’s cadre only after token/identity validation.
  - Rejection MUST NOT include responder cadre.
- Token security: Tokens define intent, roles, and expiry and should be validated by app hooks.
- Identity validation: `identityBundle` structure is application-defined. Validate before disclosing responder cadre or provisioning resources.
- Never assume stream reuse. Close or recreate appropriately to avoid stuck pipes.

## Hooks (Application Integration)
- `validateToken(token, sessionId) → { role, valid }`
- `validateIdentity(identity, sessionId) → boolean`
- `provisionThread(role, partyA, partyB, sessionId) → { thread, dbConnectionInfo }`
- `validateResponse(msg, sessionId) → boolean`
- `validateDatabaseResult(msg, sessionId) → boolean`

These hooks are the extension points for:
- Mapping tokens to role and scopes.
- Enforcing invitation policies.
- Creating the Quereus thread (apply schema, create creds, return connection).

## Concurrency, Limits, and Timeouts
- Session manager supports unlimited sessions by default; configure `maxConcurrentSessions` to protect responders.
- Per-session timeouts (`sessionTimeoutMs`, `stepTimeoutMs`) prevent resource starvation.
- Failures are session-scoped; isolation ensures a bad session doesn’t affect others.

## Error Handling Patterns
- On validation failure: send rejection and close.
- On network failure: caller should retry (new session id). Tests show recovery after transient faults.
- On malformed hook returns: treat as validation failure or timeout.

## Multi-use Tokens / Multi-customer Scenarios
- The library allows reusing tokens if app policy permits. Tests demonstrate multiple concurrent bootstraps using the same token generating distinct threads.
- For stricter policies, encode single-use constraints in token validation.

## Extending to N-Party Bootstrap (Roadmap)
- Current flows are 2-party. N-party can be layered as:
  1) Initiator collects approvals (ProvisioningResult) from N-1 responders.
  2) After quorum, initiator provisions thread and distributes DatabaseResult to each responder (new stream per responder).
  3) Optional: distribute credentials asymmetrically per participant.
- Disclosure rules apply per leg; only disclose a party’s cadre after validating their token/identity.

## Implementation Highlights
- Session isolation: listener/dialer classes with explicit state transitions and cleanup on finish/error.
- Proper libp2p usage: reading a stream to completion, writing JSON as a single encoded chunk, opening a NEW stream when required.
- Configurability: protocol id is configurable in manager config and per link.

## Testing Summary (port of Taleus tests)
- Concurrency: multiple bootstraps run in parallel; each gets unique thread ids.
- Limits: configured max concurrent sessions enforced; either rejections or queued/batched handling.
- Error isolation: invalid sessions don’t affect others; sessions cleaned up after finish.
- Timeouts & network failures: short timeouts trigger expected errors; recovery verified by subsequent success.
- Cadre disclosure: initiator cadre in message 1; responder cadre only after validation; no cadre on rejection.

## Migration Notes from Taleus
- Terminology changed: tally → thread; provisioning result fields renamed accordingly.
- Protocol id changed and made configurable.
- App-specific domain (credit chits, lifts, admin/officer policies, signatures) intentionally excluded from bootstrap; to be implemented in app layers on top of the thread.

## References
- `sereus/bootstrap/src/bootstrap.ts` (implementation)
- `sereus/bootstrap/test/auto/bootstrap.ts` (integration tests)
- `sereus/docs/schema-guide.md` (Quereus thread schema patterns)


