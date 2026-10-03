description: The shared React Native kit now carries the reference app's background/foreground handling, so every Sereus phone app can hibernate its strands in the background and resume cleanly, which sereus-chat and health do not do today.
prereq: rn-kit-phone-node
architecture: docs/architecture.md
files: packages/cadre-rn/src/lifecycle/, packages/cadre-rn/test/lifecycle/, packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/app-state.ts, docs/architecture.md, docs/reference-app-rn.md
----
# Lifecycle runner (`@serfab/cadre-rn/lifecycle`)

Third of the kit's bring-up tickets, after `rn-kit-key-store` and `rn-kit-phone-node`. The reference
app's lifecycle runner was already kit-shaped: `AppStateLike` injected, nothing native imported.
Neither sereus-chat nor health has any AppState handling.

## What landed

- `src/background-runner.ts` moved to `packages/cadre-rn/src/lifecycle/background-runner.ts`,
  exported as `@serfab/cadre-rn/lifecycle`. The behaviour and API are unchanged; only the header and
  doc comments that named the reference app's files changed. Its spec moved with it (13 cases).
- **`phoneNodeLifecycle(phone)`** supplies the runner's two node hooks from a `PhoneNode`:
  `getNode` is `phone.node`, and `ensureNode` starts again from `loadSavedStart()` only while
  `autoStart` is set, so a node the user stopped stays stopped. It has its own spec (3 cases).
- **The reference app** imports the runner from the kit:
  - `src/app-state.ts` now returns react-native's `AppState` itself. That proves by typecheck the
    README's claim that `AppState` is assignable to `AppStateLike`.
  - The file stays as the seam `use-cadre.ts`'s spec fakes.
  - The app keeps its own `ensureNode`, because it also refreshes its React state from the new node.
- **Docs:** the kit README has a "Lifecycle" section. `docs/architecture.md` and
  `docs/reference-app-rn.md` point at the kit.

## Changed from the plan

The plan (in `rn-kit-phone-node`) had the runner take the `PhoneNode` in place of `getNode` and
`ensureNode`. The runner keeps those two hooks instead, and `phoneNodeLifecycle` builds them from a
`PhoneNode`, for two reasons:
- an app's cold start may need to do more than start the node (the reference app refreshes its React
  state);
- the runner and its spec move unchanged.

## Verification

Checked on master at v1.11.0, rebased on `rn-kit-phone-node`, with optimystic v1.9.0 and quereus
v4.20.0 linked:
- `cadre-rn`: `typecheck` clean, 157 tests pass.
- `reference-app-rn`: `typecheck` clean, 168 tests pass. The 13 runner cases moved to the kit.
- Repo-wide: `yarn lint` exit 0; the dep-range, both typecheck-coverage and the stale-build-guard
  wiring checks pass; knip reports nothing new.

**Not run:** an Expo device build of the reference app.
