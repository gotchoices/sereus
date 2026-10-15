description: `foundStrand` returns only after the strand node is up (about 4-5 s on a Galaxy S7), though the strand exists durably once `publishStrand` commits, and an invitation needs only the strand id and member key. Let it return after the publish and finish the bring-up in the background (GitHub #49).
architecture: docs/architecture.md
files: packages/cadre-core/src/cadre-node.ts (`foundStrand` ~5963-5988, `addStrand` ~5672, `startOrFoundStrand` ~6443, `whenStrandWritable` ~5774), packages/cadre-core/src/types.ts (`FoundStrandResult` ~1479-1493), packages/reference-app-rn/src/chat-strand.ts (~94-166), packages/reference-app-rn/src/use-cadre.ts (~746-753), packages/reference-app-web/src/lib/cadre-web.ts (~709-769), docs/architecture.md (~1351-1359)
----

# `foundStrand` returns after the publish

kjeib (gotchoices/sereus#49) measured `foundStrand` at 751 ms on Node through relay.sereus.org. The publish took 103 ms; the rest was bring-up (seed lookup 95 ms, database initialize 159 ms, relay first attempts 375 ms). Sereus Chat cut tap-to-invitation on an S7 from 4.0-4.7 s to 0.40-0.43 s by founding early at app level.

Verified at 70b2dc1d:

- **A failed bring-up is recoverable.** After `publishStrand`, a failed `addStrand` leaves a published, not-running strand. The watcher retries it, and a later `addStrand` re-attaches (founder status comes from the row).
- **Minting an invitation needs no running strand.**
- **Redeeming one does.** The formation responder's `getStrandMultiaddrs` returns `[]` without a strand node. A closed strand's `issueStrandMembershipInvite` needs the live database; until then it rejects retryably ("not launched, or still starting").
- **Callers use the instance at once.** RN `createClosedChatStrand` assigns the owner role on it, and many integration tests read `founded.instance` immediately.

## Plan

Approved (maintainer, 2026-10-15): the opt-in `{ background: true }` form as replied on #49.

- Add an opt-in background form and keep today's return for existing callers: `foundStrand(…, { background: true })` returns `{ strandRow, founded, ready: Promise<StrandInstance> }`. `ready` rejects with the bring-up's error while the watcher keeps retrying. `whenStrandWritable` already covers "wait until usable".
- A joiner that redeems during the bring-up gets the existing retryable rejection. Check that the formation client retries it within its budget, and say so in the docs.
- Move the RN and web reference apps' "make an invitation" path to the background form.
