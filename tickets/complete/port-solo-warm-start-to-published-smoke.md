----
description: The check that downloads our published packages and runs a real node against them now also covers a phone that used to be in a group and is the only device left — the exact situation an outside team reported a freeze in.
files: scripts/lib/published-smoke-scenario.mjs, scripts/smoke-published-install.mjs, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, packages/cadre-core/test/control-database-solo.spec.ts, docs/STATUS.md, docs/releasing.md
----

# Solo warm-start ported into the published-install smoke scenario

## What shipped

`scripts/lib/published-smoke-scenario.mjs` — the body `yarn smoke:published` copies into a scratch
project installed from packed tarballs plus the public registry — carries **five** cases instead of
three. The two new ones are ports of `packages/cadre-core/test/control-database-solo-warm-start.spec.ts`:

- **`solo warm start — start() then addStrand() with vanished prior-cohort peers on disk`.** Era 1
  founds the party, registers self, and mints one signed-but-unreachable sibling at an RFC 5737
  TEST-NET-1 address. Era 2 constructs a fresh `CadreNode` over the same temp directory, asserts the
  owner key and the full two-member set read back off disk, then goes `start()` → `addStrand()` with
  no genesis re-run and no `initializeSeedBootstrap` — the embedding app's order. Asserts
  `mode === 'networked'`, `status === 'active'`.
- **`solo cold boot — addStrand() before any genesis, in the embedder order`.** Same order with the
  stale rows removed: `hasOwnerKey()` false, `addStrand()` → `bootstrap`/`active`, then genesis and
  `registerSelf()` still accepted afterwards.

Both run over `FileRawStorage` under a `mkdtemp` directory, so only bytes on disk cross each restart
boundary. Both keep the labelled deadlines (`HANG: solo control op <label> timed out after <n>ms`);
`addStrand` gets its own 60 s budget because it brings a second libp2p node up.

Scratch-project dependencies grew by three, all declared in `SCENARIO_DIRECT_DEPS`:
`@optimystic/db-p2p-storage-fs` (the file-backed storage — and the one `@optimystic/*` with no root
`resolutions` entry, so it always resolves from the registry) and `@libp2p/crypto` + `@libp2p/peer-id`
(minting the sibling identity). The cheaper-looking alternative — `authorizePeer` on a peerId harvested
from a throwaway node — writes `Sig: null`, so `resolvePeerAddrs` returns `[]` and the sibling row is
never proven real; the dependencies bought the spec's anti-vacuity check.

**Not covered, by design:** four of the six spec cases stay spec-only (revoked prior cohort,
closed-strand founder, three siblings, re-issue-queue restart durability). A substrate regression in
the revocation join or in closed-strand founder bootstrap is caught by the vitest suite, not by
`yarn smoke:published`. The sApp signing key is bridged from the libp2p keypair through
`ed25519KeyPairFromLibp2p` rather than minted by `@optimystic/quereus-plugin-crypto`, so the port does
not exercise that package's own key generation as installed from the registry.

## Review findings

### Checked

The implement diff (`82e4704`) and the prior interrupted run's commit (`0fb4b1e`, where the scenario
body itself actually lives) were read first, then the port was compared assertion-by-assertion against
`control-database-solo-warm-start.spec.ts` and `control-db-node-helpers.ts`. Also verified: every
symbol the port imports from `@serfab/cadre-core` really is on the published surface
(`ed25519KeyPairFromLibp2p`, `signPeerRecord`, `signSchema`, `CadreNode`, `InMemoryKeyStore` are all
exported from `src/index.ts`), all five `SCENARIO_DIRECT_DEPS` resolve through `declaredRange` with no
cross-workspace disagreement, and `@optimystic/db-p2p-storage-fs` genuinely has no root `resolutions`
entry — so the STATUS claim that it always comes from the registry holds.

The two questions the handoff flagged for a reviewer both come out clean:

- **The anti-vacuity guard does precede the headline assertion, and does compare the full set.**
  `assertWarmState` runs before `addStrand` and compares `queryCadrePeers()` as a `Set` against
  self + sibling, not a count. And `mode === 'networked'` does bite: the cold-boot case asserts
  `'bootstrap'` at the same call, so the two cases cannot silently collapse into each other.
- **`foundCohort` returning bare peerId strings** (where the spec returns `OfflinePeer` objects) is
  harmless — the addrs are consumed only inside `mintBlackholePeer`'s own resolve check, which the
  port keeps verbatim.

Resource handling is sound: `within` clears its timer in `finally`, every node is stopped in `finally`,
every temp directory is removed in `finally`.

### Fixed in this pass (minor)

- **`scripts/smoke-published-install.mjs` described its own scenario wrongly.** Its header still said
  step 3 runs "the cadre-of-one control-DB scenario … a port of `control-database-solo.spec.ts`", and
  the run banner printed the same — stale in the very file this ticket edited. Both now name the
  warm-start half.
- **The fourth pointer comment was missed.** `control-database-solo.spec.ts`'s header said "these same
  three cases are ported", giving a reader editing the port no hint that it now answers to a second
  spec. Since these comments are the *entire* keep-in-step mechanism, an incomplete one is the defect.
  It now names the sibling spec.
- **Temp-directory teardown hardened** (the handoff's own known gap, fixed rather than parked):
  `rmSync(dir, { recursive: true, force: true })` → plus `maxRetries: 5, retryDelay: 100`, in both the
  port's `withDevice` and the spec's. `force` swallows `ENOENT` but not the `EBUSY` a `FileRawStorage`
  handle outliving `stop()` raises on Windows, which would fail an otherwise-passing case. Fixed
  inline because it is one option object and the repo already does exactly this wherever a live node
  holds files — `packages/integration-tests/src/harness/test-cadre-host.ts:256`,
  `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:366`.
- **Doc numbers corrected.** `docs/STATUS.md` pinned the two warm-start cases at "~3.6–3.9 s"; measured
  3.1–4.1 s across runs here, so the range is now stated loosely. `docs/releasing.md` still called the
  smoke "a single-node control-database scenario" and now names both shapes it runs.

### Recorded as a tripwire, not a ticket

- **`SCENARIO_DIRECT_DEPS` can drift from the scenario's imports, and no run inside this repo would
  notice.** Running the scenario from the workspace resolves imports through the root `node_modules`,
  which answers specifiers the flat scratch project would not — so the 5/5 pass proves the scenario
  *body*, not the dependency list. A missing entry surfaces only at release time, as an
  `ERR_MODULE_NOT_FOUND` that reads exactly like the upstream `chai` defect. All six specifiers were
  checked by hand and are covered today, so there is nothing to fix; a `NOTE:` at the list in
  `scripts/smoke-published-install.mjs` says to mechanise the check if either side grows again.

### No new tickets filed — and why

Nothing rose to major. The two real limitations are already tracked elsewhere and were not re-filed:
the smoke cannot run end to end at all (`tickets/blocked/optimystic-testing-barrel-breaks-consumer-install`),
and the scenario file sits outside lint and typecheck
(`tickets/backlog/debt-tooling-scripts-unlinted-and-unchecked`, whose root cause is the `ignores` entry
in `eslint.config.mjs`, not this file). The four unported spec cases are a stated design choice, not an
oversight, and are documented in three places. One pre-existing pattern was noticed and deliberately
left alone: the scenario ends with `process.exit()`, which can in principle truncate a piped stdout —
it predates this diff, is unchanged by it, and has never been observed to lose a line.

### Still unproven, unchanged by this review

`yarn smoke:published` was never run end to end and cannot be: it fails at HEAD on
`ERR_MODULE_NOT_FOUND: Cannot find package 'chai'` when importing `@serfab/cadre-core` from a registry
install, and installing `chai` by hand to force a green run is forbidden — it hides the exact defect the
script exists to catch. **So the point of this port — that the warm-start shape runs against the
substrate a customer installs — remains unproven.** What is proven is that the scenario body is correct
and that the scratch project can be described (deps resolve, ranges agree). Also unexercised: npm
actually installing the three new dependencies into the scratch project, which is upstream of the
`chai` failure in the script's order, so a reviewer with network could confirm that half alone via
`yarn smoke:published --keep` and reading the install log before the scenario crashes.

## Validation

- `node scripts/lib/published-smoke-scenario.mjs` — **5/5 pass**, before and after the review's edits.
  Cadre-of-one cases 73–169 ms; warm-start vanished 3.7–4.1 s; cold boot 3.1–3.6 s. So the port adds
  ~7–8 s of wall clock to a smoke run.
- `npx vitest run test/control-database-solo-warm-start.spec.ts test/control-database-solo.spec.ts` in
  `packages/cadre-core` — 9/9 pass, after the teardown edit.
- `yarn lint` — clean. `yarn typecheck` — clean (281 test files across 10 packages in-program).
- `yarn test:published-smoke-support` — 23/23.
- Full `yarn test` (10 workspaces) was **not** run: the diff is two script files, two docs, and one
  spec whose own suite was run directly, and the full sweep would exceed the agent-runnable wall-clock
  budget without touching anything this change can affect.
