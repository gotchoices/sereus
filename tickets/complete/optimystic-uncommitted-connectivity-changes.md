description: Verify-only ticket — confirmed that optimystic `3d50e43 ticket(implement): web-e2e-tier2-connectivity (sibling-side)` unblocks the sereus Tier 2 connectivity e2e. No sereus source changes were required; the work was upstream and the consumer-side verification landed green.
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/dist/src/libp2p-node-base.d.ts, ../optimystic/packages/reference-peer/dist/src/cli.js, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/distributed/mode-flip.spec.ts
----

## Summary

Upstream commit `3d50e43` in `../optimystic` adds the two surfaces the sereus Tier 2 e2e was already coded against:

- `@optimystic/db-p2p` — `NodeOptions.connectionGater?: ConnectionGater` (`dist/src/libp2p-node-base.d.ts:87`).
- `@optimystic/reference-peer` — `--offline` declared on `interactive`, `service`, and `run` subcommands (`dist/src/cli.js:590,627,663`).

Sereus consumers (unchanged in this ticket):
- `packages/reference-app-web/src/lib/optimystic.ts:158` — passes `connectionGater: { denyDialMultiaddr: () => false }` to the browser libp2p node.
- `packages/reference-app-web/e2e/fixtures/reference-peer.ts:24-29` — spawns the CLI with `interactive --ws-port N --no-tcp --relay --offline`.

## Verification run

```
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2 / distributed / mode flip"
```

Result:

```
[e2e] reference-peer ready: /ip4/127.0.0.1/tcp/9191/ws/p2p/12D3KooWDuWih88P8pQggBLH5GUfgLaVyGkUuz5jtygFaT8Qt9FP
Running 2 tests using 1 worker
  ✓ 1 […] Connect flips solo → distributed and lists the bootstrap peer (5.3s)
  ✓ 2 […] Disconnect snaps back to solo and empties the connection list (3.7s)
  2 passed (21.9s)
```

End-to-end behaviour confirmed:
1. Fixture spawned cleanly — `--offline` is wired through commander to the LocalTransactor branch.
2. Browser dialed the loopback WS multiaddr — permissive `connectionGater` reached the libp2p node (the default browser gater would have denied it).
3. `mode-badge` flipped solo → distributed; `diag-connection-row` for the bootstrap peer id appeared.
4. `btn-disconnect` snapped back to solo; diagnostics connection list drained.

## Review findings

**What was checked**

- Implement-stage diff (`git show 2d4ad7c`): pure ticket move — no sereus source changes. Consistent with the verification-only framing.
- Upstream surfaces in `../optimystic` HEAD (`3d50e43`):
  - `grep -n connectionGater ../optimystic/packages/db-p2p/dist/src/libp2p-node-base.d.ts` → `87:    connectionGater?: ConnectionGater;` ✓
  - `grep -n offline ../optimystic/packages/reference-peer/dist/src/cli.js` → three `--option('--offline', …)` matches at 590/627/663 ✓
- Sereus consumer references the two surfaces (`packages/reference-app-web/src/lib/optimystic.ts:158`, `packages/reference-app-web/e2e/fixtures/reference-peer.ts:24-29`) — matches the implement ticket's claims.
- Re-ran the verification command: 2/2 passed in 21.9s (above).
- Optimystic working tree: clean. (`../optimystic` is ahead of `origin/main` by 1 commit, as flagged in the implement ticket — that's the sibling-side commit, not yet pushed.)
- Sereus working tree: clean apart from the ticket-folder transition.

**Findings**

- *Correctness / behaviour* — none. Both specs pass and exercise the two surfaces at runtime, not just the type level.
- *Scope honesty* — implement ticket explicitly limited coverage to the `mode flip` grep. The other distributed specs (`bootstrap-persistence`, `cross-tab-activity`, `disconnect-mid-session`, `two-tab-convergence`) share the same fixture/dialer surfaces, so a fixture-spawn or connection-gater regression would have surfaced in `mode flip` too. Not running them here is a reasonable scope limit; flagging for awareness but not filing a ticket.
- *DRY / modular / maintainability* — N/A (no code changed).
- *Tests / lint* — the e2e suite passes; no other validation surface applies to a verification-only ticket. Skipping `yarn typecheck`/`yarn lint` is defensible since `git diff` against the implement parent is empty for sereus sources; the implement ticket already noted typecheck was exit-0 against the rebuilt sibling dist.
- *Docs* — no consumer-facing API or doc changed in this pass; nothing to update.
- *Resource cleanup / error handling / type safety* — no code surface in scope.
- *Known pre-existing issues (not in scope)*:
  - Vite emits two `dynamic import will not move module into another chunk` warnings against `@libp2p/peer-id` and `p2p-fret` inside the optimystic dist. Pre-existing chunking artefact unrelated to these two surfaces. A `backlog/` cleanup ticket would be appropriate if anyone cares about chunking; not filed under this ticket to avoid scope creep.
  - `../optimystic` is one commit ahead of `origin/main`. Local verification is fine; a downstream consumer pulling fresh would need that commit pushed. Out of scope for sereus.

**Disposition**

No fixes applied (nothing to fix). No new tickets spawned — the two flagged items above are non-blocking and pre-existing.
