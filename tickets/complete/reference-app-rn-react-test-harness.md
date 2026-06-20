description: A React test harness now exercises how the RN reference app's background lifecycle controller is wired into React, so cold-start recovery and connection-status behavior are covered by automated tests instead of only type-checking.
files: packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/test/react/setup.ts, packages/reference-app-rn/test/connection-status.spec.ts, packages/reference-app-rn/src/connection-status.ts, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/package.json, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/background-runner.ts

# Complete: React test harness for `useCadreInternal` ↔ `BackgroundRunner` wiring

## What was built

`packages/reference-app-rn` gained a second vitest project (`react`) alongside the existing
plain-node one, so the hook that wires the `BackgroundRunner` into React (`use-cadre.ts`) is now
exercised at runtime rather than only type-checked:

- **`vitest.config.ts`** — single config replaced with `test.projects` (`node` excludes `test/react/**`;
  `react` runs `test/react/**` in a node environment with `test/react/setup.ts` setting
  `IS_REACT_ACT_ENVIRONMENT`).
- **`react-test-renderer@19.0.0` + `@types/react-test-renderer`** added as devDeps (exact match to
  pinned `react@19.0.0`; no DOM/jsdom).
- **`src/connection-status.ts`** (new) — pure `connectionBanner(...)` derivation extracted from
  `app/index.tsx` (behavior-preserving), enabling status-bar assertions without rendering the RN screen.
- **`test/react/use-cadre.spec.ts`** — mounts the real hook with `react-test-renderer`, mocking only
  the RN/expo/libp2p-pulling modules; drives the real runner via a fake `AppState` + mock node.

## Review findings

Adversarial pass over commit `fb5c94c`. Stage: review → complete.

### Checked — refactor fidelity (`connection-status.ts` vs. pre-refactor `app/index.tsx`)
Diffed every branch of the extracted `connectionBanner` against the original inline ternaries:
- **Color**: `resuming`→`#ff9800`, `degraded`→`#f44336`, then `status` switch
  (`connected`→`#4caf50`, `connecting`→`#ff9800`, `error`→`#f44336`, default→`#666`). Matches.
- **Text**: `resuming`/`degraded` strings, then `connected` count interpolation, `connecting`, and the
  default (`idle`/`error`) `error ?? 'Not connected — go to Settings'` fall-through. Matches, including
  `error`-status falling to the same default branch as the original.
- **No other consumers**: the diff confirms `index.tsx` was the only site holding this logic.
**Finding: none.** The extraction is behavior-preserving and `app/index.tsx` now consumes it correctly.

### Found + fixed (minor) — pure function had no direct test
The whole point of the refactor — the pure `connectionBanner` — was only exercised for the `resuming`
and `degraded` branches (indirectly, via the hook test). The `connected` (with strand/member count
interpolation), `connecting`, `idle`, and `error` branches plus precedence ordering had **no direct
coverage**, leaving the "behavior-preserving" claim unguarded against future edits.
**Fix:** added `test/connection-status.spec.ts` (node project — safe, `connection-status.ts` imports
only a `type` from `use-cadre`, erased at runtime) with 9 cases covering all status branches, the
connected-state count formatting, the error-message-vs-hint fall-through, and
`resuming > degraded > status` precedence.

### Checked — hook ↔ runner wiring tests (`test/react/use-cadre.spec.ts`)
Read each assertion against the real `use-cadre.ts` and `background-runner.ts`:
- runner created on node-start / torn down on unmount (via AppState add/remove + node listener counts);
- background → `hibernateAll()` once → `background-connected`;
- cold-start re-sync (OS-kill, foreground return re-runs `startPhoneNode`, `node`-dep change recreates
  the runner, `peerId` `peer-1`→`peer-2`, `resuming` converges to `false`);
- degraded resume (control never reconnects, fake-timer 15s settle) reaching the real `connectionBanner`;
- `stop()` dropping the node and unsubscribing.
The epoch-guarded recreate-mid-resume path (old runner `stop()` bumps epoch → its in-flight
`handleForeground` bails after the `ensureNode` await) is sound and the addCount/removeCount assertions
hold. **Finding: none.**

### Checked — warm-node latent edge (documented, not fixed)
The handoff flagged: a node singleton already running at mount with `start()` never called this session
leaves `optsRef` null, so a later cold-start can't recover a killed node. Verified the "dev-only"
claim: `CadreProvider` (which calls `useCadreInternal`) is mounted once at the Expo Router root
(`app/_layout.tsx`) and only unmounts on full app teardown — which tears down the JS context and nulls
the module singleton. The only way a live singleton survives a provider remount is dev Fast Refresh;
a production fresh JS context always starts null, so `start()` runs first and populates `optsRef`.
**Finding: confirmed dev-only.** Per repo guidance (avoid speculative complexity; no backwards-compat
focus yet) the documented + pinned (`documents: a warm node at mount …`) disposition is correct.
**No fix ticket filed.**

### Not covered here (out of scope — noted for a possible follow-up)
Consistent with the implement handoff: `applySeed`, `authorityKeysFromInvite`, `dialPeer`,
`createStrand`, the closed-strand consent flow, and the `strand:discovered` auto-join effect are not
exercised (the runner/lifecycle wiring was this ticket's scope; `chat-strand` is mocked). The mock node
is a thin stub — no real `CadreNode`/control network/strand sync. `react-test-renderer` is deprecated
in React 19 (prints a one-line console warning on import; tests pass). None of these are regressions or
blockers; broader hook coverage and a possible `@testing-library/react-native` migration are candidate
future work, not findings against this change.

## Validation (all green)

```
cd packages/reference-app-rn
yarn vitest run         # 99 tests, 6 files
yarn typecheck          # exit 0
# root
yarn lint               # exit 0
```
