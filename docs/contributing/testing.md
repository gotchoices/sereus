# Testing

How to run this repository's checks, which of them a ticket stage owes, the rules for running and reporting them, and the conventions for integration scenarios. Written first for an agent that is implementing or reviewing a ticket.

Related: [gates.md](gates.md) (what each check covers and what it cannot catch), [topology-coverage.md](topology-coverage.md) (which scenario covers which network shape), [releasing.md](releasing.md), [device-testing.md](device-testing.md).

## Commands

Run every command from the repository root. The scripts are defined in the root `package.json`.

| Command | What it runs | What it needs |
|---|---|---|
| `yarn build` | Every workspace's `build`, in dependency order. | `../optimystic` and `../quereus` checked out and built by their owners. |
| `yarn lint` | ESLint over the whole repository, then the documentation check (`yarn check:docs`). | A build, for the type-aware rule. |
| `yarn typecheck` | Every workspace's `tsc --noEmit`, then the three coverage checks described in [gates.md](gates.md#type-check-coverage). | A build: packages read each other's types from `dist`. |
| `yarn test` | Every workspace's Vitest suite, including the integration scenarios, then the unit tests of the scripts in `scripts/`. | A build no older than the sources, here and in the linked siblings. Free loopback ports. No internet access and no Docker daemon. |
| `yarn dep-check` | `knip`, then the declared-range check (`yarn check:dep-ranges`). | The sibling checkouts, to read their versions. |
| `yarn check` | `yarn lint`, `yarn build`, `yarn typecheck`, `yarn test`, `yarn smoke:published`, stopping at the first failure. | What each of those commands needs, plus the npm registry. |
| `yarn smoke:published` | Packs the publishable packages, installs them with npm into a scratch project and runs one scenario there. See [releasing.md](releasing.md#published-package-checks). | The npm registry. |
| `yarn check:published` | Runs build, lint, typecheck and test in a scratch worktree whose sibling packages come from npm. See [releasing.md](releasing.md#published-package-checks). | The npm registry, a clean working tree, and far longer than a ticket allows. |
| `yarn check:svelte` | `svelte-check` in `cadre-host` and `reference-app-web`. No other command runs it. | Nothing. |
| `yarn check:docs` | The documentation check alone: links, size limits and the scenario index. See [gates.md](gates.md#documentation). | Nothing. |
| `yarn lint:fix` | ESLint with its automatic fixes applied. | Nothing. |

`yarn dep-check` is not part of `yarn check`. Neither is `yarn check:published`.

To run less than the whole suite:

```bash
yarn workspace @serfab/cadre-core test                                        # one package
yarn workspace @serfab/integration-tests exec vitest run strand-formation     # files whose name contains the fragment
yarn workspace @serfab/reference-app-rn vitest run --project metro-babel      # one Vitest project
```

The integration suite runs one file at a time, because scenarios bind real ports. Do not pass `--reporter` to it: the flag removes the `NOT RUN` block described under [Tests that did not run](gates.md#tests-that-did-not-run).

## What a ticket stage must run

The stage rules are owned by [tess/agent-rules/tickets.md](https://github.com/gotchoices/tess/blob/main/agent-rules/tickets.md). This table restates what they require, as root commands:

| Stage | Owes before handing off |
|---|---|
| fix | A reproducing test case, or a trace when the failure is intermittent. |
| plan | Nothing. |
| implement | `yarn build` and `yarn test` pass. The rules also say to run tests and type checks (`yarn typecheck`) during this stage, not only at review. |
| review | `yarn lint` and `yarn test` are run and pass. |

The rules name no other command. Three facts decide whether a ticket runs one anyway:

- **`yarn dep-check` is the only command that reports an import of a package the importing workspace does not declare.** It is also the only one that reports an unused dependency, so a change that adds or removes a dependency, or edits `knip.ts`, is checked by nothing else.
- **The documentation check runs inside `yarn lint`,** which the rules require at review. An implement stage that edits a Markdown file outside `tickets/` and `tess/` can run `yarn check:docs` alone to find a broken link or an exceeded size limit before the reviewer does.
- **A command that routinely takes longer than about ten minutes is not run inside a ticket.** The rules say to skip it and record the deferral. That applies to a full `yarn check:published`; `yarn check:published --skip-gates` is the form short enough for a ticket.

`yarn check` and `yarn smoke:published` need the npm registry and are owed by a release ([releasing.md](releasing.md)), not by a ticket stage. No stage rule names an opt-in measurement or a device run either.

The ticket runner stops an agent whose command prints nothing for ten minutes. Run long commands in the foreground without redirecting their output; the rules file says where a log may be written.

## Rules for running tests

### Windows: start from an uppercase drive letter

On Windows, start every Vitest run from a working directory whose drive letter is uppercase (`C:\projects\sereus`). From a lowercase one (`c:\projects\sereus`, the form VS Code gives its terminals) Vitest loads a second copy of its runner, and every file of a run with two or more files fails at its first `describe` with "Vitest failed to find the runner". Changing directory inside the run does not help.

Each package's global setup refuses such a run and prints the path to start from (`assertUppercaseDriveLetter` in `test-harness/working-directory.ts`). In Git Bash, `cd /c/projects/sereus` gives the uppercase form; in PowerShell, `Set-Location 'C:\projects\sereus'` does.

### Windows: one sibling under two path spellings

The same failure as the rule above, from the other direction: one file loaded twice because two path strings lead to it. A junction stores the exact string it was created with, and Windows compares paths without regard to case, so `C:\Projects\optimystic\packages\db-core` and `C:\Projects\Optimystic\packages\db-core` are one directory under two spellings.

Node keys its module cache by the resolved string and keeps whichever spelling the junction stored, so a package reached under both is loaded twice. The two copies share no classes. Every `instanceof` across them is false, and an error thrown by one is not recognised by code that imported the other — which reads as a bug in this repository rather than in the install.

The two spellings come from two installs. Yarn writes this repository's junctions with the `link:` paths in the root `package.json`'s `resolutions` (`../optimystic`), while a sibling's own install writes its nested links relative to its own checkout (`C:\Projects\Optimystic`). Those nested links are inside the sibling and not ours to change. A spelling that disagrees with the disk is harmless as long as every junction agrees with every other one, so the check compares them against each other rather than against the disk.

Each package's global setup refuses such a run before anything is loaded (`assertOneSpellingPerLinkedPackage` in `test-harness/linked-package-spellings.ts`), naming each package, each spelling, each junction holding it, and the sibling checkout when one is involved. The remedy is to make every junction for that package store one spelling:

- **Only this repository's own junctions disagree:** repoint the odd ones out. Delete each non-recursively and recreate it against the spelling the others use; [tickets/rules/sibling-repos.md](../../tickets/rules/sibling-repos.md) says why a recursive delete is never used near these.
- **A junction inside a sibling checkout disagrees:** repoint this repository's junctions to the spelling the sibling uses, or rename the sibling's folder to match the `resolutions` paths, after which its owner reinstalls it because its nested links still store the old spelling. Never write in the sibling.
- **`yarn install` is not the remedy.** It rewrites every junction from `resolutions`, so they agree with each other and may still disagree with the nested links a sibling's own install wrote.

### A stale-build abort means stop

Every guarded suite aborts in global setup when a package it runs from `dist` has sources newer than its build. See [Stale-build guard](gates.md#stale-build-guard) for what is compared.

- **A workspace of this repository is stale:** run `yarn build` and start again.
- **A linked sibling is stale** (`../optimystic`, `../quereus`): stop. Do not build it. Its sources are being edited by its own owner, and building from here compiles unfinished work into what every suite in this repository runs against. A result obtained that way describes code nobody will publish. Record in the ticket that the work is blocked on the sibling's build. The rule is in [tickets/rules/sibling-repos.md](../../tickets/rules/sibling-repos.md).

While a sibling is stale, `yarn test` and `yarn check` fail without running a test. Work that does not load a sibling's `dist` can continue: `yarn lint`, `yarn dep-check`, the script unit tests (`yarn test:release-guard` and the other `test:*` root scripts), and the Vitest projects that carry no guard, which [gates.md](gates.md#checks-that-run-as-tests) lists.

A person, not an agent, may build a sibling after checking that it is idle and clean:

```bash
ls ../quereus/tickets/.in-progress ../optimystic/tickets/.in-progress   # absent = idle
git -C ../quereus status --short                                        # empty = between tickets
```

### Counting `NOT RUN`

Vitest counts every test under a failed `beforeAll` as skipped, so its `Tests` line shows no failure for them. The integration suite prints a `NOT RUN` block after the summary that names those tests. When quoting a result in a ticket, move the `NOT RUN` count from skipped to failed: `1 passed | 8 skipped` with `NOT RUN  7 tests` is 7 failed, 1 passed, 1 skipped.

A file that fails to import has no tests to name. It appears under `Failed Suites` and in `Test Files … failed`, and counts as a failed file.

### Failures that are not yours

A failing test is never skipped, commented out or loosened to get a green run. If the failure is unrelated to the change:

1. Look for the test in `tickets/.pre-existing-known.md`. An entry marked `in-flight` or `blocked` is tracked by the ticket it names: say in the handoff that the failure is known and continue. An entry marked `one-off` was diagnosed without a ticket: follow the check its record describes, and report only if the failure is back.
2. Otherwise write `tickets/.pre-existing-error.md` with the command, the failing test and the error, and finish the ticket. The runner triages it afterwards.

[tess/agent-rules/tickets.md](https://github.com/gotchoices/tess/blob/main/agent-rules/tickets.md) has the full procedure.

### Scratch worktrees and clones

To check a fresh install by hand, add the worktree or clone beside this repository, so that `../optimystic` and `../quereus` resolve for the root `resolutions`. For most purposes `yarn check:published` is the safer scratch copy, because it removes the links before it deletes anything. A worktree carries no submodule contents: `tess/` is created empty there, which is why documentation may not link into it ([Documentation](gates.md#documentation)).

Never delete such a checkout recursively while its `node_modules` holds `link:` junctions; [tickets/rules/sibling-repos.md](../../tickets/rules/sibling-repos.md) states the rule and what it protects. To remove one, find the junctions by walking the tree without following reparse points, unlink each with a non-recursive delete (`[System.IO.Directory]::Delete(<link>, $false)` in PowerShell), and only then remove the directory. If that is not possible, leave the checkout in place and say so in the ticket.

## Writing integration scenarios

Scenarios live in `packages/integration-tests/src/scenarios` and run real nodes over loopback. The harness is in `packages/integration-tests/src/harness`.

### The default is no new test

A ticket adds a test when the test reproduces the bug being fixed, at the lowest layer that reproduces it, or when it pins a named rule on logic with real branching. It does not add one for wiring, constants, or anything a type, a lint rule or a check script already enforces. A change that owes no test ships with none, and a reviewer removes tests that fail this bar. The rule is owned by "Tests must pay for themselves" in [tess/agent-rules/tickets.md](https://github.com/gotchoices/tess/blob/main/agent-rules/tickets.md). Before writing a scenario, check [topology-coverage.md](topology-coverage.md) for one that already boots the shape.

### Asserting a quantity that has to travel between machines

Assert a value that has to reach a second machine through a bounded wait, `waitUntil` from `harness/wait-utils.ts`, never through an immediate read.

- **Wait for each value separately.** Waiting for one value and then asserting a second in the next statement is a race the test created. Two values that converge independently are ready at different moments: a table and a secondary index over it are separate collections in the storage engine, so a converged row scan says nothing about when an index-backed count agrees.
- **Put every machine's view in the timeout message,** not only the view that failed. Whether the other machine holds what the failing one lacks distinguishes a lost write from replication that has not caught up.
- **Print the delay when a pass had to wait,** so a convergence that slows from milliseconds to tens of seconds is visible in the output. Do not assert on the delay without a measured baseline.

`strand-formation-concurrent-redemption.integration.ts` shows all three.

The converse: once a test has waited for a quantity on a node, a later read of the same quantity on the same node needs no second wait. A count that only grows and was observed at two is still at least two. A wait there cannot change the outcome and reserves its whole budget against the test's timeout. Leave the bare read, with a comment saying why it is sound.

### Stopping a node its own background writes are still running on

A node publishes its own address record shortly after `start()`, as a background write to the control database. If a member of the control cohort stops while that write is committing, the write is torn, and a node restarted over the same store can have its next write refused with `CoordinatorStaleLossError … stale conflict` (ticket `forked-control-collection-sync-livelocks`).

A scenario that stops nodes within seconds of starting them therefore waits for each node's publish first:

```ts
await waitUntil(async () => (await member.registerSelf()) !== 'skipped', {
	timeoutMs: 30_000,
	intervalMs: 250,
	description: 'B publishes its own address record',
});
```

`registerSelf()` joins a publish already in flight, or makes one. `control-delete-while-alone-convergence.integration.ts` does this before stopping its pair.

### Owner keys in integration scenarios

A test owner key is generated on its own and is never the key behind a node's peer id, as [owner-keys.md](../cadre/owner-keys.md#what-an-owner-key-is) describes. `createTestOwnerKey()` in `harness/owner-key.ts` returns a `TestOwnerKey`: the public key, the seed and a software signer. The party fixtures, `bootControlTrio` and `bootTopology` all hold keys made this way.

- **`makeOwnOwner(node, label?)`** generates a key, inserts it as the party's first `OwnerKey` row, wires it with `useOwnerSigner` and returns it. It throws if the generated key is the key behind the node's peer id.
- **An owner restarted over its store wires the signer again.** The store keeps the `OwnerKey` row but not the private key, so the scenario keeps the returned `TestOwnerKey` and calls `useOwnerSigner` after `start()`.
- **A second owner machine gets its own key.** `startPinningMember(…, { ownerKey })` wires it, and the first owner seats it with `addOwner(ownerKey.publicKey)`.
- **A machine admitted by a cadre invitation holds no owner key.** A scenario whose joined machine must be an owner gives it a key of its own and seats that key with an owner grant (`joinWithOwnerGrant`, or `redeemOwnerGrant` on a member).

A scenario that signs a machine's own peer record with that machine's libp2p key is binding an identity, not creating an owner key, and that use is correct.
