description: The instructions for running the operations check scripts are wrong — every command in that folder's README fails, and three of the five scripts cannot run at all because their required libraries were never installed anywhere.
files: ops/test/README.md, ops/test/package.json, ops/test/relay-bootstrap-pair/listener.mjs, ops/test/relay-bootstrap-pair/dialer.mjs, tickets/backlog/debt-coturn-config-render-untested.md
repro: verified
difficulty: easy
----

# `ops/test` is a package nothing installs, documented with commands nothing runs

## What is broken

Two separate failures, one cause.

**1. Every documented invocation fails.** `ops/test/README.md` has **12** commands
(not four — recount below) of the form `yarn workspace @serfab/ops-test <script> -- <args>`,
at lines 16, 17, 18, 24, 30, 46, 65, 78, 108, 113, 126, 134. Two more of the same
shape are printed by the scripts' own `--help` text at
`ops/test/relay-bootstrap-pair/listener.mjs:19` and `dialer.mjs:19`. All 14 fail:

```
$ yarn workspace @serfab/ops-test check-turn-creds --self-test
Usage Error: Workspace '@serfab/ops-test' not found. Did you mean any of the following:
  - @serfab/cadre-cli
  ...
```

The root `package.json` declares `"workspaces": ["packages/*"]`. `ops/test/` sits
outside that glob, so Yarn never registers it. `yarn workspaces list` confirms: no
`ops` entry.

**2. Three of the five scripts cannot run under *any* invocation.** `ops/test/`
has no `node_modules` and no lockfile, and it is not a workspace, so its 12 declared
dependencies have never been installed by anything. The two scripts that work today
work only because they import nothing outside Node's standard library:

| script | imports | state |
|---|---|---|
| `check-turn-creds.mjs` | `node:crypto` | works |
| `check-stun.mjs` | `node:dgram` | works |
| `check-node.mjs` | libp2p + 9 others | **fails at import** |
| `relay-bootstrap-pair/listener.mjs` | libp2p + 11 others | **fails at import** |
| `relay-bootstrap-pair/dialer.mjs` | libp2p + 11 others | **fails at import** |

```
$ node ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@libp2p/ping'
  imported from C:\projects\sereus\ops\test\check-node.mjs
```

They resolve *some* imports by climbing into the root `node_modules`, which is an
accident of `nodeLinker: node-modules` hoisting and gives them the wrong major
versions anyway (root has `libp2p@3.1.3`; `ops/test` declares `^2.9.0`). Three
packages are not hoisted at all — `@libp2p/kad-dht`, `@libp2p/ping`,
`@libp2p/peer-id-factory` — and those are what the import error trips on.

So the source ticket's "the scripts themselves are fine — they run directly" holds
only for the two dependency-free ones it happened to test. **Rewriting the README
to `node …` alone does not fix this ticket** — it would leave three documented
scripts documented-but-dead.

## Why the fix is not "add `ops/test` to `workspaces`"

The source ticket framed this as an open two-way choice. It is not open — the repo
already recorded a position, in `tickets/backlog/debt-tooling-scripts-unlinted-and-unchecked.md`:

> Do not fold `ops/` into `workspaces` to get there — these are standalone
> deployables with their own dependency trees, deliberately not hoisted.

Three further facts point the same way:

- **`ops/test` is the odd one out, not the norm.** Six `package.json` files live
  outside `packages/*`. `ops/docker/turn-credential-issuer` and
  `ops/docker/libp2p-infra` declare dependencies and each carries its own
  `node_modules`, installed with `npm --prefix`. `tess` and `tess/ui` carry their
  own `package-lock.json`. `test-harness` declares zero dependencies and zero
  scripts. `ops/test` alone declares 12 dependencies with no install path at all.
- **The `node …` form is already the repo's convention.** Seven other documents
  invoke these exact scripts directly — `ops/docker/coturn/README.md:77`,
  `ops/docker/quickstarts/{bootstrap-relay,bootstrap,coturn,relay,turn-credential-issuer}.md`,
  `ops/docker/turn-credential-issuer/README.md:262` — all as
  `node sereus/ops/test/<script>.mjs`. Three of the scripts' own `--help` strings
  print that form too. Only `ops/test/README.md` uses `yarn workspace`.
- **Registering it would make two `NOTE:` comments stale and force a version
  choice.** `scripts/check-dep-ranges.mjs:48` and `scripts/lib/typecheck-programs.mjs:44`
  each say they scan `packages/` because that "is exactly the root `workspaces`
  globs today. If a second workspace glob is ever added, teach this to read
  `workspaces` instead." And a root install would either duplicate two libp2p
  majors in every developer's tree or force porting the scripts to libp2p v3
  (where `@libp2p/peer-id-factory`'s `createEd25519PeerId` no longer exists).

Note that registering it would **not** buy lint coverage, contrary to the source
ticket's guess: `eslint.config.mjs:55` globally ignores `ops/**`, and `eslint .` is
path-driven, not workspace-driven. Extending lint over `ops/` is
`debt-tooling-scripts-unlinted-and-unchecked`'s scope, not this ticket's.

## Target state

`ops/test` becomes a standalone npm project exactly like its two `ops/docker`
siblings, and its README documents forms that work. The pattern to mirror is
already in the tree at `ops/docker/turn-credential-issuer/README.md:254-255`:

```bash
npm --prefix sereus/ops/docker/turn-credential-issuer install
npm --prefix sereus/ops/docker/turn-credential-issuer run selftest
```

Applied here, the README's usage section becomes:

- **A one-time install step**, stated once near the top, before the first command
  that needs it: `npm --prefix sereus/ops/test install`. Mark plainly that only the
  libp2p-backed checks need it.
- **Dependency-free checks** (`check-turn-creds`, `check-stun`) stay callable with
  no install, in the `node sereus/ops/test/<script>.mjs …` form the other seven
  documents already use. `check-turn-creds --self-test` in particular must keep
  working from a bare checkout with no install — it is the agent-runnable one.
- **libp2p-backed checks** (`check-node`, `pair:listen`, `pair:dial`) become
  `npm --prefix sereus/ops/test run <script> -- <args>`. The `--` stays: npm needs
  it to forward arguments to the script.

Root `package.json` is **not** touched. `ops/test/package.json`'s `scripts` block
stops being decoration and becomes the thing `npm run` dispatches on.

## Verified: the declared dependency set installs as written

The v2-era ranges in `ops/test/package.json` are self-consistent and resolve
cleanly — no version bumps and no API porting needed:

```
$ npm --prefix ops/test install --dry-run --no-audit --no-fund
add libp2p 2.10.0
add @libp2p/kad-dht 15.1.11
add @libp2p/ping 2.0.37
add @libp2p/peer-id-factory 4.2.4
...
added 128 packages in 9s
```

The dry run leaves the working tree clean (`git status --porcelain` empty) and lists
a benign `add sereus-workspace 0.11.0` entry — the sibling `turn-credential-issuer`
dry run lists the same, so that is ordinary npm behaviour here, not a sign the
install reaches into the root tree. Confirm it for real anyway (TODO below).
`node_modules/` is ignored repo-wide (`.gitignore:1`), and neither sibling commits a
lockfile, so nothing new gets tracked.

## TODO

- Run `npm --prefix ops/test install` for real. Confirm afterwards that
  `git status --porcelain` shows nothing outside `ops/test/node_modules`, that root
  `yarn.lock` is unchanged, and that root `node_modules` gained nothing.
- Rewrite the usage blocks in `ops/test/README.md` — all 12 `yarn workspace`
  invocations (lines 16, 17, 18, 24, 30, 46, 65, 78, 108, 113, 126, 134) — to the
  `node …` / `npm --prefix … run …` split described above. Add the one-time install
  step. Keep every flag and argument in the existing examples byte-for-byte; only
  the invocation prefix changes.
- Fix the two `--help` strings that print the same broken form:
  `ops/test/relay-bootstrap-pair/listener.mjs:19` and `dialer.mjs:19`.
- Verify each of the five scripts actually starts under its newly documented form.
  `check-turn-creds --self-test` runs end to end (expect 16/16 checks). The other
  four need a deployed host or a second machine and are **not** agent-runnable —
  for those, confirm only that the process gets past module resolution and reaches
  its own argument parsing / network attempt, rather than dying at import.
- Grep the tree for any remaining `yarn workspace @serfab/ops-test` and confirm zero
  hits outside `tickets/`.
- Update the "Wiring note" at `tickets/backlog/debt-coturn-config-render-untested.md:49-58`.
  It defers to this ticket as "the open question about how `ops/` scripts should be
  invoked at all". That question is now answered — `ops/test` stays outside the
  workspace graph and installs standalone — so a coturn config test placed under
  `ops/` still will not be reached by root `yarn test`. Rewrite the note to say so
  and drop the "wait on that decision" option.
- Leave `ops/**` out of lint and typecheck. That is
  `debt-tooling-scripts-unlinted-and-unchecked`'s scope; do not widen into it here.
