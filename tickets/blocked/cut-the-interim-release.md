----
description: Everything needed to publish an interim release is written and measured; what is left is a person deciding to publish it and running the steps, plus one fix that has to come from another team first.
files: docs/releasing.md, docs/STATUS.md, package.json, tickets/blocked/optimystic-testing-barrel-breaks-consumer-install.md, tickets/blocked/report-dependency-floor-bump-to-embedding-app.md, tickets/blocked/publish-deprecated-strand-proto-decision.md
difficulty: easy
----

# Human decision: publish the interim release

## Why this is here rather than in a working stage

Two reasons, both category (b) or "only a person should do this":

1. **Publishing is outward-facing and effectively irreversible.** A version published to npm cannot
   be taken back; a version wrongly marked as the default install can only be superseded, after
   everyone who installed in that window already has it.
2. **One blocking fix has to come from another team.** Nothing can be published from current HEAD
   at all — see below. Filing that work into `../optimystic`'s queue is a hand-over a person should
   make, not something to drop into another team's automation unannounced.

Everything else is done. There is no research left in this.

## The state of things, in plain terms

**What works.** A single machine holding its own data works, and is thoroughly tested: 1501 of 1507
tests pass in the core library, and every other package is fully green except for the two known
issues below. Every single-node, single-process and single-machine test in the repository passes.

**What does not.** Sharing data between two or more machines does not work. When a second machine
joins, a read can be answered "nothing was ever saved here" by whichever machine it routes to, even
when another machine holds the row — and after that the writing machine refuses further writes to
that table until it restarts. It is a race, so it does not happen every time, which makes it worse
rather than better. The cause is one line in the database library we depend on
(`../optimystic`), it is fully traced, and **this repository needs no code change for it**. Tracked
by `blocked/control-coordinator-answers-absent-without-asking-cohort`.

**What blocks publishing outright.** Independently of all of the above: if we published today,
nobody could load what they installed. Our packages now correctly declare the version of that same
underlying library we actually test against — and every version in that range ships shipped-runtime
code that reaches for a test-only assertion library that is not installed for consumers. Loading our
library from a registry install throws immediately. Tracked by
`blocked/optimystic-testing-barrel-breaks-consumer-install`, which also says what the fix is and
where.

Full measured numbers: `docs/STATUS.md` → "Release readiness — measured 2026-08-03".

## The decision, and the recommendation

The recommendation, with its reasoning, is in `docs/releasing.md` → "The interim release". In short:

- **Version `0.10.0-alpha.0`**, published under the **`alpha`** dist-tag, so it is not what
  `npm install` returns. Multi-machine is broken, and `latest` would claim otherwise.
- **Five packages, not six** — everything except `@serfab/strand-proto`, which has not changed and
  is called deprecated in three places. Skipping one release of it takes nothing away from anyone;
  the permanent question stays in `blocked/publish-deprecated-strand-proto-decision`.
- **The declared minimum for the underlying library is now `^0.19.0`.** That version was published
  while this was being written; it is the same code we measured against, just released. The edit
  landed on 2026-08-03 (`complete/0.15-bump-optimystic-floors-to-0.19`) and the check that guards it
  is green — nothing left to do here before you start.

What you are actually deciding: whether an interim release with an honest "multi-machine is broken"
caveat is worth publishing now, versus holding until the cross-machine fix lands. There is at least
one app team waiting on the corrected dependency versions
(`blocked/report-dependency-floor-bump-to-embedding-app`).

## What to run

The ordered runbook is the last section of `docs/releasing.md` ("What the human has to run, in
order") — nine steps, starting with handing the import-chain fix to the `optimystic` team, and
ending with the GitHub release. The draft release notes to publish with it are in that same file and
are written to be pasted as-is.

Two things worth knowing before you start:

- **Step 6 is now one command.** `0.2-release-publish-dist-tag` has landed
  (`complete/0.2-release-publish-dist-tag.md`), so `scripts/publish-package.mjs` takes `--tag <name>`
  or `SEREUS_DIST_TAG`, and it refuses to publish a prerelease version without a tag rather than
  silently marking it as the default install. `SEREUS_DIST_TAG=alpha yarn pub` tags the whole chain.
  The manual per-package commands in the runbook remain correct but are no longer necessary.
- **`cadre-host` refuses to publish while its embedded release key is the all-zeros placeholder**
  (`scripts/publish-package.mjs`, and `docs/cadre-host.md` § publishing). That is a separate piece of
  human setup — generate the keypair offline — and it only affects that one package. The other four
  can go out without it.

## Do not

- Publish before `blocked/optimystic-testing-barrel-breaks-consumer-install` is resolved and
  `yarn smoke:published` passes. A release that cannot be imported is worse for the waiting app team
  than no release.
- Soften the "multi-machine is broken" wording in the release notes into "experimental" or "under
  active development". The whole value of an interim release is that the caveats are accurate; a
  team that reads "experimental" and builds on it loses a week.
- Reprint the test numbers without re-measuring if more than a few days have passed. Several of the
  failures are races and the counts move between runs.
