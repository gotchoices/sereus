description: The test suite can only be run one way — against working copies of two sibling projects sitting next to this one on the developer's disk. Make the suite also runnable against the versions users actually download, and add a documented command that does it.
prereq: yarnrc-non-secret-settings-not-committed
architecture: docs/testing.md
files: test-harness/build-targets-spec.ts, test-harness/build-targets.ts, test-harness/build-freshness.spec.ts, packages/*/test/build-targets.spec.ts, scripts/, package.json, docs/testing.md
difficulty: medium
----

# Let the suite run against the published dependency packages

## Background

Root `package.json` has a `resolutions` block that redirects every `@optimystic/*` and `@quereus/quereus` import to a working copy in a sibling folder — `link:../optimystic/...`, `link:../quereus/...`. Every suite in this repository therefore tests against whatever is in those two folders right now, which is another project's checkout, often with another person's uncommitted edits in it. It is not what this repository declares as its dependency range, and it is not what a user gets from the package registry.

`yarn smoke:published` already covers a different half of that gap: it packs this repository's own publishable packages, installs them into a scratch project outside the repo, and runs one scenario. What has never been possible is running *this repository's own suites* against registry copies of the two sibling projects.

## What was measured (2026-09-24, HEAD `be09fe3b`)

A detached worktree was added outside the repository, its `resolutions` block deleted, and `yarn install` run — resolving `@optimystic/*` to 1.5.0 and `@quereus/quereus` to 4.19.4 from the registry. The `@serfab/*` packages were then built and the suites run.

**The only failures were the three assertions that require the siblings to be linked.** Everything else passed:

| what was run | result |
| --- | --- |
| `@serfab/cadre-core`, whole suite (138 files) | 2270 passed, 1 failed — `test/build-targets.spec.ts > are checked against dependencies that were actually found` |
| `@serfab/quereus-plugin-sereus`, whole suite (10 files) | 112 passed, 1 todo, 1 failed — the same `build-targets.spec.ts` assertion |
| `test-harness/build-freshness.spec.ts` | 2 failed — both cases in `describe('node_modules chain, on this checkout')` |
| `integration-tests/test/build-targets.spec.ts` | 1 failed — the same assertion again |
| `control-write-degraded-cohort-member`, `control-cohort-edge-carries-data`, `control-stream-authz` | 10 passed |
| `relay-only-control-addr` | 5 passed |

**This supersedes the failure list in the ticket this one came from.** That list was taken on 2026-09-23 against sereus `6b238976` with `@optimystic/*` at 1.4.0, and described 21 failures: three by-design ones, eight in `cadre-core` where a storage wrapper failed to recognise a class the test had constructed, and nine network scenarios. The eight and the nine no longer happen. In between, `b8e805eb` raised the `@optimystic/*` floors from `^1.4.0` to `^1.5.0`, so the de-linked install now resolves 1.5.0 instead of 1.4.0 — the likeliest explanation, but not proven: nobody re-ran the old failures against 1.4.0 to confirm the version is what moved them.

Two attempts to reproduce the storage-wrapper failure at HEAD both came back green, and are worth recording so nobody repeats them: a miniature Yarn workspace pairing a symlinked package with a registry copy of `@optimystic/db-p2p`, and the de-linked worktree above, first with only two workspaces installed and then with all of them. In the full de-linked worktree the only copies of `@optimystic/db-p2p` outside the root `node_modules` are the three under the reference apps, which declare `installConfig.hoistingLimits: "workspaces"` and so get their own; `cadre-core` resolves the root copy, and so does the plugin.

So **there is no product defect left to chase here.** What remains is the three assertions and the missing command.

**Not covered by the measurement:** the full `integration-tests` suite was not run (only the four scenario files the old ticket named), nor were the `cadre-cli`, `cadre-host`, `cadre-provider` or reference-app suites. Expect the four remaining `build-targets.spec.ts` files to fail the same way, and treat anything else that turns up as new information rather than as a regression from this work.

## Arm 1 — the assertions that hard-code "linked"

One root cause, two files. Both assert that a dependency resolves through a symlink to a working copy, which is true only when the `resolutions` block is in place. Neither is a defect; both are simply written as though linking were the only install shape.

**`test-harness/build-targets-spec.ts`**, in `describeBuildTargets`, the case `are checked against dependencies that were actually found`:

```ts
for (const [name, origin] of Object.entries(expectFound)) {
    expect(found.get(name), name).toBe(origin);
}
```

`found` comes from `distBackedDependencies`, which classifies a dependency as `'workspace'` or `'linked'` and omits everything from the registry — because a registry copy's file timestamps are packing artifacts and judging its freshness would report a staleness nobody can fix (`test-harness/build-targets.ts` header). That omission is correct. The assertion just is not written for it, so a de-linked install gets `expected undefined to be 'linked'` in all seven consuming packages.

`expectFound` exists to stop the *other* assertion in that suite from passing vacuously: `targetListProblems` returning an empty array proves nothing if the scan turned up nothing to check. So it cannot simply be relaxed to "absent is fine" — `packages/quereus-plugin-sereus/test/build-targets.spec.ts` pins two names and *both* are `'linked'`, so under a blanket relaxation that suite would assert nothing at all.

Recommended shape — decide the expectation from the root manifest, and keep a real assertion on both branches:

- Read whether the repo root's `resolutions` names this dependency with `link:`. `test-harness/build-targets.ts` already computes exactly that in its private `linkedResolutions(packageDir)`; export it, or lift it to a small shared helper both spec files import.
- **Linked:** assert `found.get(name) === 'linked'`, as today.
- **Not linked:** assert `found.get(name) === undefined` *and* that the dependency is nonetheless installed — `resolveLinkedPackageFrom(packageDir, name)` returns `{ status: 'not-linked' }` for a registry directory and `{ status: 'absent' }` when there is nothing there at all. Asserting `'not-linked'` is what keeps the case honest: a misspelled name in `expectFound` still fails.
- Leave the seven `expectFound` blocks as they are. They describe what the repository intends, and the spec helper decides what that means for the install in front of it.

**`test-harness/build-freshness.spec.ts`**, `describe('node_modules chain, on this checkout')` — two cases that assert `resolveLinkedPackageFrom(...)` returns `{ status: 'linked', root }` against the real `reference-app-web` install. Same treatment, via the same helper: when the siblings are not linked, both calls return `{ status: 'not-linked' }` (confirmed in the measurement above) and that is what to assert.

Be honest about what that costs in a comment at the site: on the not-linked branch the return value no longer says *which* `node_modules` answered, so the walk itself is pinned only by the temp-directory fixture in the `describe('node_modules chain')` block above it. That is acceptable — the fixture is what pins the algorithm; these two cases pin that a real Yarn install produces the layout the algorithm expects, and when nothing is linked there is no such layout to pin.

## Arm 2 — the command that runs it

Add `yarn check:published`, a script under `scripts/` that builds the de-linked worktree and runs the gates in it. Shape, following the procedure that was actually executed for the measurement above:

1. **Refuse a dirty tree, or warn loudly.** The worktree is built from `HEAD`, so uncommitted work is not what gets checked. An `--allow-dirty` escape hatch is fine; silently checking something other than what the developer has in front of them is not.
2. `git worktree add --detach <os-temp-dir>/... HEAD`. **Outside the repository**, for the same reason `scripts/smoke-published-install.mjs` puts its scratch project there: inside, the root `workspaces` glob and the ESLint config would both start seeing it.
3. In the worktree, delete the `resolutions` key from `package.json`. Change nothing else.
4. `yarn install --no-immutable`. Dropping `resolutions` necessarily rewrites the lockfile, and Yarn makes installs immutable by default when `CI` is set — without the flag this fails in exactly the environment the check is most wanted in.
5. `yarn build`, then `yarn lint`, `yarn typecheck`, `yarn test`.
6. Report the resolved version and path of each `@optimystic/*` and `@quereus/*` package, the way `smoke-published-install.mjs` already does for its scratch project — the point of the run is which artifacts were tested.
7. Remove the worktree; `--keep` to retain it for debugging. **On Windows `git worktree remove --force` fails with `Filename too long` on deep `node_modules` paths** — observed on this machine during the measurement. It de-registers the worktree but leaves the files, so the script needs a long-path delete as a fallback followed by `git worktree prune`.

**Do not run `yarn smoke:published` inside the worktree.** It packs this repository's own tarballs into its own scratch project outside the repo and never sees `resolutions` at all, so running it there measures nothing the main tree has not already measured.

**Not a gate, and not agent-runnable.** It needs the network and it is slow. Measured on this machine with a warm Yarn cache: the install took 51.8s, the `cadre-core` suite 109.1s, four integration scenario files 283.8s between them. The full `integration-tests` suite and the reference-app suites were not run, so the total is unmeasured — but it is plainly many minutes, which puts it past the ten-minute ceiling a ticket agent can sit through. Document it as a release step beside `yarn smoke:published` and leave whether it runs before a release to the maintainer.

**Follow the conventions the other root scripts already set.** Every `scripts/check-*.mjs` and `scripts/release-*.mjs` has a `node --test` sibling wired into the root `test` script (`test:dep-ranges`, `test:release-guard`, and the rest), with the decisions it makes about the repo lifted into `scripts/lib/` and unit-tested there while the orchestration stays in the script. Do the same: pin the decisions — which keys get stripped from the worktree manifest, which flags the install gets, how the report is assembled — and do not write a test that drives the worktree itself, which is the thing that takes minutes and needs the network.

## Docs

`docs/testing.md` is the owner. It already has `## Declared dependency range vs linked workspace (keep them equal)` and `## Installing what a customer installs — yarn smoke:published (a release step, not a test)`; the new check is a third face of the same subject and belongs next to them. State what it covers that the other two do not — the repository's own suites, against registry copies of the siblings — that it is not a gate, and what a failure in it means. The document's opening paragraph enumerates the gates and the one non-gate release check; update that sentence too.

## Notes for whoever runs this

- During the de-linked install Yarn reported `cpu-features@0.0.10 couldn't be built successfully (exit code 1)` and carried on. It is an optional native dependency of `ssh2` and the runs were unaffected. Do not chase it, and do not let the new script treat it as a failure.
- The two log files from the measurement are in `tickets/.logs/debt-tests-only-valid-against-linked-optimystic.*.log` (git-ignored, pruned automatically).

## TODO

- [ ] Export `linkedResolutions` from `test-harness/build-targets.ts`, or lift it into a small helper the two spec files share, so both can ask "does the root manifest link this name?"
- [ ] Rework the `are checked against dependencies that were actually found` case in `test-harness/build-targets-spec.ts` to assert `'linked'` when the root manifest links the name, and `undefined` plus an installed `{ status: 'not-linked' }` when it does not.
- [ ] Give the two `node_modules chain, on this checkout` cases in `test-harness/build-freshness.spec.ts` the same treatment, with a comment saying what the not-linked branch can no longer observe.
- [ ] Leave the seven `packages/*/test/build-targets.spec.ts` `expectFound` blocks unchanged; confirm all seven still pass in the linked tree.
- [ ] Add `scripts/check-published.mjs` and wire `yarn check:published`, with its decision helpers in `scripts/lib/` and a `node --test` sibling registered in the root `test` script.
- [ ] Make the script handle the Windows `Filename too long` worktree removal, falling back to a long-path delete and `git worktree prune`.
- [ ] Run `yarn check:published` end to end once, from a committed HEAD, and record in the review handoff what it found — including the suites the measurement above did not cover.
- [ ] Update `docs/testing.md`: the new section, and the opening sentence that enumerates the gates and the release check.
