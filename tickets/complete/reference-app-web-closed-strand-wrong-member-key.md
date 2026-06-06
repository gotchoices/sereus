description: Fixed the web reference app's closed-strand formation flow — host provisions a member key + binds a FormationInvite to a real closed strand, the responder wires a ControlFormationUsageRecorder, and the joiner attaches with `memberPrivateKey` (failing loudly when absent) instead of the always-`''` `invitePrivateKey`. Reviewed and corrected one diagnostics asymmetry.
files: packages/reference-app-web/src/lib/cadre-web.ts
----

## Summary

The web `joinViaInvitation` attached the formed closed strand with the wrong
`FormStrandResult` field (`invitePrivateKey`, which is `''` on the manager's
`dialFormation` path) instead of `memberPrivateKey`, and the web **host** never
provisioned a member key, so a bare field swap would have made every join throw.
The implement stage mirrored RN's provision-then-record flow end-to-end inside
`cadre-web.ts`: responder wires a `ControlFormationUsageRecorder`; host mints a
closed strand, publishes it, and binds a `FormationInvite` to its `strandId`;
joiner attaches with `result.memberPrivateKey` and throws loudly when it is absent.

Review confirmed the field correctness, key symmetry, invite binding, loud-failure
guard, and no-dangling-strand-on-undialable-tab claims hold against the cadre-core
APIs and the RN reference. One real inconsistency was found and fixed inline.

## Review findings

### Verified correct (no change)

- **Field correctness** — `joinViaInvitation` attaches with `MemberPrivateKey:
  result.memberPrivateKey`. `FormStrandResult` (`cadre-core/src/types.ts:405-419`)
  documents `memberPrivateKey` as the closed-strand read-gating secret and
  `invitePrivateKey` as the initiator's signing key (set to `''` on the dial path,
  `strand-formation-manager.ts:172`). The attach path no longer references
  `invitePrivateKey` (one surviving mention is an explanatory comment contrasting
  the two keys). ✅
- **Provision-then-record wiring** — `ensureSolicitation` initializes solicitation
  with `new ControlFormationUsageRecorder(controlDb)` and throws if the control DB
  is absent. `createOpenInvitation`/`formStrand` lazily init solicitation only when
  `!this.strandSolicitationService` (`cadre-node.ts:1510,1541`); both web entry
  points (`createInvitation`, `joinViaInvitation`) call `ensureSolicitation` first,
  so the recorder is always wired before either lazy path could fire. No other call
  site bypasses it. ✅
- **Key symmetry** — host `publishStrand(strandId,'c',memberPrivateKey)`; the
  recorder's `resolveStrand` returns that strand's `MemberPrivateKey`
  (`control-formation-recorder.ts`), which `provisionAsResponder` threads back as
  `FormStrandResult.memberPrivateKey` (`strand-formation-manager.ts:236-252`). Both
  sides therefore attach with the **same** secret. ✅
- **Loud failure** — the `!result.memberPrivateKey` throw precedes
  `openStores`/`addStrand`, so a non-closed/unprovisioned host never yields a
  silently-unreadable strand. Message matches RN verbatim. ✅
- **Invite binding & ordering** — host runs the dialability guard → creates +
  publishes + attaches the closed strand → `createOpenInvitation` →
  `publishFormationInvite(token, …, { strandId })`. The bound strand exists before
  the invite is advertised. Mirrors RN `createClosedStrandWithInvite`
  (`use-cadre.ts:197-208`) and the `publishStrand`-before-`addStrand` order of RN
  `createClosedChatStrand`. ✅
- **No dangling strand on undialable tabs** — the `relayState.status !== 'reserved'`
  guard runs before `createClosedChatStrand`, so an undialable tab publishes/attaches
  nothing. ✅
- **Type safety / lint / error handling** — no `any`; `result.memberPrivateKey` is
  narrowed to `string` by the guard before reuse; all failure modes throw rather
  than degrade. ✅

### Minor — fixed inline (this pass)

- **`FormedStrand.memberKey` asymmetry.** The host registered
  `memberKey: memberPrivateKey` (the read-gating secret) but the joiner registered
  `memberKey: result.memberKey`, which is the initiator's **partyId**
  (`strand-formation-manager.ts:171` sets `memberKey: contact.partyId`) — NOT a
  membership key. This contradicted both the field's documented meaning and the
  handoff's stated host/joiner symmetry, and would make any e2e convergence check
  comparing the two `memberKey`s fail. Fixed: the joiner now records
  `result.memberPrivateKey` (the same secret it attached with), and the
  `FormedStrand.memberKey` doc comment was tightened to state both sides record the
  same read-gating key. Field is diagnostics-only (surfaced via `getFormedStrands()`
  / the `__cadre` hook; the UI renders only `strandId` + `type`), so no behavioral
  impact — observability correctness only.

### Considered, no action (acceptable for a demo)

- **Dangling host strand if `publishFormationInvite` throws** after the strand is
  published+attached. There is no rollback, but this exactly matches RN's flow
  (`use-cadre.ts:197-208`, also no rollback) and is acceptable for a reference app.
  Not worth a ticket.
- **Per-invite host strand churn** — each `createInvitation` mints a fresh host
  strand (new UUID/key/`Strand` row). Matches RN's per-invite-strand model; the
  implementer already flagged it as out of scope. No change.
- **`activeStrandId` unchanged** — formed closed strands live only in
  `formedStrands`, not `activeStrandId` (which tracks the Phase-1 open chat strand).
  Confirmed no diagnostics path reads `activeStrandId` for formed strands.

### Docs

- No doc under `docs/` describes the web formation flow or `FormedStrand`; nothing
  to update. The change is self-documented within `cadre-web.ts`.

## Validation performed

- `yarn workspace @serfab/reference-app-web typecheck` — clean (EXIT=0).
- `yarn eslint packages/reference-app-web/src/lib/cadre-web.ts` — no findings.
- `yarn workspace @serfab/cadre-core test --run control-formation-invite
  publish-formation-invite strand-formation-consent` — 15/15 passing (exercises the
  provision-then-record path this web code depends on).
- `vite build` skipped: my edit is a single-field change already covered by the
  `tsc` typecheck gate; the implement stage ran the full build clean.

## Deferred (unchanged from implement)

- **No runtime/behavioral test.** This path needs two dialable tabs + relay infra to
  exercise the handshake; it is not single-tab unit-reproducible. Live two-tab e2e
  convergence remains deferred to `reference-app-web-formation-convergence-e2e`
  (backlog) — do not add a flaky single-tab test. With the `memberKey` fix above,
  that e2e can now assert host/joiner `memberKey` equality as a convergence signal.
