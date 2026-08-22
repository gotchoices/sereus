----
description: An outside app team reported a freeze and is still waiting to hear back from us. The fix they need has now been published, so all that is left is for a person who can reach them to send the reply — nobody on this repo has a contact channel for them.
files: packages/cadre-core/package.json, packages/cadre-core/test/control-database-solo.spec.ts, docs/testing.md, scripts/smoke-published-install.mjs
difficulty: easy
----

# Human action: reply to the reporting app — the fix they need is now published

> **Fact-checked 2026-08-21.** This ticket sat unchanged from 2026-08-03 while the world moved
> underneath it. **One of its two blockers is gone**, and the draft reply it carried had become
> wrong in almost every particular — it told the reporter to pin `0.10.0-alpha.0` from an `alpha`
> dist-tag and warned that cross-machine replication does not work. None of that is true now. The
> reply below has been rewritten; the investigation findings, which still stand, are preserved
> verbatim in intent.

## Why this is still blocked — one reason now, not two

**No channel to the reporter.** The report reached us second-hand. There is no issue link, email,
or contact recorded anywhere in the repo, so the reply cannot be sent from here. A person who knows
who they are has to send it and then record the channel so the next person does not hit this wall.

~~The fix is not yet published.~~ **Resolved.** `@serfab/cadre-core@0.11.0` was published to the
`latest` dist-tag on 2026-08-18 (`ef3e54d`), together with the other four packages. Verified
against the registry:

| | declares `@optimystic/*` | declares `@quereus/quereus` |
| --- | --- | --- |
| `0.9.0` (what the reporter has) | `^0.14.1` | `^4.4.0` |
| `0.11.0` (current `latest`) | `^0.24.0` | `^4.14.0` |

So the corrected floors are live, and a plain `npm install @serfab/cadre-core` now returns them —
no pinning, no dist-tag instructions. (A further tightening to `^0.24.2` / `^4.16.0` landed in
`3bf4b35` and will ship with the next release; it is not needed for this reply.)

## Background, in plain terms

Our library depends on a lower-level database and networking layer published by a sibling project.
Each of our packages declares the **oldest version it will accept**. That declared minimum had
drifted well behind the version we actually develop and test against, because this repo is wired to
use local copies of the sibling projects rather than the published ones. So an app installing our
library from npm got an older layer underneath than anything we had ever tested on.

An app in that situation reported that a brand-new node with no other members froze indefinitely
when reading or writing its own settings. They worked around it with manual timeouts.

## What has been done on our side

- Every package that depends on that lower layer declares the version we test against, and the rule
  keeping the two in lockstep is written down in [`docs/testing.md`](../../docs/testing.md)
  ("Declared dependency range vs linked workspace"), enforced by `scripts/check-dep-ranges.mjs`.
- Permanent coverage was added for exactly the reporter's configuration — a single node, no other
  members, no inbound listening address, no bootstrap peers — across both node profiles plus a
  restart. It completes in milliseconds.
- **We could not reproduce their freeze**, at either the old or the new dependency version. The
  version mismatch is a real problem that we fixed, but it is not proven to be the cause of what
  they saw. The reply says so plainly rather than promising a fix.

## Findings from installing the published packages (measured 2026-08-03, still standing)

Measured against what the registry actually serves — our packages packed and installed into a
throwaway project outside this repo, every other dependency from the public registry, running the
reporter's exact scenario.

1. **The reporter's exact configuration — published `0.9.0`, pulling lower-layer `0.14.1`. All
   three cases passed, 92–216 ms.** No hang at any step.
2. **Our code at the corrected minimum. All three cases passed, 84–196 ms.** Also no hang.

There was a specific reason to expect a reproduction: the sibling project had recently fixed *a
node with zero connections cannot resolve a coordinator for any key*, which sounds like a very
close match for "a single-member node froze reading its own settings". Running the two versions
side by side settles it — the old version does not hang here either, so that fix does not explain
what they saw.

One other real finding, still worth telling them: **the reporter's install contains two
incompatible copies of the SQL engine.** At the `^0.14.1` floor, the sibling project's plugins
require an old `0.16.x` line of `@quereus/quereus` while our packages require `4.x`, so the install
ends up with both loaded in one process. A genuine defect in the published `0.9.0`, and a plausible
source of odd behaviour, though it produced no hang in our runs. `0.11.0` resolves to a single copy.

That measurement is now repeatable rather than a one-off: it is `yarn smoke:published`
(`scripts/smoke-published-install.mjs`), and it passed on 2026-08-21 against the current tree.

## What a human needs to do

- Send the reply below.
- Record where it went, so the next person has the channel.

The two prerequisites this ticket used to list — resolve the consumer-install blocker, then cut a
release — are both done. `optimystic-testing-barrel-breaks-consumer-install` is in `complete/`, and
`cut-the-interim-release` is in `complete/` because the release went out.

## Draft reply

> The minimum version our library declared for its underlying database/networking layer had drifted
> well behind the version we actually develop and test against, so installing `@serfab/cadre-core`
> 0.9.0 from npm gave you an older layer underneath than anything we had tested on. Every one of our
> packages now declares the tested version.
>
> **This is fixed in 0.11.0, which is the current default install** — `npm install
> @serfab/cadre-core` will get it, and a `^0.9.0` range will not, so please update the version you
> depend on.
>
> Once you are on it, please drop the manual timeouts you added around the settings read and write,
> and tell us whether a single-member node still freezes. We have added permanent coverage for your
> exact setup — the same transport, no inbound listening address, no bootstrap peers, both node
> profiles, plus a restart — and it completes in milliseconds for us.
>
> One more thing worth knowing about 0.9.0: because of the version mismatch, that install also ends
> up with two incompatible copies of our SQL engine loaded at once. We have not seen it cause a
> hang, but it is not a configuration we would expect to behave predictably. 0.11.0 resolves to a
> single copy.
>
> Please be aware we were **not** able to reproduce your freeze at either version — including on the
> exact combination of published versions that 0.9.0 installs, running your configuration (single
> member, no inbound listening address, no bootstrap peers, both node profiles, plus a restart). It
> completes in well under a second for us. If you still see it after upgrading, send us a stack
> trace or a debug log from the frozen call (`DEBUG=cadre*,optimystic*`) — without a reproduction we
> cannot promise the version mismatch was the whole story.

## Before sending, re-check one thing

**Whether a newer release has superseded 0.11.0.** If so, name that version instead. Everything
else in the reply is version-independent.

The old instruction to re-check "whether cross-machine replication is still broken" has been
dropped from the reply: multi-node operation now works in the great majority of scenarios, and the
specific remaining failures are tracked individually (`secondary-index-seek-blind-to-sibling-rows`,
`control-peer-row-refresh-invisible-to-third-node`, `block-held-by-only-one-machine-is-unreadable`).
A blanket "sharing data across machines does not work" would now be inaccurate in the other
direction, which is its own kind of unhelpful.
