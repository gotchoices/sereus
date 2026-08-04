----
description: An outside app team reported a freeze and is waiting to hear back from us. We fixed the version mismatch on our side, but the fix only reaches them when we publish a new release, and nobody on this repo has a way to contact them — a human needs to send the reply and decide when to publish.
prereq:
files: packages/cadre-core/package.json, packages/cadre-core/test/control-database-solo.spec.ts, docs/STATUS.md
difficulty: easy
----

# Human action: reply to the reporting app, and publish a release that carries the fix

## Why this is here rather than in a working stage

Two things block it, both outside what an agent in this repo can do:

1. **No channel to the reporter.** The report reached us second-hand. There is no issue link,
   email, or contact recorded anywhere in the repo, so the reply cannot be sent from here.
2. **The fix is not yet published.** `@serfab/cadre-core` is at version 0.9.0 both in this repo
   and on npm. The corrected dependency versions are committed but unreleased, so *no published
   version carries them*. Cutting a release is a human decision (`yarn release`), not something
   to do inside a ticket.

## Background, in plain terms

Our library depends on a lower-level database and networking layer published by a sibling
project. Each of our packages declares the **oldest version it will accept**. That declared
minimum had drifted two minor versions behind the version we actually develop and test against,
because this repo is wired to use a local copy of the sibling project rather than the published
one. So an app installing our library from npm got an older layer underneath than anything we
had ever tested on.

An app in that situation reported that a brand-new node with no other members froze
indefinitely when reading or writing its own settings. They worked around it with manual
timeouts.

## What has been done on our side

- Every one of our packages that depends on that lower layer now declares the version we
  actually test against, and there is a written rule in `docs/STATUS.md` to keep the two in
  lockstep from now on.
- Permanent test coverage was added for exactly the configuration the reporter runs — a single
  node with no other members, no inbound listening address, and no bootstrap peers — across both
  node profiles plus a restart. It completes in milliseconds here.
- **We could not reproduce their freeze**, at either the old or the new dependency version. So
  the version mismatch is a real problem that we have fixed, but it is not proven to be the
  cause of what they saw. The reply must say that plainly rather than promising a fix.

## Findings from installing the published packages (2026-08-03)

Everything above was measured against local copies of the sibling project. It has now been
re-measured against **what the registry actually serves**: our packages were packed and installed
into a throwaway project outside this repo, with every other dependency resolved from the public
registry. Two configurations were run, each doing the reporter's exact scenario — a single node, no
other members, no inbound listening address, no bootstrap peers, both node profiles, plus a restart.

**1. The reporter's exact configuration — published `@serfab/cadre-core` 0.9.0, which pulls in
version 0.14.1 of the lower layer. All three cases passed, in 92–216 ms.** No hang, at any step.

**2. Our current code against the corrected minimum, version 0.18.0 of the lower layer. All three
cases passed, in 84–196 ms.** Also no hang.

So the freeze **still does not reproduce**, now including on the precise version combination the
reporter downloads. The "we were not able to reproduce" sentence in the reply below stands as
written and must not be softened.

There was a specific reason to expect it might reproduce: the sibling project recently fixed a
defect summarised as *a node with zero connections cannot resolve a coordinator for any key*, which
sounded like a very close match for "a single-member node froze reading its own settings". Testing
the two versions side by side is what settles it — the old version does not hang here either, so
that fix is not an explanation for what they saw.

Two other things surfaced, both real, neither a hang:

- **Publishing is currently blocked.** At the corrected minimum, simply loading our library from a
  registry install crashes immediately — see `optimystic-testing-barrel-breaks-consumer-install`.
  Until that is resolved, telling the reporter to upgrade would send them to a release that does not
  load. The reply below has been adjusted accordingly.
- **The reporter's install contains two incompatible copies of the SQL engine.** At the 0.14.1
  floor, the sibling project's plugins require an old 0.16.x line of `@quereus/quereus` while our
  packages require 4.x, so a customer install ends up with both loaded in one process. That is a
  genuine defect in the published 0.9.0 and a plausible source of odd behaviour, though it did not
  produce a hang in our runs. Correcting the declared minimum to 0.18.0 removes it — at that
  version everything agrees on a single 4.6.0.

The script that produced these measurements is being landed as
`implement/0-release-smoke-published-install` so this is repeatable rather than a one-off.

## What a human needs to do

- **First**, resolve `optimystic-testing-barrel-breaks-consumer-install`. Until it is resolved, a
  release built from current HEAD cannot be loaded at all by anyone installing it, so cutting one
  would make the reporter's situation worse rather than better.
- Then decide when to cut the next `@serfab/cadre-core` release (0.9.1 or later) — that is the first
  version an outside app can install to get the corrected minimums.
- Send the reply below (adjust the version number once the release is cut). Do not send it before
  the release exists: it asks them to upgrade.
- Record where the reply went, so the next person has the channel.

## Draft reply

> The minimum version our library declared for its underlying database/networking layer was two
> minor versions behind the version we actually develop and test against, so installing
> `@serfab/cadre-core` 0.9.0 from npm gave you an older layer underneath than anything we had
> tested on. Every one of our packages now declares the tested version. **This ships in the next
> release (0.9.1 or later) — 0.9.0 on npm still carries the old minimum**, so please pin to the
> new release rather than reinstalling 0.9.0.
>
> Once you are on it, please drop the manual timeouts you added around the settings read and
> write, and tell us whether a single-member node still freezes. We have added permanent coverage
> for your exact setup — the same transport, no inbound listening address, no bootstrap peers,
> both node profiles, plus a restart — and it completes in milliseconds for us.
>
> One more thing worth knowing about 0.9.0: because of the version mismatch, that install also
> ends up with two incompatible copies of our SQL engine loaded at once. We have not seen it cause
> a hang, but it is not a configuration we would expect to behave predictably. The new release
> resolves to a single copy.
>
> Please be aware we were **not** able to reproduce your freeze at either version — including on
> the exact combination of published versions that 0.9.0 installs, running your configuration
> (single member, no inbound listening address, no bootstrap peers, both node profiles, plus a
> restart). It completes in well under a second for us. If you still see it after upgrading, send
> us a stack trace or a debug log from the frozen call (`DEBUG=cadre*,optimystic*`) — without a
> reproduction we cannot promise the version mismatch was the whole story.
