description: Browser libp2p can now dial the local reference-peer fixture — 3/6 Tier 2 specs green (mode-flip × 2, bootstrap-persistence); the remaining 3 data-convergence specs and the upstream packaging gap were spun off to follow-ups.
files: ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/README.md
----

## What landed

### Upstream (optimystic) — uncommitted on sibling tree, see follow-up

- `packages/reference-peer/src/cli.ts` — added `.option('--offline', 'Run as single-node LocalTransactor (no distributed consensus)')` to `interactive`, `service`, and `run`. Camel-case mapping lands the flag on the already-typed `options.offline` field; no other code paths needed.
- `packages/db-p2p/src/libp2p-node-base.ts` — added optional `connectionGater?: ConnectionGater` to `NodeOptions`, threaded into the libp2p config via `...(options.connectionGater ? { connectionGater: options.connectionGater } : {})`. Without a caller-supplied gater libp2p still uses its platform default; existing call sites are unaffected.

### This repo (sereus)

- `packages/reference-app-web/src/lib/optimystic.ts:158` — passes `connectionGater: { denyDialMultiaddr: () => false }` in the browser libp2p config. This was the **actual** blocker: libp2p's `connection-gater.browser.js` default rejects (a) insecure `ws://` and (b) private/loopback addresses; the fixture multiaddr `/ip4/127.0.0.1/.../ws/...` hit both.
- `packages/reference-app-web/e2e/fixtures/reference-peer.ts` — `--offline` added to the spawn argv (after `--relay`); multi-line stale JSDoc replaced with a single-line description.
- `packages/reference-app-web/README.md` — removed the "Tier 2 is currently red" callout; updated the fixture-resolution paragraph to mention `--offline` and (in this review pass) the new `db-p2p` rebuild requirement.

## Validation (review pass)

```
yarn workspace @serfab/reference-app-web typecheck                             # → ok
yarn --cwd ../optimystic workspace @optimystic/db-p2p build                    # → ok
yarn --cwd ../optimystic workspace @optimystic/reference-peer build            # → ok
node ../optimystic/packages/reference-peer/dist/src/cli.js interactive --help  # → `--offline` declared ✓
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 1"              # → 10/10 in 26.6s ✓
yarn workspace @serfab/reference-app-web test:e2e \
  --grep "Tier 2 / distributed / mode flip|bootstrap persistence"              # → 3/3 in 28.0s ✓
```

Tier 2 data-convergence sweep not re-run in this pass — the implementer's earlier sweep (3/6 fail) is the authoritative state and the failure is being tracked under `tickets/fix/web-e2e-tier2-data-convergence`.

## Review findings

### Reviewed aspects and dispositions

- **Diff content (both repos).** Read in full. The connection-gater field on `NodeOptions` is correctly optional and side-effect-free when omitted; the new commander option uses camel-case-to-camel-case mapping that lands on the already-typed `options.offline` consumed at `reference-peer/src/cli.ts:288, 345, 375`. No dead code, no half-baked branches.
- **Type safety.** `ConnectionGater` from `@libp2p/interface` has every member optional, so the browser's `{ denyDialMultiaddr: () => false }` literal satisfies the full `ConnectionGater` slot. `yarn workspace @serfab/reference-app-web typecheck` passes. No `any` introduced.
- **DRY / single-purpose.** The `denyDialMultiaddr` override is declared once at the libp2p-config call site with a WHY comment that names the exact upstream default and explains why we're loosening it. The gater plumbing on `db-p2p` is a single conditional spread, not a new shim layer.
- **Cross-platform / resource cleanup.** Solo/RN/Node code paths through `createLibp2pNodeBase` are unaffected — they don't pass `connectionGater`, so they get libp2p's platform default. The fixture's `stop()` already handled SIGTERM/SIGKILL cleanup; `--offline` doesn't add new resources to clean up (LocalTransactor has no peer-discovery side effects beyond the libp2p node it shares with the network mode).
- **Error handling.** The browser dial failure was previously silent (libp2p emits `DialDeniedError` at `debug` level only) — the gater override eliminates the source of those errors. The implementer flagged plumbing libp2p's `peer:connect` / `connection:close` / dial-error events into the in-app `/diag` ring buffer as a future improvement; not filed (discretion respected).
- **Docs.** README's "Tier 2 is currently red" callout is gone; the resolution paragraph correctly states `--offline` is passed. Review pass **added** the missing `db-p2p` rebuild step to the "force-build the sibling peer" snippet — the implementer's handoff noted that two packages now need rebuilding but the README still implied only one.
- **Test coverage.** Tier 1 (10/10) and the two now-green Tier 2 specs were re-verified in this pass. The implementer's hypothesis for the remaining 3 failures (browser `clusterSize=3` can't form quorum against a single `--offline` bootstrap) is plausible and the follow-up ticket pins down a concrete reproduction recipe — that's enough handoff for the next agent.

### Findings

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| 1 | Minor   | README's `yarn ... reference-peer build` snippet is now stale — `db-p2p` also has to be rebuilt or sereus typecheck fails on the new `connectionGater` field. | Fixed inline in `packages/reference-app-web/README.md` (added the `db-p2p build` line and a one-sentence justification). |
| 2 | Major   | `git -C ../optimystic status` reports the two upstream source files (`db-p2p/src/libp2p-node-base.ts`, `reference-peer/src/cli.ts`) as **uncommitted** in the working tree. The sereus runner only commits the sereus side. On any other machine after `git pull`, the sereus typecheck fails and the Tier 2 fixture spawn fails with `unknown option '--offline'`. | Filed as `tickets/fix/optimystic-uncommitted-connectivity-changes` with the exact diff to land. Not committed from this review pass (cross-repo commit policy — and the sereus runner's commit message would be wrong for the optimystic project). |
| 3 | Major (pre-existing) | 3/6 Tier 2 specs still fail at the data-convergence layer; the original ticket's acceptance criterion ("all 6 Tier 2 specs pass") was not met by the connectivity-only fix. | Already filed by the implementer as `tickets/fix/web-e2e-tier2-data-convergence` with reproduction, suspected cause, and approach options. Confirmed prereq of that ticket points at this slug. |
| 4 | FYI     | `denyDialMultiaddr: () => false` is now in production browser code. For a developer reference SPA this is acceptable (the bootstrap multiaddr is user-pasted into a Network panel, not arbitrary), but the pattern shouldn't propagate into a customer-facing app without revisiting. Implementer already flagged this in their handoff. | Documented in `optimystic.ts:153-157` with a clear WHY comment. No further action — flag stands. |
| 5 | FYI     | `/diag`'s `Recent errors` ring buffer didn't surface the libp2p `DialDeniedError` that root-caused the original Tier 2 stall (libp2p emits it at `debug` level only). Future diagnostics work should subscribe to `peer:connect` / `connection:close` and the dial-queue error event. | Not filed — implementer used discretion. Noted here so the next diagnostics-touching ticket can pick it up. |

### Aspects deliberately not covered

- **Performance / lighthouse / bundle-size.** Out of scope for a connectivity fix; the diff adds one config field and one spawn argv, no new bundle weight beyond the existing `@libp2p/interface` type re-export (type-only, zero runtime cost).
- **Security review of `denyDialMultiaddr: () => false`.** Triaged under finding #4 above as an acknowledged tradeoff for the reference-dev surface; a full review belongs with whatever ticket promotes this gater pattern beyond the dev SPA.
- **Full Tier 2 sweep (all 6 specs) re-run in this pass.** The implementer's earlier 3/6 sweep is authoritative; re-running would only confirm the same data-convergence failures already covered by the follow-up ticket and would cost ~3 minutes for no new signal.

## Acceptance against original ticket

- [x] `--offline` flag declared on `interactive`/`service`/`run` upstream.
- [x] Fixture passes `--offline`; stale JSDoc replaced.
- [x] README "Tier 2 is currently red" callout removed; fixture-resolution paragraph updated (and `db-p2p` rebuild step added in review).
- [x] `connectToBootstrap` connection-row poll resolves <5s.
- [ ] **All 6 Tier 2 specs pass.** 3/6 pass (mode-flip × 2, bootstrap-persistence). 3/6 fail at the convergence layer — root-caused separately under `tickets/fix/web-e2e-tier2-data-convergence`.
