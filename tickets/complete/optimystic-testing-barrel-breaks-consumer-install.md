----
description: If we publish a release right now, anyone who installs our library from the public registry cannot even load it — it crashes immediately looking for a testing tool that was never shipped. The bug is in another team's package, so someone has to decide whether to wait for their fix or work around it on our side.
prereq:
files: packages/cadre-core/package.json, packages/quereus-plugin-sereus/package.json, packages/cadre-provider/package.json, packages/cadre-host/package.json, packages/cadre-cli/package.json
difficulty: medium
repro: verified
----

# Publishing today ships a package that will not import

## What happens

Install our library the way a customer would, then load it:

```
npm install @serfab/cadre-core        # built from this repo's current HEAD
node -e "import('@serfab/cadre-core')"
```

It throws before running a single line of our code:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'chai' imported from
  .../node_modules/@optimystic/db-p2p/dist/src/testing/raw-storage-conformance.js
```

`chai` is a test-assertion library. It is not installed, because nobody's *runtime* is supposed to
need it.

**Verified, not inferred.** Measured 2026-08-03 by packing this repo's `@serfab/cadre-core` and
`@serfab/quereus-plugin-sereus`, installing the tarballs into a throwaway project outside the repo,
and letting everything else resolve from the public registry.

## Why it happens

Three facts line up:

1. The lower-level networking package we depend on, `@optimystic/db-p2p`, publishes a testing
   helper entry point. One file behind it starts with `import { expect } from 'chai'`.
2. `chai` is listed in that package as a *development* dependency, so it is deliberately not
   installed for anyone who merely depends on the package.
3. The database-adapter package we also depend on, `@optimystic/quereus-plugin-optimystic`, imports
   that testing entry point from its **shipped runtime code**, not from its tests.

So loading our library loads the adapter, which loads the testing helper, which reaches for a
library that is not there.

This is not a packaging accident on our side — our own tarballs are fine. The import chain lives
entirely inside the other project's published packages.

## Why it appeared only now

It has been broken in every version of the lower-level packages from `0.16.2` onward (checked
`0.16.2`, `0.16.3`, `0.17.0`, `0.18.0`, `0.19.0` — all five ship the offending import; `0.14.1`
does not).

Our currently published release, `@serfab/cadre-core` 0.9.0, asks for version `0.14.1` of those
packages, which predates the problem — so **installing 0.9.0 today works**. We then corrected the
declared minimum to `0.19.0` (via `0.18.0`), because that is the version we actually build and test
against. That
correction is right, and it is also what walks us into this. The moment we publish, customers stop
being able to load the library at all.

Nothing in this repo's own test suite can see it: our tests resolve those packages to local working
copies of the sibling project, where `chai` happens to be present as that project's own development
dependency.

## Why a human has to decide

The defect is in `../optimystic`, which is another team's active workspace and which we are not
permitted to edit. Every fix is either theirs to make or a trade-off only a person should pick:

- **Upstream, the clean fix.** In the `optimystic` project, stop the shipped adapter code from
  importing the testing entry point — the two functions it wants (`createMesh`,
  `buildNetworkTransactor`) should live in normal source rather than behind a test-only barrel.
  Alternatively, drop the conformance file from that barrel, or promote `chai` to a real dependency
  (least good — it ships a test library to every consumer).
  Concrete sites in that repo: `packages/db-p2p/src/testing/index.ts`,
  `packages/db-p2p/src/testing/raw-storage-conformance.ts`,
  `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`.
- **Wait.** Hold the release until a fixed version of those packages is published. Correct, but it
  parks a release that other people are waiting on.
- **Work around it here.** Declare `chai` as a real dependency of our own packages. It works — the
  scratch project passed every check once `chai` was installed — but it means shipping a test
  library to every customer to paper over someone else's bug, and it is easy to forget to remove.

Whichever route is chosen, `implement/0-release-smoke-published-install` lands the script that
catches this class of problem before publishing rather than after.

## Re-checked 2026-08-03 (release-readiness pass) — nothing has changed, and nobody upstream knows

- `packages/db-p2p/src/testing/raw-storage-conformance.ts:1` still opens with
  `import { expect } from 'chai'`, and
  `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:12` still does
  `import { createMesh, buildNetworkTransactor } from '@optimystic/db-p2p/testing'`, at
  `../optimystic` HEAD.
- `../optimystic` cut **`v0.19.0`** later the same day (`9b86eb3`) and it is on npm as `latest`. It
  is a version-numbers-only release — twelve `package.json` files, one line each — sitting directly
  on the commit above, so **`0.19.0` ships this defect too**. There is still no published version
  to move to.
- **No ticket for this exists on `../optimystic`'s board** (searched `tickets/` there; the only
  matches are unrelated run logs). Nothing was filed from this repo, on purpose — dropping work into
  another team's top-priority `fix/` queue is not an agent's call. Handing this over is therefore
  the first item on the release runbook, and it is item 1 because nothing else on that list matters
  until an installable version exists.

**Recommendation, so this is a decision rather than a menu: take the upstream route and wait.** The
fix is small, it belongs where the defect is, and the alternative ships a test-assertion library to
every customer to cover another project's bug. If the wait turns out to be unacceptable, the
workaround is a declared `chai` dependency on `@serfab/cadre-core` and
`@serfab/quereus-plugin-sereus` — verified to work — and it should be time-boxed: a `NOTE:` at each
site naming this ticket, plus a `backlog/debt-` ticket to remove it. Either way
`yarn smoke:published` is what proves the result.

## What is *not* affected

Development in this repo, and anyone installing the currently published 0.9.0. This is a
publish-time regression that would arrive with the next release, not a live customer-facing outage.

## The minimal upstream fix, traced 2026-08-03

Verified against `../optimystic` at `9b86eb3` (the `v0.19.0` release commit). The whole defect is one
re-export line.

`packages/db-p2p/src/testing/index.ts` is two lines:

```ts
export * from './mesh-harness.js';
export * from './raw-storage-conformance.js';
```

- `mesh-harness.ts` contains `buildNetworkTransactor` / `buildNetworkTransactors` — what production
  code actually imports — and contains **zero** references to `chai`.
- `raw-storage-conformance.ts` is the only file under `src/testing/` that imports `chai`
  (`import { expect } from 'chai'` at line 1).
- Nothing anywhere in `../optimystic` imports `raw-storage-conformance` **except** this barrel:
  `grep -rn "raw-storage-conformance" src/ ../*/src/` returns only `testing/index.ts`.

So the barrel is what drags `chai` into every consumer of the `./testing` subpath. Removing the
second line makes `./testing` chai-free, and gives `raw-storage-conformance` its own subpath for the
suites that want it:

```ts
// packages/db-p2p/src/testing/index.ts
export * from './mesh-harness.js';
```

plus an `exports` entry alongside the existing `.`, `./rn`, `./testing`:

```json
"./testing/conformance": { ... }
```

**Do not fix it by moving `chai` from `devDependencies` to `dependencies`.** That ships an assertion
library to every consumer of a peer-to-peer database and hides the real problem, which is that a
production import path reaches test-only code.

## Why a consumer reaches this at all

The import is not from our code and not from a test. It is in optimystic's own production source:

```
../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:12
import { createMesh, buildNetworkTransactor } from '@optimystic/db-p2p/testing';
```

`@serfab/quereus-plugin-sereus` depends on `@optimystic/quereus-plugin-optimystic`, so the chain
reaches every consumer of ours. Nothing in this repository imports `@optimystic/db-p2p/testing` —
confirmed by grep across all `packages/*/src` and `packages/*/test`. **There is no sereus-side
workaround worth taking**: we cannot stop a dependency's production module from importing what it
imports, and vendoring or patching around it would be worse than waiting for a one-line fix.

Worth raising with upstream separately, but not blocking: a production adapter importing from a
barrel named `testing` is the underlying smell. `buildNetworkTransactor` arguably belongs in the
main entry point. That is their call and a larger change than the release needs.

## Fixed upstream and verified 2026-08-03 — closing

`../optimystic` `v0.20.0` lands it (`ab06122` implement → `fced795` review). `src/testing/index.ts`
now exports only `./mesh-harness.js`, `raw-storage-conformance` moved to its own
`./testing/conformance` subpath, and they added `test/testing-entry-runtime-deps.spec.ts` which
enforces that every published subpath imports only runtime `dependencies` — so this class cannot
come back silently.

`yarn smoke:published` **passes**, its first green run since the gate was written:

```
@optimystic/*     0.20.0
@quereus/quereus  4.6.0
3/3 case(s) passed.
smoke-published-install: PASSED — the packed tarballs install and run from a clean project.
```

That also covers the gate's own previously-untested success path (`cleanup()`, the `PASSED` line,
the build branch), which `docs/STATUS.md` recorded as unexercised.
