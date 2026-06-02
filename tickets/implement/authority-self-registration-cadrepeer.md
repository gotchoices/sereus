----
description: Replace the no-op registerSelf stub with real authority self-registration — a running authority node signs and persists its own PeerId/Multiaddr into CadrePeer — and remove the misleading 1s scheduled timer.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts, packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts, packages/cadre-core/test/seed-bootstrap.spec.ts
----

## Problem (confirmed by inspection)

`CadreNode.start()` schedules `scheduleSelfRegistration()` on a 1s `setTimeout`
(`packages/cadre-core/src/cadre-node.ts:214-215, 322-333`). The scheduled
`registerSelf()` (`:339-368`) gathers `peerId`/`multiaddrs`, logs intent, then
logs `Self-registration requires authorization - skipping for now` and returns
— the real insert is commented out. Net effect: misleading dead work that
implies self-registration happens when it does not, and **no running node ever
writes its own row into `CadrePeer`**.

Worse, the timer fires ~1s after `start()`, which is *before* the authority key
even exists: the CLI inserts the authority key and calls
`initializeSeedBootstrap()` only *after* `start()` returns
(`packages/cadre-cli/src/commands/start.ts:209-226`). So even if the stub did
insert, it would have no authority context to sign with at that point.

### Downstream consequences (the reason this matters)

- `SeedBootstrapService.queryPeers()` (`seed-bootstrap.ts:451-482`) builds the
  seed peer list from `CadrePeer` rows and marks the row whose `PeerId` equals
  the local node's peerId as `isAuthority` (attaching `authorityPublicKey`). If
  the authority never has a `CadrePeer` row, `createSeed()` emits a seed whose
  peer list omits the authority itself.
- `applySeed()` on a receiving node (`seed-bootstrap.ts:268-274`) gates on
  `seed.peers.some(p => p.isAuthority && p.publicKey === seed.signerKey)`. With
  the authority absent from the peer list, this gate fails → `Signer key does
  not match any authority peer`.
- Strand-cohort bootstrap (`tickets/plan/bootstrap-dht-discovery-and-strand-cohort-wiring`)
  reads `CadrePeer` for cohort seeding; with no rows there is no source.

## Why the path is now implementable

The signing primitives already exist and are exercised by `authorizePeer`:

- `SeedBootstrapService.authorizePeer({ peerId, multiaddrs })`
  (`seed-bootstrap.ts:130-166`) signs `digest(peerId, 'sha256', 'utf8',
  'base64url')` with the authority private key and inserts into `CadrePeer`
  with `with context AuthorityKey = …, Signature = …`. This satisfies the
  `AuthorizedInsert` constraint (`control-database.ts:65-68`), which verifies
  `digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8')` against an
  authority key. **Self-registration is just `authorizePeer` called with the
  node's own peerId/multiaddrs.**
- For the restart case (row already present), the same single authority
  signature over `digest(new.PeerId, 'sha256', 'utf8')` also satisfies the
  *authority branch* of `AuthorizedUpdate` (`control-database.ts:73-74`) — so a
  plain authority-signed `update` of `Multiaddr` refreshes a stale row without
  needing the peer's own key.
- `CadreNode.resolveInviteAddresses()` (`cadre-node.ts:641-649`) already yields
  the best dialable address set (pushed NAT-resolved addrs → config resolver →
  `getMultiaddrs()`). That is the correct multiaddr set to persist for self, so
  the authority advertises a dialable address in the seeds it mints.

The own-peer-key `AuthorizedUpdate` branch (a *non-authority* peer refreshing
its own Multiaddr with its own key) is **out of scope here** and tracked
separately in `tickets/backlog/peer-self-update-own-multiaddr.md` — it carries
an unverified assumption about `verify(…, new.PeerId, 'ed25519')` accepting a
base58btc PeerId as the key.

## Design

Replace the timer-driven no-op with an explicit, awaitable, authority-gated
self-registration, wired at the real authority entry points.

```
CadreNode.registerSelf(): Promise<void>      // public, awaitable, idempotent
  - require controlNode + an authority-capable seedBootstrapService
    (one created via initializeSeedBootstrap, i.e. has an authority key);
    if absent, log and return (non-authority drones cannot self-INSERT — that
    is the backlog ticket's concern), do NOT throw on the seed-listener path.
  - peerId   = controlNode.peerId.toString()
  - addrs    = await resolveInviteAddresses()
  - if already a member (listMembers / isMember on own peerId):
       authority-signed UPDATE of Multiaddr to the current addrs (refresh)
    else:
       seedBootstrapService.authorizePeer({ peerId, multiaddrs: addrs })  // INSERT
```

The insert/refresh should be tolerant of empty `addrs` (authorizePeer already
stores `''` when no addrs — `CadrePeer.Multiaddr` is NOT NULL).

Prefer keeping the actual signing/DML inside `SeedBootstrapService` (it owns the
authority key and the `CadrePeer` SQL). A small `SeedBootstrapService.registerSelf(addrs: string[])`
that reuses the `authorizePeer` signing path (and an authority-signed update for
the refresh case) keeps `CadreNode` thin and DRY. `CadreNode.registerSelf()`
then just resolves addresses and delegates.

### Wiring

- **CLI `--authority` (production path, also covers cadre-host which spawns
  `cadre start --authority`):** in `packages/cadre-cli/src/commands/start.ts`,
  after `node.initializeSeedBootstrap(privateKeyB64)` (`:224`), `await
  node.registerSelf()` and log the outcome.
- **Remove the dead scheduling:** delete `scheduleSelfRegistration()` and its
  call in `start()` (`cadre-node.ts:214-215, 322-333`) and the old no-op private
  `registerSelf()` (`:339-368`). Do **not** leave a background timer.

### Idempotency / restart

The control DB is networked/persistent, so on restart the own row may already
exist. `registerSelf` must not throw on a duplicate PK — probe membership first
(`isMember(ownPeerId)`) and branch insert-vs-update. Avoid `insert or replace`:
a replace may internally delete, and `CadrePeer` DELETE currently hits the
upstream `quereus-cadrepeer-delete-no-row-context` bug. A plain authority-signed
`update … set Multiaddr = ?` on the existing row uses the `on update` constraint
and sidesteps that.

## Test impact (must update — flagged in the source ticket)

These in-process tests stand up an authority `CadreNode` and previously assumed
the host's own peerId is absent from `CadrePeer`. Once those tests exercise
`registerSelf()`, the authority's own row appears and member counts grow by one.

- `packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts` —
  after `host.initializeSeedBootstrap(...)` (`:60`) add `await
  host.registerSelf()` so the test mirrors production, then update assertions:
  `snap.members` now includes the host peer plus the redeemed phone (was
  `toHaveLength(1)` at `:98`). Assert the host's own peerId is now present in
  `CadrePeer` (inverts the old "does NOT appear" expectation called out in
  `tickets/complete/cadre-host-trust-circle-e2e-verification.md`).
- `packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts`
  — same in-process authority setup (`:35-39`); add `await
  cadreNode.registerSelf()` and adjust any member-count assertions in the
  issue→list→redeem→list→remove cycle.
- `packages/cadre-core/test/seed-bootstrap.spec.ts` — the existing
  `authorizePeer/removePeer` round-trip and any seed peer-count assertions
  (e.g. `message.peers` / `peer.multiaddrs` lengths around `:196-253`) are
  computed from `CadrePeer`; verify none of them now self-register
  unexpectedly. These tests call `authorizePeer` directly, not `registerSelf`,
  so they should be unaffected — confirm by running them.
- `packages/cadre-core/test/invite-address-push.spec.ts` — calls
  `initializeSeedBootstrap` but not `registerSelf`; should be unaffected.
  Confirm.

Keeping `registerSelf()` an explicit awaitable method (rather than firing it
automatically inside `initializeSeedBootstrap`) is deliberate:
`initializeSeedBootstrap` is called by ~6 call sites including isolated unit
tests with no live network, and making it async-with-a-DB-write would churn all
of them and surprise its "initialize" contract.

## Verification / reproducing assertion

Add a focused test (cadre-core) that reproduces the bug and proves the fix,
using the in-process authority pattern from `seed-bootstrap.spec.ts`
(`start()` → `insertAuthorityKey` → `initializeSeedBootstrap`):

- Before `registerSelf()`: `await node.listMembers()` is empty, and
  `await service.createSeed()` returns a seed whose `peers` does **not** contain
  the node's own peerId (and thus no `isAuthority` peer).
- After `await node.registerSelf()`: `listMembers()` contains the own peerId;
  `createSeed()` includes a peer with `isAuthority === true` and `publicKey ===
  signerKey`; a second node's `applySeed(seed)` passes the signer-is-authority
  gate (no longer `Signer key does not match any authority peer`).
- Calling `registerSelf()` twice does not throw (idempotent refresh).

## TODO

- [ ] Add `SeedBootstrapService.registerSelf(addrs: string[])` (or equivalent)
      reusing the `authorizePeer` signing path for INSERT and an authority-signed
      `update Multiaddr` for the already-present refresh case; tolerate empty addrs.
- [ ] Add public awaitable `CadreNode.registerSelf(): Promise<void>` that requires
      an authority-capable seedBootstrapService, resolves addrs via
      `resolveInviteAddresses()`, probes `isMember(ownPeerId)`, and delegates.
- [ ] Delete `scheduleSelfRegistration()`, its call in `start()`, and the old
      no-op private `registerSelf()`; no background timer remains.
- [ ] Wire `await node.registerSelf()` into the CLI `--authority` branch in
      `start.ts` after `initializeSeedBootstrap`, with a log line on insert vs refresh.
- [ ] Update `trust-circle-integration.test.ts` and the integration-tests
      `cadre-host-trust-circle.integration.ts` to call `registerSelf()` and fix
      member-count / "own peer present" assertions.
- [ ] Add the reproducing/verification test described above.
- [ ] Run `yarn test` and `tsc -p tsconfig.build.json --noEmit` in `cadre-core`,
      `cadre-cli`, and `cadre-host`; stream output with `… 2>&1 | tee`. Fix
      fallout. If a failure is plainly pre-existing/unrelated, follow the
      `tickets/.pre-existing-error.md` flow.
- [ ] Update `docs/architecture.md` / `docs/cadre-host.md` where they describe
      cadre membership / `CadrePeer` population to reflect that the authority now
      self-registers (and seeds therefore include the authority peer).
