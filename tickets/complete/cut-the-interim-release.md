----
description: A decision ticket asking whether to publish an interim release. It was answered by action — a release went out on 2026-08-18 — so the question no longer stands, and most of what the ticket said about the state of the project has since stopped being true.
difficulty: easy
----

# Complete (superseded by events): the interim release was cut as v0.11.0

## What happened

This sat in `blocked/` from 2026-08-03 asking a human to decide whether to publish an interim
release, and recommending **`0.10.0-alpha.0` under the `alpha` dist-tag**.

A release was cut on **2026-08-18** (`ef3e54d`, `chore: release v0.11.0`). The registry now
carries all five publishable packages at `0.11.0`, and `@serfab/cadre-core`'s only dist-tag is
`latest: 0.11.0`.

So the decision was made — and made **differently** from this ticket's recommendation, in both
version and dist-tag. That is recorded here as fact, not as a complaint: the ticket argued for
`alpha` because multi-machine operation was broken at the time it was written, and that premise no
longer held by the 18th.

## Why every substantive claim in it had expired

Archived rather than merely deleted, because the *shape* of the staleness is worth seeing — a
decision ticket left in a human's inbox rots quickly when it quotes measurements:

| the ticket said | true as of 2026-08-21 |
| --- | --- |
| "Sharing data between two or more machines does not work" | multi-node scenarios largely pass; the remaining failures are 3 specific scenarios, all tracked |
| "if we published today, nobody could load what they installed" | `yarn smoke:published` **passes**; the consumer-install blocker cleared 2026-08-18 |
| "1501 of 1507 tests pass in the core library" | 1644 pass / 1 skipped |
| blocker: `blocked/optimystic-testing-barrel-breaks-consumer-install` | in `complete/` |
| blocker: `blocked/control-coordinator-answers-absent-without-asking-cohort` | in `complete/` |
| "Five packages, not six — everything except `@serfab/strand-proto`" | `strand-proto` was deleted from the repo entirely; five publishable packages is now simply the count |
| "The declared minimum … is now `^0.19.0`" | `^0.24.2` (`3bf4b35`) |
| "Full measured numbers: `docs/STATUS.md`" | that file was replaced by `docs/testing.md` (`3ca8737`) |
| open question in `blocked/publish-deprecated-strand-proto-decision` | answered and executed; that ticket is in `complete/` |

## Two things it said that are still true and still matter

Carried forward here so they do not die with the ticket:

- **`cadre-host` refuses to publish while its embedded release key is the all-zeros placeholder.**
  Still enforced in `scripts/publish-package.mjs` (the guard, and the
  `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1` escape hatch). Generating that keypair offline is human
  setup; it affects only that one package, and the other four can publish without it.
- **Do not soften accurate caveats in release notes** into "experimental" or "under active
  development". Whatever is known-broken at release time should be named.

## Note for whoever reads `docs/releasing.md` next

That document still carries the release-specific back half this ticket was written against —
a `## Recommendation` for `0.10.0-alpha.0`, `### Dependency floors: moved to ^0.19.0 (landed
2026-08-03)`, `## The blocker that must clear first`, `## Draft release notes — v0.10.0-alpha.0`,
and `## What the human has to run, in order`. All of it describes the release that already
shipped, and the blocker it names has cleared. The procedural front half (Overview, Prerequisites,
Step by Step, Prerelease / RC, Version Alignment, Checklist) is current and correct.
