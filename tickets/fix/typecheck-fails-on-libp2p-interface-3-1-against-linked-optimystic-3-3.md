description: `yarn typecheck` fails in cadre-core, integration-tests, reference-app-web and reference-app-rn because the linked `../optimystic` now resolves @libp2p/interface 3.3.0 while this repo resolves 3.1.0, so TypeScript sees two different copies of every libp2p type. Move this repo's libp2p dependencies to the 3.3 line so both sides resolve the same @libp2p/interface version.
prereq:
files: package.json (resolutions), packages/cadre-core/package.json, packages/cadre-cli/package.json, packages/cadre-host/package.json, packages/cadre-provider/package.json, packages/cadre-rn/package.json, packages/integration-tests/package.json, packages/quereus-plugin-sereus/package.json, packages/reference-app-web/package.json, packages/reference-app-rn/package.json, packages/reference-app-ns/package.json, yarn.lock, tickets/blocked/adopt-optimystic-address-dial-timeout.md, .release-notes.pending.md
difficulty: medium
architecture: docs/testing.md
----
# Typecheck fails on @libp2p/interface 3.1 vs the linked optimystic's 3.3

## Failing gate

```
yarn workspace @serfab/cadre-core typecheck          # 36 errors (reproduced 2026-10-01)
yarn workspace @serfab/integration-tests typecheck   # 8
yarn workspace @serfab/reference-app-web typecheck   # 2 (and typecheck:e2e)
yarn workspace @serfab/reference-app-rn typecheck    # 6
```

Every error is TS2322 / TS2345 / TS2352, comparing a type from `sereus/node_modules/@libp2p/interface` (3.1.0) with the same type from `optimystic/packages/db-p2p/node_modules/@libp2p/interface` (3.3.0). Examples:

- `packages/cadre-core/src/cadre-node.ts(1670,5): Type 'OptimysticNode' is not assignable to type 'Libp2p<ServiceMap>'` … `…/optimystic/packages/db-p2p/node_modules/@libp2p/interface/dist/src/peer-id").PeerId' is not assignable to type '…/sereus/node_modules/@libp2p/interface/dist/src/peer-id").PeerId'`
- `packages/cadre-core/src/cadre-node.ts(1946,7)`: `ConnectionGater` from sereus's copy not assignable to db-p2p's copy.
- `packages/cadre-core/test/strand-solicitation.spec.ts(23,28)`: `noise()` factory `(components: NoiseComponents) => …` not assignable to `(components: Components) => ConnectionEncrypter<unknown>`.
- `packages/integration-tests/src/harness/node-fixtures.ts(40,11)`: `webSockets()` factory, same shape.

Runtime is unaffected: the cadre-core suite passed in full on the same tree.

## Root cause

optimystic `4d31f936` (`a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout`) moved every optimystic package to libp2p `^3.3.11` / `@libp2p/interface` `^3.3.0` (plus `multiformats` 14, `uint8arraylist` 3, `it-length-prefixed` 11), and each `../optimystic/packages/*/node_modules/@libp2p/interface` is now 3.3.0. This repo links those packages through root `resolutions` (`link:`), so `@optimystic/db-p2p`'s declarations resolve libp2p types from its own nested `node_modules`.

TypeScript treats two physical copies of a package as one only when their package name and version are identical. Before `4d31f936` both sides were 3.1.0, so the copies were merged. Now they differ, so every libp2p type that crosses the cadre-core / db-p2p boundary (`PeerId`, `Libp2p`, `ConnectionGater`, `Components`, transport and encrypter factories) fails to match.

So a published install, which deduplicates to a single 3.x, is not affected. The failure is the linked development workspace running a libp2p that lags behind the linked optimystic.

## Fix

Move this repo's libp2p family to the versions optimystic `4d31f936` resolves, so `node_modules/@libp2p/interface` is 3.3.0 (the current npm latest, and what optimystic's lockfile holds).

- `libp2p` → `^3.3.11`, `@libp2p/interface` → `^3.3.0`, and the other `@libp2p/*` ranges listed in the `files:` packages to at least the floors in `../optimystic/packages/db-p2p/package.json` at `4d31f936`.
- The two exact pins, `@libp2p/identify` `4.0.10` (cadre-core, integration-tests) and `@libp2p/webrtc` `6.0.14` (cadre-core, reference-app-web, reference-app-rn), are exact on purpose (integration-tests' identify pin matches cadre-core's, per `tickets/complete/2.2-strand-circuit-same-party-e2e.md`); find why cadre-core pinned them before moving them. Re-pin them to the versions that depend on `@libp2p/interface` 3.3.0, not to a range.
- After `yarn install`, check every nested copy: `find node_modules packages/*/node_modules -path '*@libp2p/interface/package.json'`. The lockfile already holds 3.2.2 (under `@achingbrain/nat-port-mapper`) and 3.2.3 (under `@libp2p/keychain` and `@libp2p/webrtc`). A nested copy matters only if its types reach an assignment that crosses packages, so typecheck decides; do not chase copies that typecheck accepts.
- Raising `@libp2p/interface` may also pull `multiformats` 14 / `uint8arraylist` 3 through libp2p. Any resulting `Uint8Array<ArrayBuffer>` vs `Uint8Array<ArrayBufferLike>` errors in this repo's own code are part of this fix.

This takes the "raise sereus's own `libp2p` range to ^3.3.11" half of `tickets/blocked/adopt-optimystic-address-dial-timeout.md`'s first TODO. Update that ticket to say that half is done. Raising the `@optimystic/*` floors stays blocked on the optimystic release.

## Design constraints

- **Sibling repos are read-only** (`tickets/rules/sibling-repos.md`). Do not edit, install into, or build `../optimystic`. In particular, do not "fix" this by pinning optimystic back to 3.1.
- **No type-identity workaround.** Do not add tsconfig `paths` aliases that force one `@libp2p/interface` copy, `as unknown as` casts at the boundary, or `skipLibCheck` changes. The two versions are different releases, and hiding the split in types would also hide that the process runs two libp2p versions at once.
- **Runtime validation depends on the sibling.** As of 2026-10-01 00:15 `../optimystic` has uncommitted edits to `packages/db-p2p/src/libp2p-node-base.ts`, so the stale-build guard refuses every suite that loads `@optimystic/db-p2p`. The typecheck can be fixed and verified regardless. The runtime suites (cadre-core, quereus-plugin-sereus, integration-tests) must pass on the new versions before this closes. If the guard still refuses when this ticket is worked, finish the dependency move and typecheck, then move the ticket to `blocked/` naming the sibling's in-flight edit.
- **RN.** `cadre-rn` ships native Noise crypto against libp2p's encrypter interface, and `reference-app-rn` bundles libp2p through Metro. Run `reference-app-rn`'s typecheck and its bundle check if one exists. A libp2p minor bump can change which subpath exports Metro resolves.

## Cross-cutting obligations

- `yarn check:dep-ranges` and `yarn dep-check` must pass, since floors move.
- Release note in `.release-notes.pending.md`: embedders now need libp2p ≥ 3.3.11 / `@libp2p/interface` ≥ 3.3.0.
- `check:published` resolves from the lockfile, so it moves with the lockfile and needs no separate change.
- No determinism edition, byte-format vector, golden fixture or migration is affected. libp2p is a transport and no wire format of this repo changes.

## TODO

- [ ] Raise the libp2p family ranges and the two exact pins; `yarn install`.
- [ ] `yarn typecheck` (all workspaces) at exit 0, including `reference-app-web typecheck:e2e`.
- [ ] `yarn lint`, `yarn check:dep-ranges`, `yarn dep-check`.
- [ ] cadre-core, quereus-plugin-sereus and integration-tests suites green on the new versions (or move to `blocked/` per the constraint above).
- [ ] Update `blocked/adopt-optimystic-address-dial-timeout.md` and add the release note.
- [ ] Remove this failure's line from `tickets/.pre-existing-known.md`.
