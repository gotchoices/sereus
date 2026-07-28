----
description: An app embedding our library reported that a user's very first node — the only node they have — freezes forever when it reads or writes its own settings database. The same setup works fine in this repo, because apps install an older copy of the underlying database engine than the one we develop and test against; ship the version we actually test, and add a test that fails loudly instead of hanging.
prereq:
files: packages/cadre-core/package.json, packages/cadre-cli/package.json, packages/quereus-plugin-sereus/package.json, packages/integration-tests/package.json, packages/reference-app-rn/package.json, packages/reference-app-web/package.json, packages/reference-app-ns/package.json, packages/cadre-core/test/control-database-genesis.spec.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, docs/STATUS.md
difficulty: medium
----

# Solo-node control DB: ship the substrate version we test, and cover the solo shape

## The report

An embedding application (Sereus Health, on `@serfab/cadre-core` 0.9.0) reported that a
**cadre of one** — the normal first-run state — cannot read or write its own control
database:

- `ControlDatabase.ensureOwnerKey(...)` never returns (they cap it at 20s and always hit the cap).
- Any control read (`select Key from CadreControl.OwnerKey`, `getOwnerKeys()`,
  `queryCadrePeers()`) never returns.

Their config is the mobile/browser shape: `controlNetwork.bootstrapNodes: []`,
`network.transports: [webSockets()]`, `network.listenAddrs: []` (no listen address at all),
`profile: 'transaction'`. Impact they describe: first run of every embedding app hangs
unless the app time-boxes each control call; owner genesis can't complete, so the seed/invite
flow to enroll the *first* drone never arms.

Their point of view is correct and worth stating as a requirement:

1. A cadre of one is a valid, common state; its single node is the whole membership and the
   sole authority over its own control data.
2. A node should not consult a network it knows is empty.
3. **A control operation must never hang indefinitely.** For a genuine partition (multi-node
   cadre, peers merely offline) the requirement is narrower — fail fast or serve a clearly
   local read — but never hang.

## What reproduction at HEAD showed

Their exact configuration was run against this repo at HEAD as a scratch
`packages/cadre-core/test` spec — solo node, WebSockets-only, `listenAddrs: []`,
transaction profile, hard 30s per-operation timeouts around `start()`,
`ensureOwnerKey()`, and `select Key from CadreControl.OwnerKey`:

```
Test Files  1 passed (1)      Tests  1 passed (1)      tests 156ms
```

**It does not reproduce here.** Genesis and the control read both complete in milliseconds.
The scratch spec was deleted; recreating it is the first TODO below.

## Why the reporter still hits it: we do not ship what we test

This repo resolves every `@optimystic/*` package to the **linked sibling workspace**
(root `package.json` → `resolutions` → `link:../optimystic/...`), currently at version
**0.16.2**. Every package's *declared* range is still:

| package | declared range |
|---|---|
| `cadre-core`, `cadre-cli`, `quereus-plugin-sereus`, `integration-tests`, `reference-app-{rn,web,ns}` | `@optimystic/*: ^0.14.1` |

A consumer installing `@serfab/cadre-core` 0.9.0 from the registry therefore gets an
`0.14.x` substrate — two minor versions behind the one every test in this repo runs against,
and behind the optimystic work that landed since (cross-network cohort/coordinator hardening,
promise-phase retry, unique enforcement, and the coordinator/cluster changes around solo and
undersized clusters). **Nothing in this repo exercises the version consumers actually
install**, so a solo-path regression on the published floor is invisible here. That gap is
the defect this ticket fixes; the reported hang is its first casualty.

`@quereus/quereus` is *not* affected — declared `^4.4.0`, linked workspace is 4.4.1.

## Knobs to know if a solo hang ever resurfaces

Recorded so the next investigator does not re-derive them — do **not** change these
speculatively as part of this ticket:

- `control-database.ts` hardcodes the network transactor for all `CadreControl` tables
  (`default_transactor: 'network'` ~L186, `setDefaultVtabArgs({ transactor: 'network' })` ~L223).
  Strands have a public alternative — `composeStrand`'s `mode: 'bootstrap'` resolves to the
  **local** transactor (`packages/quereus-plugin-sereus/src/compose-strand.ts` ~L142-151) —
  the control database has no analog.
- `cadre-node.ts` ~L643 passes `clusterSize: 3` and `clusterPolicy` for the control node but
  never sets optimystic's `allowUnvalidatedSmallCluster`, whose own comment in
  `../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts` (~L420-425) says callers
  opt in for "single-node/local dev knowingly running below the floor". Default is fail-closed.
- optimystic's `coordinator-repo.ts` `fetchBlockFromCluster` already has a solo short-circuit
  ("on nodes without listen addresses (e.g. solo WebSocket-only) the dial can hang") — the
  exact shape reported. It is present in 0.14.1 as well, so it alone does not explain the report.

## Edge cases & interactions

- **Timeouts, not hangs, in tests.** The regression test must wrap each operation in an
  explicit timeout that *fails* the test — a plain `await` turns a regression into a CI
  timeout with no diagnosis.
- **Both profiles.** `transaction` (mobile) and `storage` (server) take different FRET/ring
  paths; cover both solo.
- **Write after genesis.** Genesis is a special bootstrap branch; also exercise a normal
  solo write (e.g. `registerSelf`) plus a read-back, which is what a real first-run app does.
- **Second run.** Restart the node on the same storage and re-read — a warm-restart solo read
  goes through the catalog hydrate path, not the fresh-schema path.
- **No listen address at all.** `listenAddrs: []` is the RN/browser default in
  `types.ts` (~L162); the existing `control-database-genesis.spec.ts` uses the default TCP
  listen addrs, which is why it never covered this shape.
- **API drift on bump.** 0.14 → 0.16 spans breaking-shaped changes (cluster config,
  transactor options, schema/unique enforcement). Expect type errors and fix them in this
  ticket rather than pinning back.
- **Reference apps** carry their own ranges; bump together or a consumer app resolves two
  copies of `@optimystic/db-p2p` (the same duplicate-copy failure mode as
  `reference-app-web-libp2p-interface-dedup`).

## TODO

- Bump every declared `@optimystic/*` range to the version the workspace actually links
  (`^0.16.2`) across all seven packages listed in `files:`; keep `resolutions` as-is.
- `yarn install`, then `yarn build` + `yarn lint` + package test suites; fix any API drift
  surfaced by the newer substrate rather than reverting the bump.
- Add a permanent solo regression spec in `packages/cadre-core/test` (suggested name
  `control-database-solo.spec.ts`) covering: WebSockets-only transport, `listenAddrs: []`,
  `bootstrapNodes: []`; genesis → read-back → a solo write → read-back; per-operation
  timeout guards that fail the test; both `transaction` and `storage` profiles; and one
  restart-and-read case.
- Extend or annotate `control-database-genesis.spec.ts` to say it covers the *listening* solo
  shape, so the two specs read as a matched pair rather than duplicates.
- Check the reporter's secondary claim that the reference apps route *around* the solo path
  rather than supporting it: `reference-app-rn` `src/cadre-phone.ts` `startPhoneNode` awaits
  `runAuthorityGenesis` with no timeout and the app's Settings screen expects a bootstrap
  drone multiaddr; `reference-app-web` wraps `queryCadrePeers()` in a `try/catch` that catches
  errors but not a hang. With the bumped floor, boot each solo (no bootstrap addr) and confirm
  it completes; if either still needs a guard, fix it here or file it.
- Record in `docs/STATUS.md` that solo (cadre-of-one) control read/write is a covered,
  supported configuration, and note the declared-range-vs-linked-workspace rule.
- Report back to the reporting app: state which published `@serfab/cadre-core` version carries
  the bumped floor, and ask them to drop their time-boxing workaround and confirm.
