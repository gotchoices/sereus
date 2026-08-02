description: When someone hand-configures how long strand formation may take, the same number is applied to both the joining side and the hosting side, so both give up at the same instant and the joiner sees a bare connection timeout instead of the clear reason the host was about to send.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts
difficulty: easy
----

## Resolution chosen

Plan ticket 26 named two options. Picking **derive the joiner's wait from the host's
budget with the travel margin added automatically** (one knob stays one knob, ordering
becomes structural) over the two-separate-settings alternative:

- The protocol layer (`strand-formation-protocol.ts`) already exercises two fully
  independent knobs — `FormationListenerOptions.provisionTimeoutMs` (host) and
  `FormationDialOptions.provisionTimeoutMs` (joiner) are separate interface fields on
  separate classes/functions, each independently clamped by `resolveProvisionTimeoutMs`.
  Nothing there needs to change.
- The bug lives ONLY in `StrandFormationManager`, which reads its single
  `StrandFormationManagerConfig.provisionTimeoutMs` and forwards the SAME number to both
  layers (`strand-formation-manager.ts:143` and `:211`).
- The default ladder already encodes the intended relationship as two constants 3 s apart
  (`DEFAULT_PROVISION_TIMEOUT_MS` = 12 000, `DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS` =
  15 000). Naming that gap and reusing it for the derived case keeps the override path
  consistent with the unconfigured default path, and needs no new validation/rejection
  logic — a mismatched pairing becomes structurally unreachable instead of merely
  detected.

## What to change

### `strand-formation-protocol.ts`

- Add a named, exported constant for the gap between the two defaults, e.g.:

  ```ts
  /**
   * Wire-latency margin (ms) added to the responder's provisioning budget to get the
   * initiator's await-response budget — the travel time for the result frame to come
   * back after the responder finishes (see {@link DEFAULT_PROVISION_TIMEOUT_MS}).
   * `StrandFormationManager` reuses this constant so a CONFIGURED budget preserves the
   * same margin the defaults do.
   */
  export const PROVISION_RESPONSE_TRAVEL_MARGIN_MS = 3_000;
  ```

- Rederive `DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS` from
  `DEFAULT_PROVISION_TIMEOUT_MS + PROVISION_RESPONSE_TRAVEL_MARGIN_MS` instead of the
  standalone literal `15_000`, so the two constants cannot drift apart silently.
- No other change needed here — `FormationListenerOptions`/`FormationDialOptions` stay as
  two independent `provisionTimeoutMs` fields; only the manager needs to stop conflating
  them.

### `strand-formation-manager.ts`

- Import `PROVISION_RESPONSE_TRAVEL_MARGIN_MS`.
- Add a small private helper (or inline in the constructor/`formStrand`) that derives the
  initiator-side budget from the configured host budget:

  ```ts
  private initiatorProvisionTimeoutMs(): number | undefined {
    const host = this.config.provisionTimeoutMs;
    return host && host > 0 ? host + PROVISION_RESPONSE_TRAVEL_MARGIN_MS : undefined;
  }
  ```

  (Mirrors `resolveProvisionTimeoutMs`'s own "`0`/negative means unset" rule so an unset
  config still lets both sides fall back to their own independent defaults — do NOT
  hardcode `DEFAULT_PROVISION_TIMEOUT_MS` here, that would defeat the per-role clamping
  `resolveProvisionTimeoutMs` already does downstream.)

- `FormationListener` construction (`~line 143`) keeps passing
  `this.config.provisionTimeoutMs` unchanged — the host's own configured/default budget.
- The `dialFormation` call inside `formStrand` (`~line 211`) switches from
  `provisionTimeoutMs: this.config.provisionTimeoutMs` to
  `provisionTimeoutMs: this.initiatorProvisionTimeoutMs()`.
- Update the `StrandFormationManagerConfig.provisionTimeoutMs` doc comment
  (`~line 66-72`): it currently claims one number governs "responder's `provisionStrand`
  hook call and initiator's `await-response` read" as if they were the same value — say
  instead that it sets the RESPONDER's provisioning work budget, and that the initiator's
  `await-response` wait is derived automatically (this value plus
  `PROVISION_RESPONSE_TRAVEL_MARGIN_MS`) so the ladder documented in
  `strand-formation-protocol.ts` cannot collapse.

## Tests to add

In `strand-formation-manager`'s test coverage (there is currently none dedicated to this
manager — `strand-formation-consent.spec.ts` and `strand-formation-protocol.spec.ts` cover
adjacent surface; add a new `strand-formation-manager.spec.ts` if no better home exists, or
extend `strand-formation-consent.spec.ts` if it already builds a `StrandFormationManager`
pair — check before creating a new file):

- Configure `StrandFormationManagerConfig.provisionTimeoutMs` to some value `N` and assert
  the resulting initiator wait budget is `N + PROVISION_RESPONSE_TRAVEL_MARGIN_MS` (strictly
  greater than `N`) — either via a direct unit check on the derivation helper/constant, or
  behaviorally: wire a `strandProvisioner`/`formationUsageRecorder` hook that sleeps for
  slightly longer than `N` but less than `N + PROVISION_RESPONSE_TRAVEL_MARGIN_MS`, run a
  real `formStrand` against a `FormationListener` built from the same manager, and assert
  the initiator receives the host's clean `'Formation provisioning timed out'` rejection
  reason (proving it was still listening when the host's frame arrived) rather than a
  generic dial/read timeout error.
- Leaving `provisionTimeoutMs` unset still yields the original independent defaults on each
  side (no regression on the default path).
- `provisionTimeoutMs: 0` behaves as unset on both sides (mirrors the protocol layer's own
  "0 means unset" test at `strand-formation-protocol.spec.ts:322`).

## Edge cases & interactions

- **Unset config**: must NOT be turned into e.g. `undefined + margin` → `NaN`. The helper
  above short-circuits to `undefined` when `host` is falsy/non-positive, exactly like
  `resolveProvisionTimeoutMs` does for the "unset" case.
- **Downstream clamping still applies per side**: the derived initiator value still passes
  through `resolveProvisionTimeoutMs` inside `dialFormation`, which will clamp it against
  THAT side's own `sessionTimeoutMs`/`stepTimeoutMs` if it would outlive the session — no
  change needed, just confirm the derived (margin-added) value doesn't itself trip that
  clamp in the common case (it won't, since `sessionTimeoutMs` default is 30 s and even
  `provisionTimeoutMs: 25_000 + 3_000` only clamps if session/step are also reconfigured
  small — that's the existing, unrelated clamp behavior, not a regression to chase here).
- **`maxConcurrentSessions` interaction**: raising `provisionTimeoutMs` still holds listener
  slots longer per the existing `DEFAULT_MAX_CONCURRENT_SESSIONS` NOTE in
  `strand-formation-protocol.ts` — unaffected by this change, no action needed.
- **Both config fields (`sessionTimeoutMs`, `stepTimeoutMs`) are still shared** between
  listener and dialer (unchanged, out of scope) — only `provisionTimeoutMs` was asymmetric
  by design and mismatched in practice.

## TODO

- Add `PROVISION_RESPONSE_TRAVEL_MARGIN_MS` export; rederive
  `DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS` from it.
- Add `initiatorProvisionTimeoutMs()` derivation in `StrandFormationManager`; wire it into
  the `dialFormation` call; leave the `FormationListener` call unchanged.
- Update the `StrandFormationManagerConfig.provisionTimeoutMs` doc comment to describe the
  derived relationship instead of a single shared number.
- Add/extend tests per "Tests to add" above.
- Run `yarn workspace @serfab/cadre-core test` (or the repo's equivalent scoped test
  command) and `yarn lint` before handoff.
