description: The operations check scripts folder now installs as a standalone project and every place the repo documents how to run those scripts says the same, correct thing — previously the documented commands failed outright.
files: ops/test/README.md, ops/test/relay-bootstrap-pair/listener.mjs, ops/test/relay-bootstrap-pair/dialer.mjs, ops/docker/quickstarts/relay.md, ops/docker/quickstarts/bootstrap.md, ops/docker/quickstarts/bootstrap-relay.md, ops/docker/quickstarts/coturn.md, ops/docker/quickstarts/turn-credential-issuer.md, ops/docker/coturn/README.md, ops/docker/turn-credential-issuer/README.md, .gitignore, tickets/backlog/debt-package-manifest-with-no-install-path.md
----

# `ops/test` is a standalone npm project; every doc that invokes it now agrees

## What the work was

`ops/test/` sits outside the root `workspaces: ["packages/*"]` glob, so it was never
a Yarn workspace — yet its README documented all 14 of its commands as
`yarn workspace @serfab/ops-test <script>`, which fail immediately. Three of the five
scripts (`check-node.mjs`, `relay-bootstrap-pair/listener.mjs`,
`relay-bootstrap-pair/dialer.mjs`) also had no install path at all: their twelve
libp2p dependencies were declared but never installable, so even a corrected command
died at `ERR_MODULE_NOT_FOUND`.

The resolution keeps `ops/test` outside `workspaces` and makes it a standalone npm
project installed with `npm --prefix`, mirroring `ops/docker/turn-credential-issuer`
and `ops/docker/libp2p-infra`. The generalisation of the underlying class — nothing
in the repo checks that a declared dependency has *any* install path — was filed
separately during the fix stage as `debt-package-manifest-with-no-install-path`.

## Final shape

- One install step: `npm --prefix sereus/ops/test install`.
- One invocation form for all five scripts: `node sereus/ops/test/<script>.mjs <args>`.
  After the install, Node resolves libp2p from `ops/test/node_modules` for the three
  scripts that need it, so no `npm run` indirection and no `--` separator are needed.
  This is the form already used by every other ops doc and by every script's own
  `--help`.
- Every ops document that invokes one of these scripts now states that its commands
  are written from an **ops root** — the directory holding the git clone, named
  `sereus` in the examples (the layout in `ops/docker/README.md`). Readers working
  inside the repo drop the leading `sereus/`.
- `ops/test/package.json` was not changed: its `scripts` block was already correct,
  and it stays as the convenient way to run a check from inside the directory.
- The root `package.json` was not changed; `ops/` remains outside `workspaces`,
  outside `yarn lint` (`eslint.config.mjs` ignores `ops/**`), and outside `yarn test`.

## Review findings

The implement-stage diff was read before its handoff summary. Everything below was
resolved in this pass; **no new tickets were filed**, because every finding resolved
at a site inside this ticket's own scope rather than pointing at unsettled work.

### Fixed in this pass

- **The README's location claim contradicted its own commands.** The implement pass
  rewrote every command to the ops-root form (`sereus/ops/test/...`) but left the
  heading "From the repo root". From the repo root, `npm --prefix sereus/ops/test
  install` fails with a path-not-found error — the same defect the ticket set out to
  remove, reintroduced in a new form. The Usage section now names the ops-root
  convention and gives the repo-root equivalent.
- **Two invocation forms for no reason.** The implement pass used
  `npm --prefix sereus/ops/test run <script> -- <args>` for the three libp2p scripts
  and `node sereus/ops/test/<script>.mjs <args>` for the two standard-library ones.
  Verified that plain `node` works for all five once the install has run, so the split
  bought nothing and made the README disagree with three quickstart docs and with
  `check-node.mjs --help`. Unified on the `node` form throughout.
- **The two `--help` strings the implement pass edited were moved to the one form the
  other three scripts do not use.** `listener.mjs` and `dialer.mjs` now print
  `node sereus/ops/test/relay-bootstrap-pair/<file>.mjs`, matching `check-node`,
  `check-stun`, and `check-turn-creds`.
- **Three quickstarts documented commands that fail.** `quickstarts/relay.md`,
  `quickstarts/bootstrap.md`, and `quickstarts/bootstrap-relay.md` each said "From the
  repo root:" above a `sereus/`-prefixed `check-node.mjs` command *and* omitted the
  install, so following them produced `ERR_MODULE_NOT_FOUND`. These were untouched by
  the implement pass — the fix stopped at `ops/test/` and missed the callers. All
  three corrected, with the one-time install named inline.
- **Four more ops documents invoked these scripts without saying where from.**
  `quickstarts/coturn.md`, `quickstarts/turn-credential-issuer.md`,
  `ops/docker/coturn/README.md`, and `ops/docker/turn-credential-issuer/README.md`
  now carry the same ops-root line, so the whole family reads consistently.
- **The README still opened with "Small, dependency-free scripts"** two lines above a
  new dependency-install step. Corrected.
- **The lockfile question was left open by the implement pass** ("worth a follow-up
  decision — I did not file a ticket"). Resolved here rather than deferred: `npm
  install` in `ops/test` regenerates `package-lock.json`, nothing ignored it, and it
  was deleted by hand once. `.gitignore` now ignores `ops/**/package-lock.json` —
  the class, not the instance, since both `ops/docker` npm projects have identical
  exposure. This matches the observed convention: `git ls-files` shows `yarn.lock` as
  the only tracked lockfile in the repo, and neither `ops/docker` sibling has an npm
  lockfile on disk.
- **`debt-package-manifest-with-no-install-path` had gone stale on landing.** It lists
  the standalone-`npm --prefix` install path as covering exactly
  `ops/docker/turn-credential-issuer` and `ops/docker/libp2p-infra`; a checker written
  from that list would reject `ops/test` the day it was written. Added `ops/test` to
  the list, plus a line under the survey table recording that the defect row has since
  been repaired.

### Recorded as a tripwire, not a ticket

- `ops/` npm projects install from caret ranges with no lockfile, so a check can drift
  without anyone editing it. Fine today for diagnostic tooling, and committing
  lockfiles would contradict the existing convention. Parked as a `NOTE:` beside the
  new `.gitignore` rule, with the revisit condition: a check failing for reasons
  nobody changed.

### Checked, nothing found

- **Script behaviour.** No runtime code changed. The only `.mjs` edits are inside the
  `--help` template literals; both were run to confirm.
- **Remaining stale references.** `grep -rn "yarn workspace @serfab/ops-test"` across
  the repo returns hits only inside this ticket's own prose.
- **`docs/`.** No file under `docs/` documents an `ops/test` invocation, so nothing
  there needed updating. `docs/testing.md` mentions `ops/` only to record that it is
  excluded from the type-check and lint sweeps, which is still true.
- **Root manifest and lockfile.** `package.json` and `yarn.lock` are untouched;
  `ops/test` deliberately stays outside `workspaces`, per the decision already
  recorded in `debt-tooling-scripts-unlinted-and-unchecked`.

## Verification performed

- `yarn lint` — clean (exit 0). `ops/**` is globally ignored by `eslint.config.mjs`,
  so this diff has no lint surface; run to confirm nothing else regressed.
- All seven root-level gate suites pass: `test:dep-ranges`,
  `test:published-smoke-support`, `test:publish-package`,
  `test:vitest-typecheck-coverage`, `test:test-file-typecheck-coverage`,
  `test:stale-build-guard-wiring`, `test:release-preflight` — 110 tests, 0 failures.
- All five scripts run under the newly documented form:
  - `node ops/test/check-turn-creds.mjs --self-test` → 16/16 checks pass.
  - `node ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay` → live
    end-to-end success against the deployed relay (connect, identify, ping 113 ms,
    "relay check: ok").
  - `check-stun`, `listener`, `dialer` → `--help` renders the corrected form and
    exits 0. `check-stun` and the TURN `--url` live-check mode still need a deployed,
    publicly reachable server and remain not agent-runnable — unchanged, and still
    documented as such.
- `git status --porcelain` clean apart from the twelve intended modifications; no
  lockfile, no stray artifacts. Verified the new `.gitignore` rule actually catches
  `ops/test/package-lock.json`.

### Not run, and why

The full workspace test matrix (`yarn test`) could not run in this environment. It
stops before any test executes, in the stale-build guard: `@serfab/cadre-core` and
`@quereus/quereus` both need a build first, and the latter lives in the sibling
repository `C:\projects\quereus`, outside this tree. That is the guard working as
designed on an unbuilt checkout, not a failing test, so nothing was written to
`tickets/.pre-existing-error.md`. This diff is Markdown plus one `.gitignore` rule
plus two help strings — it has no runtime surface any workspace test could observe.

On Windows under Git Bash, the network-touching scripts need `MSYS_NO_PATHCONV=1`,
or the leading `/` in `/dnsaddr/...` is rewritten into a Windows path before Node
sees it. A local shell quirk, not a script defect; worth knowing when re-running.
