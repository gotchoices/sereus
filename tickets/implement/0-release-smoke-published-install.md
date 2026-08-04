----
description: Our tests all run against local copies of two other projects, not the versions a customer downloads, so a green test run does not prove an install from the public registry works. Add a script the release process runs that installs the real published packages into a throwaway project and checks a single-machine node still works.
prereq:
files: scripts/smoke-published-install.mjs (new), scripts/check-dep-ranges.mjs, package.json, packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, docs/STATUS.md
difficulty: medium
----

# A release gate that installs what a customer installs

Every suite in this repo resolves `@optimystic/*` and `@quereus/quereus` through the root
`package.json` `resolutions` block, which points at `link:../optimystic/packages/*` and
`link:../quereus/packages/quereus`. A green suite proves the code works against **the sibling
working copies on this machine**. It says nothing about the tarballs on npm.

`scripts/check-dep-ranges.mjs` (`yarn test:dep-ranges`) closes half the gap: it proves the declared
range *admits* the version we develop against. It cannot prove the published artifact at that
version *works*, because it never installs it.

This ticket lands the other half: pack, install from the registry into a scratch project outside
this repo, run the single-node scenario, print what actually got installed.

**A prototype of exactly this was built and run during the fix stage** — its results are recorded in
`blocked/report-dependency-floor-bump-to-embedding-app` and
`blocked/optimystic-testing-barrel-breaks-consumer-install`. The design below is what that prototype
converged on; the gotchas are ones it actually hit, not predictions.

## Shape

`scripts/smoke-published-install.mjs`, following the `check-*.mjs` conventions already in `scripts/`
(plain ESM, `process.exit(main())`, human-readable console output). Wire it into the root
`package.json` as `smoke:published` — **not** into `yarn test`. It needs the network and it takes
tens of seconds; making it a default gate breaks offline runs.

Four steps:

1. **Pack.** `yarn workspace <name> pack --out <scratch>/tarballs/<name>.tgz` for each publishable
   workspace (the set named by the `pub:*` scripts in the root `package.json`). Yarn rewrites
   `workspace:^` to the concrete `^<version>` in the packed manifest, so the tarballs are exactly
   what `yarn npm publish` would upload. Build first — `pack` does not build.
2. **Install.** A scratch project in the OS temp directory (`node:os` `tmpdir()`), never a path
   under `packages/`, so no workspace or `resolutions` inheritance leaks in. Use **npm**, not yarn:
   yarn would look upward for a workspace root. Declare the tarballs as `file:` dependencies at the
   top level so they satisfy each other's registry ranges; let everything else resolve from the
   registry normally.
3. **Run.** The single-node case: no listen address, no bootstrap peers, both node profiles, write
   and read a control row, restart, read again. `packages/cadre-core/test/control-database-solo.spec.ts`
   is the assertion source — port its assertions, do not invent new ones.
4. **Report.** Print the resolved version *and resolved path* of every dependency that matters,
   then a per-case PASS/FAIL line. A reader must be able to see what was tested, not only that it
   passed.

## Gotchas the prototype hit — do not rediscover these

- **Resolve versions from the consumer's perspective, not the scratch root.** A naive
  `require.resolve('@quereus/quereus/package.json')` from the scratch root reported `0.16.4` while
  `@serfab/cadre-core` was actually loading a *nested* `4.6.0`. Build the `require` with
  `createRequire(<path to the installed package's entry file>)` for each package whose view you
  want, and print the resolved path next to the version so nesting is visible. Also note that
  `@quereus/quereus` does not export `./package.json`, so `require.resolve` on that subpath throws
  — read the manifest off the resolved directory instead of requiring it.
- **The spec's helpers cannot be imported as-is.** `control-db-node-helpers.ts` imports
  `withTimeout` from `../src/control-stream.js`, which `packages/cadre-core/src/index.ts` does not
  re-export, and uses vitest's `expect`. The scratch project has no vitest and no deep access into
  the package. Port to `node:assert/strict` plus a local `Promise.race` deadline. Keep the labelled
  deadline: a hang must fail as `HANG: <op> timed out after <n>ms`, not as a silent wall-clock
  stall with nothing to diagnose. Everything else in the helper (`controlNodeConfig`, `freshPartyId`,
  `readColumn`) ports over unchanged.
- **`MemoryRawStorage` and `webSockets()` must be declared by the scratch project itself.** The
  ported scenario imports them directly, so the scratch `package.json` needs `@optimystic/db-p2p`
  and `@libp2p/websockets` as explicit dependencies at the range the packed manifests declare.
- **It currently fails, and that is the correct result.** At the `^0.18.0` floor this repo now
  declares, merely `import`ing `@serfab/cadre-core` from a registry install throws
  `ERR_MODULE_NOT_FOUND: Cannot find package 'chai'`. See
  `blocked/optimystic-testing-barrel-breaks-consumer-install` for the mechanism. Do **not** install
  `chai` into the scratch project to get a green run — that hides the exact defect this script
  exists to catch. Land the script red, with output that names the failure clearly.

## Reporting a failure well

An import-time crash and a hang are different diagnoses and must read differently:

- Import failure — report the module specifier and the importing file verbatim from the
  `ERR_MODULE_NOT_FOUND` message. That message is what identified the upstream defect.
- Hang — report the operation label and the deadline.
- Assertion failure — report expected vs actual.

Print the resolved-version block **before** running any case, so it survives a crash.

## Constraints

- Do not change the root `resolutions` block. The scratch project gets clean resolution by living
  outside this repo.
- Do not weaken `scripts/check-dep-ranges.mjs`. This complements that gate.
- Do not publish anything. `pack` writes a local tarball and touches no registry.
- `../optimystic` and `../quereus` are read-only. Packing *from* them to an external destination is
  fine if the script ever needs it; building or editing them is not.

## Also update

`docs/STATUS.md` already carries the "Declared dependency range vs linked workspace" rule. Add a
short paragraph next to it saying what this script covers that the range gate cannot, and that it is
a release step rather than a test.

## TODO

- [ ] Write `scripts/smoke-published-install.mjs`: pack every `pub:*` workspace to a temp scratch dir
- [ ] Install the tarballs plus registry deps into a scratch project under `tmpdir()`, using npm
- [ ] Port the `control-database-solo.spec.ts` assertions to `node:assert/strict` with labelled deadlines
- [ ] Report resolved version + resolved path per dependency, resolved from each consumer's own `require`
- [ ] Emit distinct, readable output for import failure / hang / assertion failure
- [ ] Add a `smoke:published` script to the root `package.json`; keep it out of `yarn test`
- [ ] Clean up the scratch dir on success, and leave it in place on failure with its path printed
- [ ] Document in `docs/STATUS.md` beside the existing dependency-range rule
- [ ] Confirm the script currently reports the `chai` import failure rather than passing
