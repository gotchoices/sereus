description: Finish adding tests for a fix already landed in code — the joiner's connection-wait time is now automatically set a bit longer than the host's own timeout, and that behavior needs test coverage plus a lint/test run before handoff.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/formation-consent-helper.ts
difficulty: easy
----

<!-- resume-note -->
Prior agent run (this same ticket, original file
`tickets/implement/26-debt-formation-one-budget-drives-both-sides.md`) hit the session's
BUDGET_WARNING partway through. **The source-code fix is DONE and type-checks clean** —
only the test-writing + verification work below remains. No log file to consult; the
summary here is complete context.

## What already landed (do not redo)

`packages/cadre-core/src/strand-formation-protocol.ts`:
- Added `export const PROVISION_RESPONSE_TRAVEL_MARGIN_MS = 3_000;` (the wire-latency
  margin, extracted from the gap that already existed between the two default constants).
- `DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS` is now derived as
  `DEFAULT_PROVISION_TIMEOUT_MS + PROVISION_RESPONSE_TRAVEL_MARGIN_MS` instead of the
  standalone literal `15_000`.

`packages/cadre-core/src/strand-formation-manager.ts`:
- Imports `PROVISION_RESPONSE_TRAVEL_MARGIN_MS` from `strand-formation-protocol.js`.
- Added a private method:
  ```ts
  private initiatorProvisionTimeoutMs(): number | undefined {
    const host = this.config.provisionTimeoutMs;
    return host && host > 0 ? host + PROVISION_RESPONSE_TRAVEL_MARGIN_MS : undefined;
  }
  ```
  (placed right after `getActiveSessionCounts()`, ~line 240).
- The `dialFormation` call inside `formStrand` now passes
  `provisionTimeoutMs: this.initiatorProvisionTimeoutMs()` instead of
  `this.config.provisionTimeoutMs` (the `FormationListener` construction in the
  constructor is UNCHANGED — it still gets the host's own `this.config.provisionTimeoutMs`
  directly).
- `StrandFormationManagerConfig.provisionTimeoutMs`'s doc comment now describes it as the
  RESPONDER's budget only, with the initiator's wait derived automatically.

Verified: `npx tsc --noEmit -p packages/cadre-core/tsconfig.json` is clean.

## What's left: tests + verification

No behavioral test yet confirms the derived relationship. Add coverage (new file
`packages/cadre-core/test/strand-formation-manager.spec.ts`, since neither
`strand-formation-protocol.spec.ts` nor `strand-formation-consent.spec.ts` currently builds
BOTH a responder AND an initiator through one `StrandFormationManager` — the consent spec
only ever drives the manager as a responder via a captured libp2p handler + `MockStream`):

1. **Core regression (behavioral)**: configure ONE `StrandFormationManager` with
   `config.provisionTimeoutMs = N` (pick N small, e.g. 200, to keep the test fast) and a
   `strandProvisioner.provisionStrand` hook that never resolves within `N` (or resolves
   only long after — the point is the RESPONDER's own work+grace budget expires and it
   sends itself a clean `'Formation provisioning timed out'` rejection frame). Wire the
   SAME manager as both responder (`registerResponder`) and initiator (`formStrand`) by
   bridging a fake libp2p node whose `dialProtocol` hands back a stream connected directly
   to the captured `node.handle` callback — see the in-memory bridge design below. Assert
   `formStrand` rejects with `/Formation rejected: Formation provisioning timed out/` (i.e.
   the initiator was STILL LISTENING when the host's own clean timeout reply arrived)
   rather than a generic `Formation await-response timed out after Nms` error (which is
   what you'd see today if the initiator's budget were still equal to `N`).
2. **Unset stays unset**: `config.provisionTimeoutMs` omitted → both sides fall back to
   their own independent defaults (no regression on the default path) — can assert this
   more cheaply via `dialFormation`'s existing default-budget behavior, or by checking
   `initiatorProvisionTimeoutMs()` returns `undefined` if you choose to (carefully) export
   it for a direct unit check instead of only testing behaviorally.
3. **Zero behaves as unset**: `config.provisionTimeoutMs: 0` → same as unset on both sides
   (mirrors the protocol layer's own test at `strand-formation-protocol.spec.ts:322`).

### In-memory duplex bridge (needed for test 1, no real libp2p node required)

`strand-formation-protocol.spec.ts` and `strand-formation-consent.spec.ts` both already use
a one-way `MockStream` (buffers inbound frames, records sent frames) plus a
`captureHandler()` helper that grabs the function passed to `node.handle(...)`. That is NOT
enough here because `formStrand` needs to actually WRITE to the responder's stream and READ
its reply — a real duplex, not a canned inbound frame list.

Build a small `QueueStream` implementing the `ControlStream` interface
(`control-stream.ts`: `AsyncIterable<Uint8Array>` + `send(data): boolean` +
`close(): Promise<void>` + `abort(err): void`), backed by an async pull queue (push
enqueues or resolves a pending `next()`; `end()` completes the iterator). Make a
`makePair()` that returns two cross-wired `QueueStream`s where `a.send()` pushes into `b`'s
queue and vice versa. Then:

```ts
function captureHandler(): { node: Libp2p; handler: (stream: unknown, conn: unknown) => Promise<void> } { /* as in existing specs, but expose handler directly */ }

const { node: respNode, handler } = captureHandler();
manager.registerResponder(respNode);

const dialingNode = {
  dialProtocol: async () => {
    const [respEnd, initEnd] = makePair();
    void handler(respEnd, {}); // run the responder session concurrently
    return initEnd;
  }
} as unknown as Libp2p;

await manager.formStrand(invitation, disclosure, consent, dialingNode);
```

`invitation.bootstrap` just needs one syntactically-valid multiaddr string (e.g.
`'/ip4/127.0.0.1/tcp/1'`) — `dialFormation` parses it with `multiaddr(...)` before dialing,
but the mock `dialProtocol` above ignores the address and returns the bridged stream
directly.

**Consent/disclosure setup**: the responder's `isJoinerConsentValid` pre-check does REAL
ed25519 verification, so a hand-rolled fake consent will be rejected before your timeout
scenario ever runs. Use `mintContactJoiner()` + `mintContactConsent()` from
`test/formation-consent-helper.ts` (already used by both existing specs) to build a
genuinely valid `{ peerKey, usageStampId, peerSignature }` triple for `formStrand`'s
`consent` parameter — see either spec file for the exact call shape.

## After tests are added

Run and confirm both pass, from the `cadre-core` package:

```
yarn workspace @serfab/cadre-core test
yarn lint
```

If `yarn workspace @serfab/cadre-core test` surfaces any FAILURE unrelated to this ticket's
diff (i.e. not in `strand-formation-manager.spec.ts`/`strand-formation-protocol.ts`/
`strand-formation-manager.ts`), check `tickets/.pre-existing-known.md` first, then follow
the pre-existing-failure procedure in the ticket workflow rules (write
`tickets/.pre-existing-error.md`, do not skip/loosen the test).

## Handoff

Once tests are green and lint passes, write the `review/` ticket per the normal
`implement` → `review` handoff: summarize the fix (one config knob per role, no new
validation/rejection logic needed — a mismatched pairing is now structurally unreachable),
list the new test(s) and what they cover, and flag any gaps honestly (e.g. if the
in-memory-bridge test above ends up covering only the timeout scenario and not the
unset/zero cases behaviorally, say so explicitly rather than implying full coverage).
