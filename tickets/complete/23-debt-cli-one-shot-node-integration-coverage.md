description: The command-line tool's one-off commands are now tested against a real node, including the refusal that protects an unrecoverable key, plus the failure paths a real node can't produce. Reviewed, extended, and passing.
files: packages/cadre-cli/test/one-shot-node.spec.ts, packages/cadre-cli/test/node-session-branches.spec.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/commands/subcommand.ts, docs/STATUS.md
----

# Complete: one-shot CLI commands covered against a real node

Test-and-docs change. No production behaviour was altered at any stage.

## What landed

`withConnectedNode` (`packages/cadre-cli/src/commands/node-session.ts:74`) is the step every
one-shot `cadre` command shares — resolve the config file, start a `CadreNode`, wait for
`control:connected`, do one control-database operation, shut down. Before this ticket every spec
in the package stubbed it out, so a defect in config resolution, node construction or shutdown
passed the whole repo's suites and surfaced only for an operator.

**`test/one-shot-node.spec.ts`** — spawns the compiled `dist/bin/cadre.js` as a real child process
against a real solo `CadreNode` (`bootstrapNodes: []`, `listenAddrs: []`; `start()` emits
`control:connected` unconditionally, so a one-shot command needs no peers, and no node binds a
port). Seven tests:

- `strand list --json` → exit 0, `JSON.parse(stdout)` is `[]`, progress line on **stderr**.
- `strand remove <id> --yes` over an owner-signed seeded row → exit 0, and the row is **gone from
  a re-opened node's `queryStrands()`**, not merely reported gone.
- `strand remove <closed-id>` without `--yes` → exit **1**, the refusal on stderr, stdout empty,
  and the row **plus its `MemberPrivateKey`** still present afterwards. (Added during review.)
- Four config-resolution failures (missing file, unparseable YAML, uninterpretable `strandFilter`,
  `storage: file` with no `path`) → exit 1 plus the operator-facing message.

**`test/node-session-branches.spec.ts`** — the branches a real node cannot produce, over a fake
`CadreNode` injected with `vi.mock('@serfab/cadre-core', …)` that leaves `resolveConfig` and its
real key loading / `parseStrandFilter` unmocked. Seven tests: connect timeout, `start()` resolving
late, `start()` rejecting late, happy path, action-throws, `stop()`-fails-while-action-throws,
`stop()`-fails-alone.

**`test/global-setup.ts`** — `@serfab/cadre-cli` added to the stale-build `TARGETS`, since the
suite now spawns this package's own `dist`.

**`docs/STATUS.md`** — two stale claims corrected (see findings).

## Validation

| command | result |
|---|---|
| `yarn workspace @serfab/cadre-cli build` | clean |
| `yarn workspace @serfab/cadre-cli test` | **16 files, 177 tests passed**, 29.6s |
| `yarn workspace @serfab/cadre-cli typecheck` | clean |
| `yarn lint` (repo-wide, re-run after the review edits) | clean |
| `npx vitest run test/one-shot-node.spec.ts` (after the review edits) | **7 passed**, 17.9s test time |

Per-test cost after review: the two round-trip tests are 4.9s and 4.4s (each boots a seed node, a
spawned CLI and a verifier node); the other five are 1.7s each, nearly all child-process + libp2p
start-up. The added refusal test cost **+3.1s** of test time over the implement-stage baseline of
14.8s.

## Review findings

### Checked and clean

- **The implement-stage diff, read before the handoff summary.** Both spec files, `global-setup.ts`,
  and the sources under test (`node-session.ts`, `subcommand.ts`, `strands.ts`) — plus
  `subcommand-wiring.spec.ts` and `build-targets.spec.ts` for overlap.
- **Non-vacuity of the `strand remove` round trip.** The concern was that file-backed control state
  might not survive across processes, which would make "row absent afterwards" trivially true. It
  does survive, and the test proves it *itself*: `applyRemove` reads the row before writing and
  prints `• Strand not published — nothing to do` when it is missing, so the asserted
  `✓ Strand removed:` line is only reachable if the spawned CLI genuinely saw the seeded row.
- **Non-vacuity of the late-settle `unhandledRejection` watcher** — the ticket asked a reviewer to
  confirm it can actually fire. Verified by mutation: replacing
  `await Promise.all([node.start(), connected])` with `await node.start(); await connected;` fails
  **3 of the 7** branch tests and produces the real unhandled rejection, which the watcher records.
  Source reverted; `git diff` on `node-session.ts` is empty and the package was rebuilt.
- **The stale-build self-entry works.** Observed live: the mutation above caused
  `@serfab/cadre-cli: dist is stale` to block the branches spec — which also demonstrates the wider
  blast radius the handoff flagged (a `src` edit blocks even a `src`-importing spec). Judged
  correct, not a defect: a suite that runs `dist` must not report on yesterday's code, and
  `integration-tests` already carries the same tradeoff.
- **Indentation.** The two new files use spaces, matching 15 of the 16 specs in the package
  (`subcommand-wiring.spec.ts` is the tab-indented outlier). No change.
- **Resource cleanup.** Every node is stopped in a `finally`; `runCli` clears its kill timer on both
  `error` and `close`, and SIGKILLs + rejects a hung child so it fails by name.

### Found and fixed in this pass

- **Missing real-process coverage of the refusal exit code** — the file's own stated rationale is
  that a spawned child observes the real exit code instead of inferring it from a stubbed
  `process.exit`, yet the one path where the exit code carries security weight (refusing to destroy
  a closed strand's irrecoverable membership key) was covered only in `subcommand-wiring.spec.ts`,
  where `process.exit` *is* stubbed and execution continues past it. Added
  `refuses a closed strand without --yes, exits 1, and leaves the membership key intact`, which
  also proves the key survived by reading the row back from a re-opened node.
- **Duplication in `one-shot-node.spec.ts`** — six copies of the same
  `mkdtempSync` / `try` / `rmSync` block, and two hand-rolled node boot-and-stop blocks. Extracted
  `withTempDir`, `withSoloNode`, `seedStrands`, `strandRows` and `ownerCliConfig`; the file is
  shorter than before despite gaining a test. `withTempDir` also swallows a cleanup failure (as
  `protobuf-identity.spec.ts` already does), so a Windows handle released a moment earlier cannot
  fail a test whose assertions already passed.
- **`docs/STATUS.md` said the opposite of the new reality** in two places, both corrected: the
  strand-removal section still read "**Still not exercised against a real node:** no test stands one
  up"; and the stale-build-guard section described `cadre-cli`'s target list without the self-entry
  this ticket added.

### Recorded as tripwires, not tickets

- **`process.exit` can truncate a piped stdout.** Already documented as a `NOTE:` at the exact site
  (`packages/cadre-cli/src/commands/subcommand.ts:61`), and left there. It is genuinely conditional:
  Node's documented I/O table makes pipe writes **synchronous on Windows and Linux and asynchronous
  on macOS**, so truncation needs a large listing *and* macOS. Every one-shot command exits the same
  way, so a fix belongs across all of them rather than at one call site — which is what the existing
  NOTE says. No test pipes a large `--json` listing; if one is ever added and the output comes back
  short, that is the real defect, not a test to work around.

### Filed as tickets

None. The one remaining coverage gap — `validation-key add|remove|list` and `status` are covered
against a real node only through the shared `withConnectedNode` seam, not by spawning each command
— is a deliberate cost/value call, not a defect: the seam itself is now genuinely exercised, each
command's own wiring is covered over a fake node in `subcommand-wiring.spec.ts`, and the measured
price of closing it is ~1.8s per spawned command. Nothing about it needs a human decision, so it is
not `blocked/` either.

### Not in scope, unchanged

- **A networked, multi-node CLI test** stays rejected for the reasons the implement stage gave:
  `bootstrapNodes` reaches libp2p as peer discovery + autodial and nothing in `start()` waits for
  the dial, so a CLI read racing the dial reports "not published" for a row that exists — documented
  best-effort behaviour, so a test asserting against it would be flaky by construction. Transports
  would also mismatch (CLI configs get db-p2p's TCP + circuit-relay defaults; the `integration-tests`
  harness uses WebSockets). Cross-node CLI behaviour belongs in `integration-tests`.
- **`TIMEOUT_MS = 50` / `LATE_SETTLE_MS = 200`** in the branches spec kept as-is. The 4× margin on
  tests that do no I/O is adequate, and the mutation run confirmed the ordering they depend on is
  what actually distinguishes pass from fail.

### Out-of-band note

Mid-review the guard reported `@quereus/quereus: dist is stale`. That sibling checkout
(`../quereus`) has uncommitted in-flight edits from concurrent work; its dist was rebuilt with the
guard's own remedy command so the suite could run. Nothing in that checkout was otherwise touched.
