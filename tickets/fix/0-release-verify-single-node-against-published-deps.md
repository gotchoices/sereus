----
description: Everything we test runs against local copies of the two sibling projects, not the versions a customer downloads. Before we publish, prove that a plain install from the registry actually works for a single-machine setup — and check whether it explains the freeze an outside app reported.
prereq:
files: package.json (the `resolutions` block), packages/cadre-core/package.json, packages/quereus-plugin-sereus/package.json, packages/cadre-core/test/control-database-solo.spec.ts, scripts/check-dep-ranges.mjs, tickets/blocked/report-dependency-floor-bump-to-embedding-app.md, test-harness/build-freshness.ts
difficulty: medium
----

# Nothing tests what an installed consumer actually gets

Every suite in this repo resolves `@optimystic/*` and `@quereus/quereus` through the root
`package.json` `resolutions` block, which points them at `link:../optimystic/packages/*` and
`link:../quereus/packages/quereus`. So a green suite proves the code works against **the sibling
working copies on this machine**, which are not the same thing as the published packages.

Right now the gap is concrete and measurable:

- `../optimystic` is **10 commits past its `v0.18.0` tag**, and both of the fixes that mattered this
  week are in that unpublished window: `610d6d1` (a lone node can serve its own keys) and the
  cluster/corroboration work.
- Sereus declares `^0.18.0`. An `npm install` of our packages therefore resolves published
  `0.18.0` — a tree **without** those fixes.
- `scripts/check-dep-ranges.mjs` (the `yarn test:dep-ranges` gate, landed by
  `complete/debt-declared-dep-range-drift-gate`) checks that the declared floor matches the version
  we *develop against*. It cannot check that the published artifact at that version *works*, because
  it never installs it.

So we are about to publish a release whose tested configuration is not obtainable from the registry.
That is the thing to close before cutting it.

## What to build

A smoke check that installs the real packaged artifacts with no `resolutions` override and runs the
one scenario that matters most for the waiting customer: a single node, no peers.

1. `yarn pack` (or `npm pack`) each publishable workspace — the list is the `pub:*` scripts in the
   root `package.json`.
2. Install the resulting tarballs into a scratch project **outside** this repo (use the OS temp
   directory, not a path under `packages/`, so no workspace or `resolutions` inheritance leaks in).
   Let the registry resolve `@optimystic/*` and `@quereus/quereus` normally.
3. Run the single-node case: start a node with no inbound listening address and no bootstrap peers,
   on both node profiles, write and read a control row, restart, read again.
   `packages/cadre-core/test/control-database-solo.spec.ts` already covers exactly this shape
   against the linked build — reuse its assertions rather than inventing new ones.
4. Report pass/fail per resolved dependency version, and print the versions actually installed.
   Whoever reads the output must be able to see *what* it tested, not just that it passed.

Wire it as a script the release process runs, not as part of `yarn test` — it needs a network and it
is slow, so it must not become a gate that fails offline. `scripts/` is the right home; follow the
existing `check-*.mjs` conventions there.

## The question this also answers

`blocked/report-dependency-floor-bump-to-embedding-app` records an outside app reporting that **a
brand-new node with no other members froze indefinitely when reading or writing its own settings**,
which they worked around with manual timeouts. That ticket says plainly that we could not reproduce
it, and the reply drafted there says so too.

Since that was written, optimystic fixed a defect whose one-line summary is *a node with zero
connections cannot resolve a coordinator for any key* — `complete/offline-node-cannot-serve-its-own-data`,
fixed upstream at `610d6d1`, ticket named `isolated-node-can-serve-its-own-keys`. A lone node unable
to resolve a coordinator for its own data is a very close match for "a single-member node froze
reading its own settings".

**Treat that as a hypothesis to test, not a conclusion.** It is not obviously the same bug: the
grace-period branches in `libp2p-key-network.ts` require `networkHighWaterMark > 1` or a recent
`lastConnectedTime`, and a node that has *never* seen a peer may not satisfy either. Reading the
fixed code and reasoning about it is not enough — the point of this ticket is that we can now
install both versions side by side and just look:

- run the single-node case against published `@optimystic/*` `0.18.0` (what the reporter has)
- run it against the fixed tree (locally linked, or a prerelease if one exists by then)
- if the first hangs and the second does not, we have reproduced their bug and the reply changes
  from "we could not reproduce this" to "this is fixed, here is the version"

That is worth real effort. It converts the release from "please try this and tell us" into an
answer, and there are users waiting on it.

If it does **not** reproduce, say so just as plainly and leave the drafted reply's honesty intact —
do not soften "we were not able to reproduce your freeze" into an implied fix.

## Constraints

- **You may read `../optimystic` and `../quereus` freely. You may not edit their sources.** They are
  active workspaces belonging to someone else.
- Do not change the root `resolutions` block. The scratch project must get clean resolution by
  living outside this repo, not by editing how this repo resolves.
- Do not weaken `scripts/check-dep-ranges.mjs`. This ticket complements that gate; it does not
  replace it.
- Do not publish anything. `npm pack` produces a tarball locally and touches no registry — that is
  the whole mechanism here. Cutting a release is a human decision.

## TODO

- [ ] Pack every publishable workspace and install the tarballs into a scratch project outside the repo
- [ ] Run the single-node, no-peer, both-profiles, plus-restart case there
- [ ] Record the resolved dependency versions in the output
- [ ] Compare published `0.18.0` against the fixed optimystic tree and state whether the reporter's freeze reproduces
- [ ] Land it as a `scripts/` entry the release process runs, not as part of `yarn test`
- [ ] Report findings into `blocked/report-dependency-floor-bump-to-embedding-app` so the human reply can be finalised
