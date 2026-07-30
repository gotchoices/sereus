description: Added automated tests proving that when a device joins a group chat, that group's network connection announces itself under its own separate network identity — both in the connection it starts and in the identity it tells relays to expect — instead of reusing the device's main identity.
files: packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts (new, 7 tests), packages/cadre-core/src/cadre-node.ts (launchStrand L3161-3212, unchanged), packages/cadre-core/src/strand-transport-key.ts (unchanged)
----

# Cover the strand-launch wiring, not just the key helper

## Outcome

Test-only ticket; no production code changed. `packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts`
now holds 7 tests over `CadreNode.launchStrand`'s transport-key wiring — the 4 handed over by
the implement stage plus 3 added in review (below).

The spec constructs a `CadreNode`, injects the private `identityKey` and a fake `strandManager`
(records every `StartStrandConfig`) through `as unknown as {...}` casts, then calls the private
`launchStrand` directly — the injection pattern already used by `test/cadre-node-strand-seed.spec.ts`.
No real libp2p node is started.

Covered:

- `startStrand` receives a `privateKey` whose peerId differs from the control node's identity peerId.
- That key is byte-equal (`.raw`) to `strandTransportKey(identityKey, strandId)` — the derived key,
  not a fresh random one (a random key would also be distinct but would lose peerId stability
  across hibernate/wake).
- Two strands launched on the same node get distinct keys.
- With no identity key configured, `privateKey` is `undefined` (real production path — nodes
  without `keyStore`/`privateKey`).
- **(added in review)** `resolveCohortSeed` receives the *derived* peerId as `delegatePeerId`, not
  the control identity peerId.
- **(added in review)** with no identity key, no delegate is announced (`undefined`).
- **(added in review)** a non-Ed25519 identity key rejects the launch (error names `Ed25519`) and
  `startStrand` is never reached — no half-started strand.

## Review findings

**Checked:** the implement diff (the spec file itself landed in commit `b7a31ee`, the plan commit,
because it was already drafted uncommitted; `9166e54` moved only the ticket); `launchStrand`
(`cadre-node.ts:3161-3212`) against every assertion; `strand-transport-key.ts`; the retained-launch-config
path in `strand-instance-manager.ts` that the launch comment's stability claim depends on;
`hibernation-manager.trackStrand` for test-side resource leaks; `docs/architecture.md` lines 495 /
502 / 679 against the code.

**Fixed in this pass (minor):**

- *Untested wiring in the function under test.* `launchStrand` also derives `delegatePeerId` from the
  transport key (L3190) and hands it to `resolveCohortSeed`; that peerId is what a membership-gated
  relay records an admission grant for, so announcing the control identity instead would make the
  strand node's relay reservation get denied at `libp2p.start()`. Nothing asserted it. Added
  `captureDelegatePeerIds`, which wraps `resolveCohortSeed` while leaving the real implementation
  (and its empty-seed short-circuit) in place, plus two tests — derived peerId announced, and no
  delegate when there is no identity key. This also pins by test the derive-before-seed-resolution
  ordering that the implement stage could only verify by reading.
- *Untested documented error path.* The comment at `cadre-node.ts:3174-3181` states that a non-Ed25519
  identity key now fails strand launch outright. Added a test asserting the rejection mentions
  `Ed25519` and that `startStrand` is never called.
- Extended the spec's header comment to say the delegate argument is covered too.

**Filed as a new ticket (major):**

- `backlog/debt-strand-resume-keeps-transport-identity-test` — the launch side is now pinned, but
  the peerId-stability claim ("hibernate → wake reuses the same peerId") rests on
  `StrandInstanceManager.resumeStrand` spreading the retained launch config, and *nothing* tests
  that. Behavior is correct today (`launchConfigs` is cleared only by `stopStrand`, L447, not by
  hibernation), but a future edit that rebuilt the resume config from scratch would churn the
  peerId silently. Out of this ticket's file list, hence a ticket rather than an inline fix.

**Tripwires:** one, already documented at its site — the no-identity-key and non-Ed25519 paths both
fall through to libp2p generating a random per-strand key, which avoids the relay collision but
gives up peerId stability across restarts. `cadre-node.ts:3174-3181` and `strand-transport-key.ts`
already spell this out; no new comment added.

**Checked and clean (no findings):** production code — none needed changing, the ticket's premise
held. Resource cleanup — the tests never call `node.start()`, and `hibernationManager.trackStrand`
returns immediately while `!running` (`hibernation-manager.ts:164`), so no timers leak and no
`afterEach` teardown is required. Docs — `docs/architecture.md` (495, 502, 679) already describes the
per-strand transport peerId and the delegate announcement accurately; a test-only change gives it
nothing new to say, so no doc edit. Test hygiene — the `Math.random()` party id in `createConfig` is
the established convention copied from `cadre-node-strand-seed.spec.ts`, not a new smell.

## Validation

All run from a clean tree at review time:

- `yarn vitest run test/cadre-node-strand-launch-key.spec.ts` (in `packages/cadre-core`) — **7/7 passed**.
- `yarn vitest run` full `packages/cadre-core` suite — **76 files, 1198 passed, 1 skipped**, no failures.
  (The single skip is the pre-existing win32 `skipIf` in `key-store.spec.ts`, already recorded in
  `tickets/.pre-existing-known.md`.)
- `eslint packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts` from repo root — **exit 0**.
- `yarn workspace @serfab/cadre-core typecheck` — **exit 0**; root `yarn typecheck` — **exit 0**
  (both listed as unrun gaps by the implement stage).

The stale-build guard tripped first (`@quereus/quereus` dist older than its src, from in-flight edits
in the sibling `C:\projects\quereus` workspace). Rebuilt it with `tsc -p
C:/projects/quereus/packages/quereus/tsconfig.json` — compiled clean, no source touched. Same
build-drift situation already described in `tickets/.pre-existing-known.md`; not a defect and not
re-reported.
