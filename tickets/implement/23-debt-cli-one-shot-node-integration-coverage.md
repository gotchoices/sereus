description: The command-line tool's one-off commands are never tested against a real running node, so a mistake in the shared "start up, do one thing, shut down" step would not be caught by any test. Add tests that run the real command against a real node.
files: packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/commands/subcommand.ts, packages/cadre-cli/src/commands/strands.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-cli/test/build-targets.spec.ts, packages/cadre-cli/test/subcommand-wiring.spec.ts, packages/cadre-cli/test/entrypoint.spec.ts, packages/cadre-core/test/control-database-solo.spec.ts
difficulty: medium
----

# Cover the CLI's one-shot commands against a real node

## The gap

Every one-shot `cadre` command (`strand list`, `strand remove`, `validation-key add|remove|list`)
runs the same three steps: read the config file, start a `CadreNode` and wait for it to join the
control network, then perform one control-database operation and shut down. That middle step is
`withConnectedNode` (`packages/cadre-cli/src/commands/node-session.ts:74`) and **no test runs it**.

- `packages/cadre-cli/test/subcommand-wiring.spec.ts` drives real commander parsing, the shared
  `runSubcommand`/`reportPlan` scaffolding and the node adapters — but replaces
  `withConnectedNode` with a stub (`vi.mock('../src/commands/node-session.js', …)`).
- `packages/cadre-core/test/strand-unpublish.spec.ts` drives the control-database writes against a
  real database — but never through the CLI.

So a defect in config resolution, node construction, the connect-or-time-out race, or the shutdown
path passes every suite in the repo and only surfaces for an operator. These commands are the
operator's only way to perform destructive control-plane writes (removing a closed strand destroys
a membership key that exists nowhere else), so that is the wrong place to find out.

## What the planning runs already proved — do not re-derive

Three throwaway probes were run and deleted. Their results are the load-bearing facts here; each
one is stated with what was actually observed.

### 1. `control:connected` means "started", not "has a peer"

`CadreNode.start()` emits `control:connected` unconditionally at the end of start
(`packages/cadre-core/src/cadre-node.ts:697`), reachable peers or not. So `withConnectedNode`'s
wait is satisfied by a **solo** node with `bootstrapNodes: []` — a one-shot command works with no
network at all. That is what makes a deterministic test possible, and it is also why the
"read without waiting for sync" caveat in `strands.ts` (`NOT_PUBLISHED_WARNINGS`) exists.

### 2. The control database DOES survive across processes on the same file storage

Two sequential node processes, same `FileRawStorage` directory, same protobuf identity key, same
party id, `bootstrapNodes: []`. Phase one did genesis (`ensureOwnerKey` + `initializeSeedBootstrap`)
and `publishStrand`; phase two, a **separate `node` process**, read it back and removed it:

```
phase1 ensureOwnerKey: true
phase1 queryStrands: [{"Id":"probe-strand","MemberPrivateKey":null,"Type":"o"}]
phase2 hasOwnerKey: true
phase2 ownerKeys match: true
phase2 queryStrands(before): [{"Id":"probe-strand","MemberPrivateKey":null,"Type":"o"}]
phase2 queryStrands(after): []
```

The seed-the-storage design is therefore viable, and the plan ticket's "If persistence does not
hold" fallback is **dead** — ignore it, build the full write-shape test.

### 3. Both CLI shapes already work end to end when spawned

The real `dist/bin/cadre.js` was spawned as a child process against a solo config. Exact output:

- **Read shape** — `cadre strand list --json -c <config>` with `storage: {type: memory}`:
  exit `0`, stdout `"[]\n"`, stderr `"Connecting to control network...\n"`.
- **Write shape** — storage seeded in-process by a directly-constructed `CadreNode` (genesis +
  `publishStrand`), then `cadre strand remove <id> --yes -c <config>`:
  exit `0`, stdout `"✓ Strand removed: probe-strand-cli\n"`, the three `⚠ Removal is party-wide…`
  warning lines on stderr, and a node re-opened afterwards from the test process reported
  `queryStrands()` → `[]`.

These are the assertions to write. They are observed values, not predictions.

### 4. A tiny `timeoutMs` does NOT reach the timeout branch — the plan ticket was wrong here

`withConnectedNode(configPath, action, timeoutMs)` was called against a real solo node with
`timeoutMs` of `0`, `1`, `5`, `20` and `60`. **Every one of them ran the action** ("timeout did not
win"), with total elapsed 115–185 ms. `node.start()` completes without the event loop ever
returning to the timers phase, so the `setTimeout` never gets to fire. Do not write a "call it with
a tiny timeout against a real node" test — it would pass while covering the opposite branch.

Cover the timeout branch with a **fake `CadreNode`** instead (see the TODO), swapping only the
class:

```ts
vi.mock('@serfab/cadre-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@serfab/cadre-core')>()),
  CadreNode: FakeCadreNode,
}));
```

Spreading the original keeps `resolveConfig`'s real dependencies (`validatePushCredentials`) intact,
so the config half of `withConnectedNode` is still the real code path.

### 5. `global-setup.ts` needs a self-entry, and `build-targets.spec.ts` needs no carve-out

The new spec spawns this package's own compiled output, so add to `TARGETS` in
`packages/cadre-cli/test/global-setup.ts`:

```ts
{ packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js', location: 'workspace' },
```

That is byte-identical to the entry `packages/integration-tests/test/global-setup.ts:26` already
carries. No exemption is needed in `build-targets.spec.ts`: `targetListProblems`
(`test-harness/build-targets.ts:41`) only reports dependencies that are *missing* or listed under
the wrong location — extra entries are explicitly supported ("A list may legitimately be a
*superset* of its own package's `dependencies`"), a self-entry is not in `dependencies` at all, and
the "name each package once" assertion is satisfied by a single entry. `checkWorkspaceTarget`
resolves the name through `packages/*/package.json`, which finds `packages/cadre-cli`.

Accepted cost, worth stating in the handoff: from now on an edit to `packages/cadre-cli/src` with
no rebuild fails the **whole** cadre-cli suite, including the specs that import `src` directly and
never touch `dist`. That is the same tradeoff `integration-tests` already accepted, and it is
correct — the new spec genuinely runs `dist`. `test/` is excluded from the freshness scan
(`SOURCE_EXCLUDE_DIRS` in `test-harness/build-freshness.ts:86`), so editing specs does not trip it.

### 6. A seed node reached over the network is the wrong shape — do not pursue it

The obvious alternative (stand up a seed node in-process, point the CLI at it via
`controlNetwork.bootstrapNodes`) is racy by construction: `bootstrapNodes` reaches libp2p as
`bootstrap({ list })` peer discovery plus autodial, and nothing in `start()` waits for the dial to
land. Every existing multi-node scenario compensates with `connectControlNodes`
(`packages/integration-tests/src/harness/node-fixtures.ts`), which waits for **both sides** to
report the connection — and a one-shot CLI invocation has no seam to inject that wait into. The
CLI's read would fire before the dial completed and report "not published" for a row that exists:
a flaky test asserting against documented best-effort behaviour.

Transports would also have to match if a second node were ever involved: a CLI-configured node has
no transports knob (`CliConfigFile.network` carries only `listenAddrs`/`announceAddrs`/`relayAddrs`/
`enableRelay`), so it gets db-p2p's TCP + circuit-relay defaults, while the integration harness's
`controlNodeConfig` uses WebSockets. A harness-built node cannot be dialed by a CLI-configured one.

### 7. Placement: `packages/cadre-cli/test/`, not `integration-tests`

The test needs this package's own `dist` and one directly-constructed `CadreNode`. It does not need
the integration harness (whose fixtures are WebSockets-based and therefore wrong here), its port
allocator, or its `fileParallelism: false`. Putting it there would also mean adding a
`@serfab/cadre-cli` workspace dependency to `integration-tests` purely to reach `dist/bin/cadre.js`.

Every config in this spec sets `network: { listenAddrs: [] }`, so no node binds a port and the
files stay safe to run in parallel with the rest of the suite.

## The design

### Fixture shape

Each test gets its own temp directory (under `os.tmpdir()` via `mkdtempSync`) and its own party id
(`` `cli-oneshot-<tag>-${Math.random().toString(36).slice(2)}` ``), torn down in `try`/`finally` so a
failing assertion still cleans up.

Identity: generate an Ed25519 key, write `privateKeyToProtobuf(key)` bytes to `<dir>/identity.key`.
The CLI config points at it with `identity.protobufKeyFile`; a seed node constructed in-process uses
`privateKeyFromProtobuf(readFileSync(...))` for the same `privateKey`. Same key ⇒ same PeerId ⇒ the
same owner identity that genesis enrolled.

Config file, written as `<dir>/cadre.json` (JSON so `loadConfigFile` takes the JSON branch):

```jsonc
{
  "identity": { "protobufKeyFile": "<dir>/identity.key" },
  "controlNetwork": { "partyId": "<fresh>", "bootstrapNodes": [] },
  "profile": "storage",              // "transaction" for the memory-storage read test
  "strandFilter": "none",            // see below
  "storage": { "type": "file", "path": "<dir>/blocks" },
  "network": { "listenAddrs": [] }
}
```

`strandFilter: "none"` is deliberate: it stops the one-shot node from trying to *launch* a strand
instance for the seeded row (there is no real strand network behind it). `strand remove` reads the
row through `db.queryStrand(id)` directly, not through the filter, so nothing under test is
weakened — but say so in a comment, because it is not obvious.

Storage layout must match what the CLI itself builds. `resolveStorageConfig`
(`node-session.ts:18`) composes the path as `` `${config.path}/${strandId}` `` — a forward-slash
template, not `path.join`. **Import `resolveStorageConfig` from `../src/commands/node-session.js`
and use it to build the seed node's `storage`** rather than hand-rolling the path; that removes the
separator mismatch as a possible Windows-only failure and keeps the two in step by construction.

### Spawn helper

Spawn `process.execPath` with `[cliPath, ...args]`, where
`cliPath = fileURLToPath(new URL('../dist/bin/cadre.js', import.meta.url))`. Options: explicit
`cwd` (the temp dir), `windowsHide: true`. Collect `stdout`/`stderr` as utf8 strings — the
assertions match on `✓` and `⚠`, so decode explicitly rather than relying on the default. Resolve
`{ code, stdout, stderr }` on `close`; a `setTimeout` (≈90 s) must `kill('SIGKILL')` and **reject**
so a hung child fails the test by name rather than by the suite's wall clock. Reject on `error` too.

Why a child process rather than `parseAsync` in-process: the real exit code is observed instead of
inferred from a stubbed `process.exit` (exit codes are the security-relevant surface here —
`subcommand-wiring.spec.ts` says so, and a stub that lets execution continue past `process.exit` is
exactly the fidelity gap this ticket closes); real stdout/stderr separation, which the `--json`
assertions depend on; it covers `bin/cadre.js`'s own wiring; and no `withConnectedNode`-owned libp2p
node can leak into the vitest process.

### Timeouts

`packages/cadre-cli/vitest.config.ts` sets no `testTimeout`, so it is vitest's 5 s default. Give
each real-node test an explicit `120_000` (the cadre-core control-DB specs use 60–180 s). The
fake-node `withConnectedNode` tests need no override.

## Edge cases & interactions

Each of these is a test, or an explicit "not covered, because" line in the handoff:

- **Connect timeout** — the one branch with a documented crash hazard (the comment at
  `node-session.ts:95` explains why `start()` and the timeout are awaited *together*). Reach it with
  the fake `CadreNode`, never with a small `timeoutMs` against a real node (finding 4). Assert the
  rejection message (`Timed out after <n>ms connecting to the control network`), that the action
  never ran, and that `stop()` was still called.
- **No unhandled rejection when `start()` outlives the timer** — the hazard the `Promise.all` exists
  for. Two fake-node variants: `start()` resolves late, and `start()` *rejects* late, both after the
  timeout has already fired. Register a `process.on('unhandledRejection')` listener for the duration
  of the test and assert it never fired, then remove it in `finally`.
- **Teardown after a throwing action** — the `finally` must stop the node even when `action` throws;
  a leaked libp2p node hangs the vitest run. Assert `stop()` called and the action's error
  propagates unchanged.
- **`node.stop()` failing must not mask the action's error** — fake node whose `stop()` rejects and
  whose action also throws: the action's error is what propagates, and the
  `Warning: node did not shut down cleanly:` line is written to stderr.
- **Config resolution failures reach the operator as a `failure:` line + exit 1.** Spawned, cheap
  (no node boot), one test each: config file missing (`Config file not found`), unparseable YAML
  (a `.yaml` fixture such as `"{ unclosed"`), invalid `strandFilter` (e.g. `{}` → the
  `Invalid strandFilter …` message from `parseStrandFilter`), and `storage: { type: 'file' }` with
  no `path` (`Storage path is required for file storage type`, thrown by `resolveStorageConfig`).
- **Windows paths** — this repo runs on Windows. Build fixture paths with `path.join`, keep the
  child's `cwd` explicit, and let `resolveStorageConfig` own the one place a path is interpolated
  into a string.
- **Temp-directory cleanup survives a failing assertion** — `try`/`finally` with
  `rmSync(dir, { recursive: true, force: true })`; each test gets its own directory and party id, so
  the pair is not order-dependent.
- **Child-process hygiene** — explicit kill timeout, both streams captured, a hung child fails the
  test.
- **`process.exit` truncation** — `runSubcommand`'s comment (`subcommand.ts:61`) notes that
  `process.exit` does not flush a piped stdout, and a spawned child with piped stdio is exactly that
  case. The probe saw complete output at these sizes. If a `--json` listing ever comes back
  truncated, that is the real defect the comment predicted — report it, do not work around it in the
  test.
- **Parallelism** — `listenAddrs: []` means no port is bound, so these files need no
  `fileParallelism: false`. If a future test in this spec ever needs a listening node, it needs a
  port strategy first.

## TODO

### Phase 1 — build guard

- Add `{ packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js', location: 'workspace' }`
  to `TARGETS` in `packages/cadre-cli/test/global-setup.ts`, and extend that file's doc comment: the
  suite now also *spawns* this package's own compiled output, not only imports others'.
- Run the cadre-cli suite and confirm `build-targets.spec.ts` still passes unchanged (finding 5 says
  it will; verify rather than assume).

### Phase 2 — real-node spec (`packages/cadre-cli/test/one-shot-node.spec.ts`)

- Fixture helpers in the spec file: temp dir + fresh party id, identity key writer, config writer,
  and the spawn helper described above.
- **Read shape:** `strand list --json -c <config>` against a memory-storage solo config. Assert exit
  `0`, `JSON.parse(stdout)` → `[]`, and `stderr` contains `Connecting to control network...`.
  Comment why the split matters (`--json` must stay pipeable).
- **Destructive write shape:** seed `<dir>/blocks` in-process — construct a `CadreNode` with
  `resolveStorageConfig({ type: 'file', path: blocksDir })`, `start()`, `ensureOwnerKey(pub)`,
  `initializeSeedBootstrap(priv)`, `publishStrand(id, 'o')`, `stop()`. Then spawn
  `strand remove <id> --yes -c <config>`; assert exit `0` and `Strand removed` on stdout. Then
  re-open a node from the test process and assert `getControlDatabase()!.queryStrands()` no longer
  lists the id — **prove the removal at the database, not from the CLI's own success line.**
- Comment on the spec: genesis is required because a bare CLI node is not an owner, so an unseeded
  `strand remove` would fail authorization rather than exercise the write; and there is no CLI
  genesis command (`enroll register` is an offline signature check; genesis lives in
  `start --owner`).
- The four config-resolution failure tests from *Edge cases*.
- Per-test timeout `120_000` on every test that boots a node.

### Phase 3 — `withConnectedNode` branch spec (`packages/cadre-cli/test/node-session-branches.spec.ts`)

- Fake `CadreNode` (an `EventEmitter`-ish object with `on`, `start`, `stop`) swapped in via the
  `vi.mock('@serfab/cadre-core', importOriginal)` spread from finding 4. It needs a real config file
  on disk, since `resolveConfig` stays real.
- Tests: connect timeout; `start()` resolving late with no unhandled rejection; `start()` rejecting
  late with no unhandled rejection; action throws → `stop()` still called and the error propagates;
  `stop()` rejects while the action also throws → the action's error wins and the warning is
  written.

### Phase 4 — validate

- `yarn workspace @serfab/cadre-cli build` (the new spec spawns `dist`, and the guard now enforces
  it), then `yarn workspace @serfab/cadre-cli test 2>&1 | tee <scratch>/cli-test.log` — stream it,
  do not silently redirect.
- Run `yarn lint` and the package typecheck.
- Handoff must state: the accepted friction from phase 1 (a `src` edit without a rebuild now fails
  the whole cadre-cli suite), measured wall-clock added to the suite, and anything from
  *Edge cases & interactions* deliberately left uncovered, with the reason.
