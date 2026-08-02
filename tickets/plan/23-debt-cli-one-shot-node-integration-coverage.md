description: The command-line tool's one-off commands are never tested against a real running node, so a mistake in the shared "start up, do one thing, shut down" step would not be caught by any test.
files: packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/commands/subcommand.ts, packages/cadre-cli/src/commands/strands.ts, packages/cadre-cli/src/commands/validation-key.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/test/subcommand-wiring.spec.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/self-owner-node-helpers.ts, packages/integration-tests/src/harness/node-fixtures.ts
difficulty: medium
----

# CLI one-shot commands have no real-node coverage

## What is untested

Every one-shot `cadre` command (`strand list`, `strand remove`, `validation-key add|remove|list`)
runs the same three steps: read the config file, start a `CadreNode` and wait for it to join the
control network, then perform one control-database operation and shut down. That middle step
lives in one function, `withConnectedNode` (`packages/cadre-cli/src/commands/node-session.ts`),
and **no test ever runs it.**

Coverage today stops on either side of it:

- `packages/cadre-cli/test/subcommand-wiring.spec.ts` drives the real commander parsing, the
  shared `runSubcommand`/`reportPlan` scaffolding and the node adapters — but replaces
  `withConnectedNode` with a stub that hands over a fake node.
- `packages/cadre-core/test/strand-unpublish.spec.ts` (and the validation-key equivalent) drive
  the control-database writes against a real database — but never through the CLI.

So a defect in config resolution, node construction, the connect-or-time-out race, or the
shutdown path would pass every suite in the repo and only surface for an operator.

## Why it is worth closing

These commands are the operator's only way to perform destructive control-plane writes
(removing a strand destroys a membership key that exists nowhere else). "The wiring is
obviously right" is exactly the assumption that a rename, an option-default change, or a
config-schema edit quietly invalidates.

<!-- research-findings: two prior runs were cut short (weekly rate limit, then a token budget
     warning). Everything below is what those runs established; do not re-derive it. -->

## Research findings so far

### `control:connected` means "started", not "has a peer"

`CadreNode.start()` emits `control:connected` unconditionally at the end of start
(`packages/cadre-core/src/cadre-node.ts:697`), whether or not any control peer is reachable.
So `withConnectedNode`'s wait is satisfied by a **solo** node with `bootstrapNodes: []` — a
single-node one-shot command works with no network at all. This is what makes a deterministic
test possible, and it is also why the "read without waiting for sync" caveat in
`strands.ts` (`NOT_PUBLISHED_WARNINGS`) exists.

### A seed-node-over-the-network design is the wrong shape here — do not pursue it

The obvious design (stand up a seed node in-process, point the CLI's config at it via
`controlNetwork.bootstrapNodes`, have the CLI read what the seed published) is **racy by
construction** and was rejected:

- `bootstrapNodes` reaches libp2p as `bootstrap({ list })` peer discovery plus autodial
  (`optimystic/packages/db-p2p/src/libp2p-node-base.ts:652`, `:677`). Nothing in `start()`
  waits for that dial to land.
- Every existing multi-node scenario compensates with a test-only helper,
  `connectControlNodes` (`packages/integration-tests/src/harness/node-fixtures.ts`), which
  dials and waits for **both sides** to report the connection before any write or read. A
  one-shot CLI invocation has no seam to inject that wait into.
- Consequence: the CLI's read would very likely fire before the dial completes and report
  "not published" for a row that exists — a flaky test asserting against documented
  best-effort behaviour, not a defect.

### Transports must match, if a second node is ever involved

A CLI-configured node has **no** transports knob (`CliConfigFile.network` carries only
`listenAddrs`/`announceAddrs`/`relayAddrs`/`enableRelay`), so it gets db-p2p's node defaults:
TCP on `/ip4/0.0.0.0/tcp/0` plus circuit-relay
(`optimystic/packages/db-p2p/src/libp2p-node.ts`). The integration harness's
`controlNodeConfig` uses **WebSockets** — a node built that way cannot be dialed by a
CLI-configured node. Any second node in this test must be constructed directly with TCP
defaults, not via the integration harness's fixture.

### The chosen design: single node, state seeded into its own storage

Seed the control state into the storage the CLI's own node will open, so nothing crosses the
network and there is no convergence wait:

1. The test constructs a `CadreNode` directly (cadre-core), with identity key `K`, party `P`,
   and `storage.provider = (id) => new FileRawStorage(<dir>/<id>)`.
2. It performs genesis the way `control-database-solo.spec.ts` does —
   `db.ensureOwnerKey(node.getIdentityOwnerKey().publicKeyB64)` +
   `node.initializeSeedBootstrap(privateKeyB64)` — then publishes a strand, then stops.
   Genesis is required: a bare CLI node is not an owner, so an unseeded
   `strand remove` / `validation-key add` would fail authorization rather than exercise the
   write. There is no CLI genesis command (`enroll register` is an offline signature check
   only; genesis lives in `start --owner`).
3. It writes a config file (`identity.protobufKeyFile` pointing at `K` in the installer
   format, party `P`, `storage: { type: 'file', path: <dir> }`, `bootstrapNodes: []`).
4. It invokes the CLI against that config and asserts on stdout/stderr and the exit code.

**The one unverified assumption** is step 3→4: that a control database written by one node
process is re-read by the next one over the same `FileRawStorage` directory. Two adjacent
facts make it likely but neither proves it:

- `packages/cadre-core/test/control-database-solo.spec.ts` → "re-reads its control rows after
  a restart on the same identity and storage" proves the control-DB catalog-hydrate restart
  path — but over a **shared in-memory** `MemoryRawStorage` object, and its own comment says
  a `FileRawStorage` variant is what would cover a real backend.
- `packages/quereus-plugin-sereus/test/e2e/bootstrap.e2e.spec.ts` → "persists DML across
  reopen of the same storage path" proves `FileRawStorage` round-trips across sessions — but
  for a strand database, not the control database.

**Verify this first** (see the TODO below). If it does not hold, the fallback is the
degraded-but-still-useful variant in "If persistence does not hold" below.

### Invocation mechanism: spawn the built binary

Spawn `node dist/bin/cadre.js …` as a child process rather than calling `parseAsync`
in-process. Reasons, in order:

- The real exit code is observed, not inferred from a stubbed `process.exit`. Exit codes are
  the security-relevant surface here (`subcommand-wiring.spec.ts` says so explicitly), and a
  stub that lets execution continue past `process.exit` is exactly the fidelity gap this
  ticket exists to close.
- Real stdout/stderr separation, which several assertions depend on (`--json` goes to stdout,
  progress lines to stderr).
- It covers `bin/cadre.js` entrypoint wiring too.
- It sidesteps a `withConnectedNode`-owned libp2p node leaking into the vitest process.

Cost: one node boot per invocation (~1–2 s), and `dist` must be fresh — which the
build-freshness guard already enforces once `@serfab/cadre-cli` is added to the target list.

### Placement: `packages/cadre-cli/test/`

The test needs `@serfab/cadre-cli`'s own `dist` and one directly-constructed `CadreNode`; it
does **not** need the integration harness (whose fixtures are WebSockets-based and therefore
wrong here — see above), its port allocator, or its `fileParallelism: false`. Putting it in
`integration-tests` would also mean adding a `@serfab/cadre-cli` workspace dependency there
purely to reach `dist/bin/cadre.js`.

Two consequences to handle in `packages/cadre-cli/test/global-setup.ts`:

- Add `@serfab/cadre-cli` itself (`dist/bin/cadre.js`) to `TARGETS`, since the spawned child
  runs this package's own compiled output. `build-targets.spec.ts` holds `TARGETS` against
  the package's declared dependencies — check whether a self-entry needs an exemption there.
- `packages/cadre-cli/vitest.config.ts` sets no `testTimeout`, so it is vitest's 5 s default.
  Give each real-node test an explicit per-test timeout (the cadre-core specs use `60_000`).

## What a fix looks like

Two tests, one per command shape — a read and a destructive write. The point is to cover
`withConnectedNode`, not to re-test each command's decision logic, which
`subcommand-wiring.spec.ts` already covers.

- **Read shape, no seeding required:** `cadre strand list --json` against a solo config
  (`bootstrapNodes: []`, memory storage). Asserts exit 0, `[]` on stdout, and the
  `Connecting to control network...` progress line on **stderr** (that split is what makes
  `--json` pipeable). Deterministic with no network and no seeded state — this alone covers
  config resolution → `oneShotNodeConfig` → construction → connect → act → clean shutdown.
- **Destructive write shape:** the seeded-storage recipe above, then
  `cadre strand remove <id> --yes`, asserting exit 0 and `Strand removed`. Re-open the store
  from the test process afterwards and assert `queryStrands()` no longer lists the id — the
  removal must be proven at the database, not from the CLI's own success line.

### If persistence does not hold

If the probe shows the control DB does not restore from `FileRawStorage` across processes,
**do not chase that into optimystic** — it is a separate finding. Instead:

- File the persistence gap as its own ticket (`fix/` if it reproduces plainly, with the probe
  script attached; it is a real durability claim the product depends on, not a test-only
  concern).
- Ship the read-shape test, which needs none of it, and cover the write shape with what a
  fresh solo node can legitimately do end to end in a single invocation: the **refusal** and
  **failure** paths through a real node (`strand remove` of an unpublished id → exit 0
  "nothing to do"; `strand remove '   '` → exit 1). Those still run the full
  `withConnectedNode` body.
- Say plainly in the handoff which half of the coverage was deferred and why.

## Edge cases & interactions

The implement ticket produced from this must name these; each is a test or an explicit
"not covered, because":

- **Connect timeout.** `withConnectedNode`'s `timeoutMs` path is the one branch with a
  documented crash hazard (the comment at `node-session.ts:95` explains why `start()` and the
  timeout are awaited *together*). Reaching it needs a `start()` that outlives the timer.
  Cover it as a focused unit test (call `withConnectedNode` directly with a tiny
  `timeoutMs`), not through the CLI, and assert the process does not die on an unhandled
  rejection.
- **Teardown after a throwing action.** The `finally` must stop the node even when the action
  throws; a leaked libp2p node hangs the vitest run.
- **`node.stop()` failing** prints a warning but must not mask the action's error.
- **Config resolution failures** reach the operator as `failure: <message>` + exit 1: missing
  config file, unparseable YAML, bad `strandFilter`, missing `storage.path` for
  `type: 'file'` (`resolveStorageConfig` throws).
- **Windows paths.** This repo runs on Windows; the config's `storage.path` and
  `protobufKeyFile` are interpolated into strings in places (`${config.path}/${strandId}`).
  Use `path.join` in the test's own fixtures and keep the spawned child's cwd explicit.
- **Temp-directory cleanup** must survive a failing assertion (`try/finally`), and each test
  needs its own directory and party id — a shared one makes the pair order-dependent.
- **Child-process hygiene:** assert on the child's exit code with an explicit timeout, and
  capture both streams; a hung child must fail the test rather than the suite's wall clock.
- **`process.exit` truncation.** `runSubcommand`'s comment notes that `process.exit` does not
  flush a piped stdout. A spawned child with piped stdio is exactly that case — if a `--json`
  listing ever comes back truncated, that is the real defect the comment predicted, not a
  test bug. Note it rather than working around it.

## Related

- `debt-strand-unpublish-multi-node-convergence-test` covers a different gap: whether a
  *sibling* node converges after a removal. This ticket is about the CLI's own plumbing on
  one node.

## TODO (next planning run — small; finish and emit the implement ticket)

- Run the persistence probe: two sequential `CadreNode` lifetimes (separate processes, same
  `FileRawStorage` directory, same identity key, same party id, `bootstrapNodes: []`). Phase
  one does genesis (`ensureOwnerKey` + `initializeSeedBootstrap`) and `publishStrand`; phase
  two asserts `queryStrands()` still lists it and that `unpublishStrand` succeeds. Run it
  from inside `packages/cadre-cli/` so `@serfab/cadre-core` and
  `@optimystic/db-p2p-storage-fs` resolve; delete the script afterwards.
- Confirm whether `packages/cadre-cli/test/build-targets.spec.ts` tolerates a self-referential
  `TARGETS` entry for `@serfab/cadre-cli`, or needs a carve-out.
- Emit the implement ticket with the design above, the chosen branch of "If persistence does
  not hold", and the `## Edge cases & interactions` section carried across verbatim.
