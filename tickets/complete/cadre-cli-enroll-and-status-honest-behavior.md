description: Completed — `cadre enroll register` is now an honest offline authority-signature verification (no fake "registered" success) and `cadre status` reports live runtime from the running node's health `/status` endpoint instead of a hardcoded `running:false`. Shared `peerAuthorizationDigest`/`verifyPeerAuthorization` helper added to cadre-core and wired into `SeedBootstrapService`.
files: packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-authorization.spec.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/status.ts, packages/cadre-cli/src/commands/status-query.ts, packages/cadre-cli/test/status.spec.ts, packages/cadre-cli/README.md, packages/cadre-cli/package.json, docs/architecture.md

# What shipped

Two CLI commands that previously *claimed* network operations while only
validating input shapes were made honest, under the unifying invariant:
**emitted messages and the command description must match what the command
actually did.**

- **`cadre-core` shared helper** — `peer-authorization.ts` exports
  `peerAuthorizationDigest(peerId)` (the canonical `digest(peerId,'sha256',
  'utf8','base64url')` an authority signs) and `verifyPeerAuthorization(peerId,
  authorityPublicKey, signature)` (the ed25519 mirror verify; never throws —
  malformed/garbage/empty → `false`, logged at debug). `SeedBootstrapService`
  now signs over `peerAuthorizationDigest()` on both the `authorizePeer` INSERT
  and `removePeer` paths (byte-identical to the prior inline `digest(...)`), so
  producer and verifier can't drift. Both re-exported from `index.ts`.
- **`cadre enroll register`** — dropped the fake "Registering…" line and the
  unused `EnrollmentService`. Now parses `--peer-id` via `peerIdFromString`,
  calls `verifyPeerAuthorization`, and prints either `✓ Authority signature is
  valid…` (with explicit "did NOT register / membership is granted by `cadre
  start --authority`") or `✗ … (peer is NOT authorized)`. `--bootstrap` kept as
  advisory metadata per spec; `@libp2p/peer-id` moved dev → runtime dependency.
- **`cadre status`** — new pure seam `status-query.ts` (`queryRuntime` /
  `buildStatusReport` / `formatStatusReport`) probes the health `/status`
  endpoint and returns a discriminated `reachable` result. `status.ts` adds
  `--health-host`/`--health-port` (env `CADRE_HEALTH_PORT`, mirrors `start.ts`)
  /`--timeout`; missing config is non-fatal; `--json` emits `{ config, runtime }`;
  **exit code 3** when no node is reachable. The unreachable branch carries **no
  `running` field** — never a bare `running:false`.

# Review findings

Reviewed the full implement diff (all 12 files) with fresh eyes before reading
the handoff, then scrutinized for correctness, DRY, resource cleanup, error
handling, type safety, honesty-of-output, and doc currency.

## Validation run (all green)
- `cadre-core`: `yarn build` clean, `yarn test` → **288 passed**, `yarn typecheck` clean.
- `cadre-cli`: `yarn build` clean, `yarn test` → **50 passed**, `yarn typecheck` clean.
- `yarn eslint` on every changed file → **0 errors** (3 warnings, all pre-existing — see below).

## Checked, no issue found
- **Honesty invariants (the core of the ticket)** — confirmed by tests and by
  reading the code: unreachable `status` emits no `running` key in JSON and no
  `Running:` line in human output (`status.spec.ts`); reachable surfaces live
  `running`/`peerId`/`multiaddrs`/strand counts. `enroll register`'s valid path
  never implies local registration.
- **Digest-drift safety** — `peer-authorization.spec.ts` includes a regression
  that signs via the *inline* pre-helper construction and asserts the shared
  verifier still accepts it; the unchanged `seed-bootstrap` authorize/round-trip
  suite still passes. Producer/verifier are genuinely unified.
- **`HealthStatus` contract** — `status-query.ts`'s `RuntimeLive` fields all
  exist on `health.ts`'s `HealthStatus` (`node.running`, `node.strands`,
  `peerId`, `multiaddrs`, `status`, `uptime`); typecheck enforces this.
- **`queryRuntime` resource handling** — timeout is raced via an
  `AbortController`; the timer is cleared in `finally`; `attemptFetch` swallows
  all errors and never rejects, so the losing race branch can't surface an
  unhandled rejection. Sound.
- **Env precedence** — `parseInt(process.env.CADRE_HEALTH_PORT ?? options.healthPort, 10)`
  is byte-for-byte the same pattern `start.ts` already uses; consistent, not a
  regression.
- **`EnrollmentService` import** — still used by the `enroll create` subcommand,
  so the retained import is correct (not dead).
- **Reachable-but-starting node** — when a node answers `/status` mid-startup
  (`node.running:false`), `status` honestly reports `running:false` and exits 0;
  that is the node's real self-report, not a fabricated default. Correct per spec.

## Minor findings — fixed inline this pass
- **Stale README (the very dishonesty this ticket fixes)** —
  `packages/cadre-cli/README.md` still described `enroll register` as "Register a
  peer (requires authority signature)" and omitted `status`'s new live-runtime
  behavior/flags. This doc *should* have been touched by the implement diff and
  wasn't. Rewrote both sections to describe the offline verification and the
  live-`/status` query (`--health-host`/`--health-port`/`--timeout`, exit 3).
- **Inaccurate `--config` help text** — `enroll register`'s `-c, --config` help
  claimed "(echoed back; not used to register)", but the action never echoes the
  config value. Corrected to "(accepted for compatibility; not used by this
  offline check)".

## Minor findings — noted, deliberately not changed
- **Dead defensive checks in `enroll register`** — the `if (!options.authorityKey)`
  / `if (!options.signature)` guards and the `options.bootstrap.length === 0`
  check are effectively unreachable, since commander's `requiredOption` already
  rejects a missing option before the action runs. Harmless belt-and-suspenders;
  left in place (defensible against future option-type changes, no behavior cost).
- **`--health-port` has no NaN fallback** — `--timeout` falls back to 2000ms on
  unparseable input, but a non-numeric `--health-port` yields `:NaN` in the URL,
  which simply produces a `reachable:false` result (not a crash). Mirrors
  `start.ts`'s identical pattern; acceptable.

## Gaps assessed (from the implementer's honest flags) — none blocking
- **No in-process test of `status.ts`'s action glue** (option parse → env →
  exit-code wiring) — acknowledged. The honesty-critical logic lives in the pure
  `status-query.ts` seam, which is well-covered; `process.exit` makes in-process
  CLI testing awkward and a process-spawning harness was reasonably skipped. The
  action glue is thin and was manually smoke-tested. Acceptable as a known gap.
- **`@libp2p/peer-id` dep move (dev → runtime) without a `yarn install` re-run** —
  build, test, and typecheck all pass (the package was already hoisted). A
  lockfile-sync pass is a CI hygiene concern, not a code defect.
- **`--bootstrap` required for an offline check** and **exit code 3** — both are
  documented design choices per the ticket spec; left as-is.

## Pre-existing (not this ticket)
- Three lint **warnings** in `seed-bootstrap.ts` — unused type imports `PeerId`
  (line 4), `Multiaddr` (line 6), `SignedTransaction` (line 25). Confirmed
  present at `4246900~1` (before this diff); untouched here and remain
  backlogged. No `.pre-existing-error.md` filed (warnings, not test failures;
  build/tests are green).

## Major findings
- **None.** No new `fix/`/`plan/`/`backlog/` tickets warranted.

# Not done (out of scope, by design — unchanged from implement)
- Neither command grew a real network-registration path — registration remains
  authority-driven (`SeedBootstrapService.authorizePeer` via `cadre start
  --authority`).
- `status` reads the unauthenticated health `/status` endpoint, not the
  bearer-gated loopback admin channel; `connectionPaths` from the health
  envelope is not surfaced. Both are possible later enhancements.
