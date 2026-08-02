description: The command-line tool's one-off commands are never tested against a real running node. Part of that test coverage is now written but has not been run once; the rest is still missing.
files: packages/cadre-cli/test/one-shot-node.spec.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/test/subcommand-wiring.spec.ts, packages/cadre-cli/vitest.config.ts
difficulty: medium
----

# Cover the CLI's one-shot commands against a real node (continuation)

A prior run hit its token budget partway through. **Phases 1 and 2 of the original ticket are
written; nothing has been executed yet.** Everything below is what remains, plus the state to
verify before trusting what landed.

## What already landed (unvalidated — no test, lint or build has been run)

### `packages/cadre-cli/test/global-setup.ts`

Added `{ packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js', location: 'workspace' }`
as the first entry of `TARGETS`, and extended the file's doc comment to say the suite now also
*spawns* this package's own compiled output.

`build-targets.spec.ts` needs no carve-out for this and was deliberately not touched:
`targetListProblems` (`test-harness/build-targets.ts:41`) only reports dependencies that are
*missing* from the list or listed under the wrong location — extra entries are explicitly
supported, and a package is never its own dependency, so the self-entry is invisible to the
coverage check. The "name each package once" assertion is satisfied by a single entry. **Verify
this by running the suite rather than assuming it.**

Accepted cost, already written into the doc comment and to be repeated in the handoff: from now
on an edit to `packages/cadre-cli/src` with no rebuild fails the **whole** cadre-cli suite,
including specs that import `src` directly and never touch `dist`. Same tradeoff
`integration-tests` already carries. Editing a spec does not trip it — `test/` is excluded from
the source scan (`SOURCE_EXCLUDE_DIRS` in `test-harness/build-freshness.ts:86`).

### `packages/cadre-cli/test/one-shot-node.spec.ts` (new)

Spawns the real `dist/bin/cadre.js` as a child process. Contains:

- **Read shape** — `strand list --json -c <config>` against a memory-storage solo config
  (`profile: transaction`). Asserts exit 0, `JSON.parse(stdout)` → `[]`, and
  `Connecting to control network...` on **stderr** (the `--json` pipeability contract).
- **Destructive write shape** — seeds `<dir>/blocks` in-process with a directly-constructed
  `CadreNode` (genesis via `ensureOwnerKey` + `initializeSeedBootstrap`, then `publishStrand`),
  pins that the row is really there, spawns `strand remove <id> --yes`, asserts exit 0 and
  `✓ Strand removed: <id>` on stdout / `Removal is party-wide` on stderr, then **re-opens a node
  and asserts the row is gone from `queryStrands()`** rather than trusting the CLI's own line.
- **Four config-resolution failure tests** — missing config file, unparseable YAML, invalid
  `strandFilter` (`{}`), and `storage: { type: 'file' }` with no `path`. Each asserts exit 1 and
  the operator-facing message.
- Helpers: per-test temp dir + fresh party id, protobuf identity writer, JSON config writer, and
  a `runCli` spawn helper with a 90 s SIGKILL-and-reject guard, explicit `cwd`, `windowsHide`,
  and utf8-decoded stdout/stderr captured separately.
- Explicit `120_000` timeout on each node-booting test (the package sets no `testTimeout`, so the
  default is vitest's 5 s), `60_000` on the config-failure tests.

Storage for the seed node is built by importing `resolveStorageConfig` from
`../src/commands/node-session.js`, not hand-rolled — that helper composes the per-strand
directory as `` `${path}/${strandId}` `` (forward-slash template, not `path.join`), so restating
it would risk a Windows-only mismatch.

## Facts established by earlier planning probes — do not re-derive

1. **`control:connected` means "started", not "has a peer".** `CadreNode.start()` emits it
   unconditionally at the end of start (`packages/cadre-core/src/cadre-node.ts:697`), so a solo
   node with `bootstrapNodes: []` satisfies `withConnectedNode`'s wait. No network needed.
2. **The control database survives across processes on the same `FileRawStorage` directory**
   (same protobuf identity key, same party id). Observed: phase-one process did genesis +
   `publishStrand`; a separate phase-two process read the row back and removed it.
3. **Both CLI shapes already worked end to end when spawned**, with exactly the outputs asserted
   above (`"[]\n"` on stdout for the read; `"✓ Strand removed: probe-strand-cli\n"` for the write).
4. **A tiny `timeoutMs` does NOT reach the timeout branch against a real node.** Tried 0, 1, 5, 20
   and 60 ms — every one ran the action (total elapsed 115–185 ms), because `start()` completes
   without the event loop returning to the timers phase. Cover that branch with a fake node only.
5. **A seed node reached over the network is the wrong shape.** `bootstrapNodes` reaches libp2p as
   peer discovery + autodial and nothing in `start()` waits for the dial, so the CLI's read would
   fire first and report "not published" for a row that exists — a flaky test asserting against
   documented best-effort behaviour. Transports would also mismatch: a CLI-configured node gets
   db-p2p's TCP + circuit-relay defaults (`CliConfigFile.network` has no transports knob), while
   the integration harness's `controlNodeConfig` uses WebSockets.

## TODO

### Phase 3 — `withConnectedNode` branch spec (`packages/cadre-cli/test/node-session-branches.spec.ts`, NOT YET WRITTEN)

Swap only the node class, keeping `resolveConfig` (and its real `validatePushCredentials`
dependency) intact:

```ts
vi.mock('@serfab/cadre-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@serfab/cadre-core')>()),
  CadreNode: FakeCadreNode,
}));
```

The fake needs `on`, `start`, `stop` only. Because vitest hoists `vi.mock` above the imports, the
fake's mutable behaviour has to be reachable from the factory at call time — use `vi.hoisted()`
for the shared handle (the pattern `subcommand-wiring.spec.ts` already uses for `session.node`),
and import the module under test with a top-level `await import('../src/commands/node-session.js')`.
Each test still needs a real config file on disk (a temp `cadre.json` with
`storage: { type: 'memory' }` is enough), since `resolveConfig` is not mocked.

Tests to write:

- **Connect timeout** — `start()` never settles and `control:connected` never fires. Assert the
  rejection is `Timed out after <n>ms connecting to the control network`, the action never ran,
  and `stop()` was still called.
- **`start()` resolves late, after the timer already fired** — the real regression guard for the
  `Promise.all` at `node-session.ts:98` (its comment explains why start and the timeout are
  awaited together: awaiting them in sequence leaves the timeout's rejection unhandled, and Node
  turns that into a process crash). Register a `process.on('unhandledRejection')` listener for the
  duration of the test, wait past the late settle, assert it never fired, and remove the listener
  in `finally`.
- **`start()` rejects late** — same shape, same assertion.
- **Action throws** — `stop()` is still called and the action's error propagates unchanged.
- **`stop()` rejects while the action also throws** — the action's error is what propagates, and
  `Warning: node did not shut down cleanly:` is written to stderr.

### Phase 4 — validate (NOTHING HAS BEEN RUN)

- `yarn workspace @serfab/cadre-cli build` first — the new spec spawns `dist`, and the guard added
  in phase 1 now enforces freshness for this package too.
- `yarn workspace @serfab/cadre-cli test 2>&1 | tee <scratch>/cli-test.log` — **stream it**, never
  silently redirect (the runner kills on a 10-minute idle timeout).
- Confirm `build-targets.spec.ts` still passes unchanged with the new self-entry.
- `yarn lint` and `yarn workspace @serfab/cadre-cli typecheck`.
- Expect to have to adjust `one-shot-node.spec.ts` on first run — it has never executed. Likely
  friction points, in order: the `profile: 'transaction'` + `storage: { type: 'memory' }` pairing
  in the read test (switch to `profile: 'storage'` if it complains); whether `enableRelay`'s
  storage-profile default does anything awkward with `listenAddrs: []` (add
  `enableRelay: false` to the network block if so); and the exact `js-yaml` failure wording,
  which the spec deliberately does not assert on.

### Handoff must state

- The accepted phase-1 friction: a `src` edit without a rebuild now fails the whole cadre-cli suite.
- Measured wall-clock added to the suite by the new specs.
- Anything from the original ticket's *Edge cases & interactions* left uncovered, with the reason.
  Known candidate: `process.exit` truncation of a piped stdout (`subcommand.ts:61`). The probes saw
  complete output at these sizes; if a `--json` listing ever comes back truncated, that is the real
  defect the comment predicts — report it, do not work around it in the test.
