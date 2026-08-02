description: One config knob used to set both sides' timeout for waiting on a strand-formation handshake; now the responder's own timeout and the joiner's wait-for-response timeout are separate, with the joiner's automatically padded longer so the responder's own timeout reply always has time to arrive first.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/strand-formation-manager.spec.ts, packages/cadre-core/test/formation-stream-helpers.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, docs/architecture.md
----

## What shipped

Two roles form a strand: the **responder** (host being joined) and the **initiator** (joiner).
A single config value, `StrandFormationManagerConfig.provisionTimeoutMs`, used to be handed to
both — so the joiner could time out on the very message the host was sending to explain the
failure.

Now:

- `strand-formation-protocol.ts` exports `PROVISION_RESPONSE_TRAVEL_MARGIN_MS = 3_000`, and
  `DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS` is derived as
  `DEFAULT_PROVISION_TIMEOUT_MS + PROVISION_RESPONSE_TRAVEL_MARGIN_MS`.
- `StrandFormationManager.initiatorProvisionTimeoutMs()` derives the initiator's
  `await-response` budget as `configured + margin` (and leaves it `undefined` when the config
  is unset/`0`, so both roles keep their own independent defaults). `formStrand` passes that;
  the responder-side `FormationListener` still gets the raw configured value.
- **Added during review:** the same margin is now held back by the responder's *clamp*, so the
  two roles cannot collapse onto one number when the configured budget is too large for the
  session. See findings below.
- `docs/architecture.md` formation-timeout paragraph rewritten to describe the derivation and
  the per-role clamp ceilings.

## Review findings

### Checked

Read the implement diff (`9f1dd22..4375a87`) before the handoff summary. Aspects covered:
budget arithmetic across every regime (unset / `0` / small / large-unclamped / large-clamped),
single-responsibility of the new derivation helper, DRY across the three formation specs, type
safety, resource cleanup in the new in-memory stream doubles, error handling on the test
bridge, doc accuracy (`docs/architecture.md` is the only doc that documents these budgets —
verified by grepping `provisionTimeoutMs` across `docs/`, `packages/`, `integration-tests/`),
and whether any other package configures `provisionTimeoutMs` (none does).

### Major — none filed

The one real defect found (below) resolves at a single site in a file this ticket already
touches, in ~15 lines. Fixed inline rather than filed.

### Fixed in this pass

- **The clamp defeated the derivation (real defect, verified).** `resolveProvisionTimeoutMs`
  clamped any budget at or above `sessionTimeoutMs - stepTimeoutMs` down to exactly that
  number — for *both* roles. So with the default 30 s session / 5 s step, any configured
  `provisionTimeoutMs >= 25_000` clamped the responder AND the initiator to 25 000 ms, and the
  responder's clean "provisioning timed out" reply raced the initiator's own timeout again —
  the exact failure this ticket exists to remove, reachable purely through configuration.
  Fix: extracted `provisionCeilingMs(session, step, reserve)` and gave
  `resolveProvisionTimeoutMs` a `reserveMs` parameter (default `0`). `FormationListener` passes
  `PROVISION_RESPONSE_TRAVEL_MARGIN_MS`; `dialFormation` passes nothing. The reserve is capped
  at half the remaining room (mirroring `splitProvisionBudget`) so small session configs still
  spend most of their budget working rather than being squeezed to 1 ms.
  Regression test: `strand-formation-manager.spec.ts` → "keeps the responder ahead of the
  initiator even when BOTH budgets are clamped". Confirmed it *fails* without the fix —
  temporarily passing `0` as the reserve produced `Formation await-response timed out after
  1000ms` instead of the responder's `Formation rejected: Formation provisioning timed out`.
  This also closes the implementer's own flagged gap ("no test exercises a third value … to
  confirm the margin is strictly additive rather than accidentally clamped") — it was not
  merely untested, it was wrong.
- **DRY: test doubles duplicated three ways.** `MockStream` and `captureHandler` were copied
  verbatim in `strand-formation-protocol.spec.ts` and `strand-formation-consent.spec.ts`, and
  the new spec added a third `captureHandler` plus its own `QueueStream`/`makePair`/
  `bridgingDialer`. Extracted all of them into `packages/cadre-core/test/
  formation-stream-helpers.ts`; all three specs now import from it. The new spec dropped from
  222 to 129 lines; the two pre-existing specs each lost ~32 lines of copy. `captureHandler`'s
  `invoke` is now typed `(stream: ControlStream)` instead of `MockStream`/`unknown`.
- **Swallowed rejection on the test bridge.** `bridgingDialer` fired the responder handler with
  a bare `void invoke(...)`, so anything escaping the handler became an unattributed unhandled
  rejection. Now `.catch()`ed with a `console.error` naming the source.
- **Stale comments.** The two clamp tests in `strand-formation-protocol.spec.ts` asserted
  behaviour, not numbers, so they still pass — but their comments named the old ceilings
  (900 ms / 600 ms). Updated to the new ones (450 ms / 300 ms).

### Tripwires (recorded, not filed)

- `PROVISION_RESPONSE_TRAVEL_MARGIN_MS` is a fixed 3 s assumption about how long the result
  frame takes to travel back. Fine over the paths formation runs today; if it ever runs over a
  slow circuit relay or a congested mobile link where the frame can take longer, the margin is
  too thin and the race returns. Parked as a `NOTE:` comment on the constant in
  `strand-formation-protocol.ts`.

### Not found / explicitly clear

- **No other configuration site.** Nothing outside `cadre-core` sets `provisionTimeoutMs`, so
  the semantic change to that field (responder-only, initiator derived) breaks no caller.
- **No doc drift beyond the one paragraph.** `docs/strands.md`, `docs/cadre-host.md`, and
  `docs/cadre-consistency.md` never mention these budgets; only `docs/architecture.md` did, and
  it is updated.
- **Coverage of the remaining regimes is adequate without more tests.** Unset, `0`, a small
  explicit value, and the clamped regime are each covered; the large-but-unclamped case is the
  same one-line addition as the small case with no branch between them, so a fourth test would
  assert arithmetic already exercised.

## Verification

- `npx tsc --noEmit -p packages/cadre-core/tsconfig.json` — clean.
- `npx vitest run test/strand-formation-manager.spec.ts test/strand-formation-protocol.spec.ts
  test/strand-formation-consent.spec.ts` (from `packages/cadre-core`) — 3 files, **49 tests,
  all pass** (48 before + the new clamp regression).
- Full `yarn test` in `packages/cadre-core` — **85/87 files, 1397/1403 tests pass**, 1 skipped.
  The 5 failures are `control-revocation-reissue.spec.ts` (4) and
  `control-revocation-replay.spec.ts` (1), already listed in `tickets/.pre-existing-known.md`
  against the blocked ticket `10-revocation-reissue-same-pk-update-unique-collision` — not
  re-reported, not touched by this diff.
- `yarn lint` (repo root) — clean.
- The stale-build guard tripped mid-run because `../quereus` `src` was edited concurrently by
  something outside this ticket; cleared by rebuilding that workspace
  (`yarn workspace @quereus/quereus build`), which is the documented remedy. No source in that
  repo was modified from here.

## Known limits carried forward

The formation specs still exercise the native protocol only in-process, over the in-memory
`QueueStream` bridge — no real libp2p transport, no two-process hop. Unchanged from before this
ticket; real two-node coverage lives in `integration-tests`.
