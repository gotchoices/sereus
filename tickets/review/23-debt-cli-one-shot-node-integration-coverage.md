description: The command-line tool's one-off commands now have tests that run them against a real node, plus tests for the failure paths a real node can't produce. Everything has been run and passes.
files: packages/cadre-cli/test/one-shot-node.spec.ts, packages/cadre-cli/test/node-session-branches.spec.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/commands/subcommand.ts
difficulty: medium
----

# Review: one-shot CLI commands covered against a real node

Test-only change. No production source was touched.

## What the change is

Every one-shot `cadre` command (`strand list|remove`, `validation-key add|remove|list`, `status`)
runs the same three steps: resolve the config file, start a `CadreNode` and wait for
`control:connected`, then perform one control-database operation and shut down. That middle step
is `withConnectedNode` (`packages/cadre-cli/src/commands/node-session.ts:74`), and before this
ticket **every** spec in the package replaced it with a stub. A defect in config resolution, node
construction, or the shutdown path passed the whole repo's suites and would have surfaced only
for an operator — on the commands that perform the party's destructive control-plane writes.

Two new spec files close that:

**`test/one-shot-node.spec.ts`** — spawns the real compiled `dist/bin/cadre.js` as a child
process against a real, solo `CadreNode`. Six tests:

- `strand list --json` → exit 0, `JSON.parse(stdout)` is `[]`, and the
  `Connecting to control network...` progress line lands on **stderr**, not stdout. That stream
  split is the `--json` pipeability contract.
- `strand remove <id> --yes` → the test seeds a real owner-signed strand row in-process first
  (genesis via `ensureOwnerKey` + `initializeSeedBootstrap`, then `publishStrand`), pins that the
  row exists, spawns the CLI, asserts exit 0 / `✓ Strand removed:` on stdout / `Removal is
  party-wide` on stderr, then **re-opens a node and asserts the row is gone from
  `queryStrands()`** rather than trusting the CLI's own success line.
- Four config-resolution failures (missing file, unparseable YAML, uninterpretable
  `strandFilter`, `storage: file` with no `path`) → exit 1 plus the operator-facing message.

**`test/node-session-branches.spec.ts`** (new this run) — the `withConnectedNode` branches a real
node cannot produce, against a fake `CadreNode` swapped in via `vi.mock('@serfab/cadre-core', …)`
that keeps `resolveConfig` (and its real `validatePushCredentials` / key loading /
`parseStrandFilter`) unmocked. Seven tests: connect timeout, `start()` resolving late, `start()`
rejecting late, the happy path, action-throws, `stop()`-fails-while-action-throws, and
`stop()`-fails-alone.

**`test/global-setup.ts`** — added `@serfab/cadre-cli` itself to the stale-build `TARGETS`, since
the suite now spawns this package's own `dist`.

## Validation performed

All green, in this order:

| command | result |
|---|---|
| `yarn workspace @serfab/cadre-cli build` | clean |
| `yarn workspace @serfab/cadre-cli test` | **16 files, 177 tests passed**, 33.5s |
| `yarn workspace @serfab/cadre-cli typecheck` | clean |
| `yarn lint` (repo-wide) | clean |

`build-targets.spec.ts` passes unchanged with the new self-entry — as predicted, `targetListProblems`
only reports dependencies *missing* from the list, and a package is never its own dependency.

Both new specs passed on the first execution; no adjustment to `one-shot-node.spec.ts` was needed
(the `profile: 'transaction'` + `storage: { type: 'memory' }` pairing and the `listenAddrs: []`
relay concern the prior run flagged as likely friction both turned out to be non-issues).

### Measured wall-clock cost

Baseline (suite with the two new files excluded): **15.7s**. With them: **33.5s** — so the new
coverage adds **≈18s** to the cadre-cli suite. Per-test, from `--reporter=verbose`:

- `one-shot-node.spec.ts` — 14.8s of test time total. The `strand remove` round trip is the
  expensive one at 5.6s (it boots three nodes: seed, spawned CLI, verifier); the other five are
  1.7–1.9s each, almost all of it child-process + libp2p start-up.
- `node-session-branches.spec.ts` — 0.6s total. The two late-settle tests are ~263ms each by
  construction (they wait past a deliberate 200ms late settle); the rest are single-digit ms.

## Things a reviewer should push on

**The stale-build tradeoff is now wider, and it was accepted deliberately.** Adding
`@serfab/cadre-cli` to its own `TARGETS` means an edit to `packages/cadre-cli/src` with no
following rebuild fails the **whole** cadre-cli suite — including the 14 specs that import `src`
directly and never touch `dist`. `integration-tests` already carries the same tradeoff. Editing a
spec does *not* trip it (`test/` is excluded from the source scan,
`test-harness/build-freshness.ts:86`). If a reviewer thinks the blast radius is wrong, the
alternative is a per-spec guard rather than a suite-level one, and that is a real design
conversation — not a defect.

**`process.exit` truncation of a piped stdout is NOT covered.** `subcommand.ts:61` carries a
`NOTE:` saying `process.exit` does not flush a pipe, so output written just before it can be lost
when stdout is piped — fine at a line or two, a risk if a listing ever gets large. The new tests
run entirely at the safe size (`[]`, and one `✓ …` line), and observed complete output. There is
no test that pipes a *large* `--json` listing. If a reviewer wants that covered, it needs a seeded
party with many strands, and if the output comes back truncated **that is the real defect the
comment predicts** — report it, do not work around it in the test.

**Real-node coverage is `strand` only.** `validation-key add|remove|list` and `status` go through
the same `withConnectedNode` seam and are covered only over the fake node in
`subcommand-wiring.spec.ts`. The seam itself is now genuinely exercised, so the marginal value of
spawning each of them is lower — but it is a coverage gap, and the ~1.8s-per-spawn cost measured
above is the price of closing it.

**A networked, multi-node CLI test was rejected, not overlooked.** `bootstrapNodes` reaches libp2p
as peer discovery + autodial, and nothing in `start()` waits for the dial — so a CLI read fires
before the dial completes and reports "not published" for a row that exists. That is documented
best-effort behaviour, so a test asserting against it would be flaky by construction. Transports
would also mismatch: a CLI-configured node gets db-p2p's TCP + circuit-relay defaults
(`CliConfigFile.network` has no transports knob) while the `integration-tests` harness uses
WebSockets. Cross-node CLI behaviour belongs in `integration-tests`, not here.

**Every config in `one-shot-node.spec.ts` sets `network: { listenAddrs: [] }`,** so no node binds
a port and the file is safe to run in parallel with the rest of the suite. A future test needing a
listening node needs a port strategy first; this is stated in the file's header comment.

**The late-settle tests assert an absence.** They watch `process.on('unhandledRejection')` and
assert it never fired, because the thrown error is identical whether `withConnectedNode` awaits
`start()` and the timeout together or in sequence — only the crash differs. A reviewer should
check the watcher is actually capable of firing (it is additive to vitest's own handler, removed
in a `finally`), since a broken watcher would make these tests vacuous.

**Timing assumptions.** `TIMEOUT_MS = 50` / `LATE_SETTLE_MS = 200` in the branches spec are the
only wall-clock-sensitive numbers introduced. A heavily loaded CI box could in principle delay the
50ms timer past the 200ms late settle and invert the ordering the late-settle tests depend on. The
margin is 4× and these tests do no I/O; it has not been observed. Worth a reviewer's judgement on
whether 4× is enough.
