description: The documented way to run the operations test scripts does not work — the instructions tell you to run them through the package manager's workspace command, but that folder was never registered as a workspace, so every one of those commands fails.
files: ops/test/README.md, ops/test/package.json, package.json
repro: verified

## What happens

`ops/test/README.md` documents four invocations of the form:

```bash
yarn workspace @serfab/ops-test <script> -- <args>
```

Running any of them fails. Yarn prints "Usage Error: Couldn't find any workspace
named @serfab/ops-test" followed by the list of real workspaces, then the usage
banner. Verified by running:

```bash
yarn workspace @serfab/ops-test check-turn-creds -- --self-test
```

## Why

The root `package.json` declares `"workspaces": ["packages/*"]`. `ops/test/` has its
own `package.json` naming itself `@serfab/ops-test` and defining the scripts, but it
sits outside that glob, so Yarn never registers it. `yarn workspaces list` confirms:
no `ops` entry.

The scripts themselves are fine — they run directly:

```bash
node ops/test/check-turn-creds.mjs --self-test    # works, 16/16 checks pass
```

So this is purely a wiring/documentation mismatch, not a broken test.

## Expected behaviour

Either invocation form should work end to end, and the README should document a
form that does. Two directions, both plausible — this is a call for whoever picks it
up:

- **Register the folder as a workspace** (add `ops/test` to the root `workspaces`
  array). Makes the documented commands work as written, and pulls `ops/test` into
  whatever root-level tooling iterates workspaces — which may be desirable (it is
  currently outside `yarn lint` / `yarn typecheck`) or may be unwanted noise. Note
  that `ops/` is deliberately not app code.
- **Rewrite the README to the direct `node …` form.** Smaller blast radius, keeps
  `ops/` outside the workspace graph, but leaves `ops/test/package.json`'s `scripts`
  block as decoration.

Whichever is chosen, the four `yarn workspace` invocations in `ops/test/README.md`
must end up matching reality.

## Scope note

This is pre-existing and unrelated to the change that surfaced it (peer-bound TURN
issuance, `turn-issuer-peer-assertion`, which only edited prose in that README).
It is also **not** covered by `debt-tooling-scripts-unlinted-and-unchecked`, whose
`files:` scope is `eslint.config.mjs`, `docs/STATUS.md`, `scripts/`, and
`packages/*/scripts/` — nothing under `ops/`.
