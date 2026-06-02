----
description: Wire the now-implemented CadreNode.registerSelf() into the real authority entry point (CLI --authority) so the authority node writes its own CadrePeer row at startup (not only on the eventual TTL heartbeat), and fix the in-process tests/docs that assumed the authority is absent from CadrePeer.
prereq: peer-record-resolution-layer
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts, packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/src/cadre-node.ts, docs/architecture.md, docs/cadre-host.md
----

## Status — substantially landed by `peer-record-resolution-layer`

**Most of this ticket's original deliverable already shipped** (commit
`ticket(implement): peer-record-resolution-layer`). Do NOT re-implement those
parts; re-scoped to the genuinely-remaining wiring/test/doc work.

Already done there (verify, don't redo):
- `CadreNode.registerSelf()` is now **public, awaitable, idempotent** — it builds
  a signed `PeerAddressRecord` and either authority-INSERTs (own-authority node)
  or self-UPDATEs an existing row. The no-op stub / commented-out insert is gone.
- The `CadrePeer` schema gained `PublicKey`/`UpdatedAt`/`Sig`; the
  `SeedBootstrapService` insert path is rewritten (`authorizePeer`,
  `insertSelfPeerRecord`, shared `insertCadrePeerRow`).
- `scheduleSelfRegistration()` was **kept, not deleted** — but hardened to a
  background timer that safely no-ops when it cannot yet sign/insert, plus a
  `self:peer:update` listener and a TTL heartbeat (`registerSelf` on address
  change + every ~7.5 min). **Do NOT delete this timer** (the original ticket
  asked to remove it; that instruction is superseded — the refresh path now
  depends on it). The remaining problem is only the *first insert* latency below.

## Remaining problem to fix

The authority installs its key *after* `start()` (CLI `initializeSeedBootstrap`),
so the 1s `scheduleSelfRegistration` timer fires before an authority-signed
INSERT is possible; the row therefore isn't written until the ~7.5 min heartbeat.
During that window `createSeed()` omits the authority peer, so a receiving
node's `applySeed()` signer-is-authority gate (`seed.peers.some(p =>
p.isAuthority && p.publicKey === seed.signerKey)`) fails with
`Signer key does not match any authority peer`.

The clean fix is an **explicit `await node.registerSelf()` in the CLI
`--authority` branch, after `initializeSeedBootstrap`** — the row exists before
any seed is minted; the background heartbeat then keeps it fresh.

## TODO

- [ ] In `packages/cadre-cli/src/commands/start.ts`, after
      `node.initializeSeedBootstrap(privateKeyB64)`, `await node.registerSelf()`
      and log insert-vs-refresh outcome. (cadre-host spawns `cadre start
      --authority`, so this covers it too.)
- [ ] Update `packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts`
      to call `await host.registerSelf()` after `initializeSeedBootstrap` and fix
      member-count assertions — the host's own peerId now appears in `CadrePeer`
      (inverts the old "does NOT appear" expectation from
      `tickets/complete/cadre-host-trust-circle-e2e-verification.md`).
- [ ] Same for `packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts`.
- [ ] Confirm `packages/cadre-core/test/seed-bootstrap.spec.ts` peer-count
      assertions still hold (those call `authorizePeer` directly, not
      `registerSelf`; should be unaffected — verify).
- [ ] Add a focused cadre-core test: before `registerSelf()` the authority is
      absent from `createSeed().peers`; after, it is present with
      `isAuthority === true && publicKey === signerKey`, and a second node's
      `applySeed` passes the signer-is-authority gate.
- [ ] Update `docs/architecture.md` / `docs/cadre-host.md` where they describe
      `CadrePeer` membership to note the authority self-registers (so seeds
      include the authority peer).
- [ ] `yarn test` + `tsc -p tsconfig.build.json --noEmit` in cadre-core,
      cadre-cli, cadre-host; stream with `… 2>&1 | tee`. Pre-existing-failure flow
      if unrelated breakage surfaces.
