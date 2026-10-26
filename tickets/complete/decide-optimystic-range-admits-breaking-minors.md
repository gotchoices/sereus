description: Each Sereus package accepts any later Optimystic release with the same major version, but Optimystic changed one of its functions in a minor release, so the already-published Sereus 1.18.0 now breaks for anyone installing it fresh. Decide whether Sereus should accept only patch releases of Optimystic, and what to do about the published 1.18.0.
files: scripts/check-dep-ranges.mjs, docs/testing.md ("Declared dependency range vs linked workspace"), packages/*/package.json, package.json (`upgrade:optimystic`)
----
## Decision (2026-10-25, maintainer)

Keep the `^` ranges. The `pushBlocks` change should have waited for a major version; Optimystic follows semver from here on, so no Sereus-side range policy is needed. No npm deprecation of the published 1.18.0: the next Sereus release (on Optimystic 1.19.0) follows within a day, so few or no installs will land on 1.18.0 in between. The release notes still state the 1.18.0 + 1.19.0 limitation (`adopt-optimystic-1-19-0`).

## Original proposal

**Category: the specification is silent.** A human must choose a range policy for `@optimystic/*`, and decide whether to act on the published `@serfab/*` 1.18.0 packages.

## What happened

Sereus declares `@optimystic/*` as `^1.18.0`, which admits every 1.x release from 1.18.0 on. Optimystic 1.19.0 changed `BlockTransferClient.pushBlocks`'s parameters, a breaking change shipped in a minor version. A fresh install of `@serfab/cadre-core` 1.18.0 resolves Optimystic 1.19.0, and a newly added machine then receives no blocks and never starts its strands (GitHub #52). Nothing in Sereus's checks could catch this: `check:dep-ranges` confirms only that the declared range admits the linked version, and `smoke-published-install` installs the floor Sereus is about to publish, not later releases.

The fix (`implement/backfill-pushes-blocks-in-the-optimystic-1-19-form`) moves Sereus to the new form and raises the floor to `^1.19.0`. That does not help anyone already on 1.18.0, and the next breaking minor would repeat this.

## Proposed default

1. **Declare `@optimystic/*` with a tilde range (`~1.19.0`)**, admitting patch releases only, for as long as Optimystic ships API changes in minors. Both projects are under the same maintainer and each Optimystic minor already gets a Sereus adoption pass, so a tilde range costs nothing extra: the adoption pass bumps it. `check-dep-ranges.mjs` keeps working (it calls `semver.satisfies`), and its suggested edit would print `~` instead of `^`. `upgrade:optimystic` uses `ncu -u`, which keeps the existing prefix.
2. **Deprecate the published `@serfab/*` 1.18.0 packages on npm** once the next release is out (`npm deprecate @serfab/cadre-core@1.18.0 "Resolves @optimystic 1.19, which it cannot use (gotchoices/sereus#52); upgrade"`). This is outward-facing and the maintainer's to run.

## Alternatives considered

- **Keep `^` and ask Optimystic to follow semver** (a breaking change requires a major). This is the better rule in principle. It is in another repo's hands, and with the two released in lockstep, majors would come often.
- **Pin exact versions.** This also locks out upstream patch fixes that embedders need without waiting for a Sereus release.
- **A check that installs the newest published Optimystic against the published Sereus.** It would detect the problem only after both are published, too late to prevent it.

## If we do nothing

The 1.18.0 breakage stays for anyone who installs it, and the next Optimystic minor that changes an API Sereus calls breaks the then-current Sereus release in the same way.

## Reversibility

Fully reversible: a range prefix and a doc paragraph. A deprecation can be lifted with `npm deprecate <pkg>@<ver> ""`.
