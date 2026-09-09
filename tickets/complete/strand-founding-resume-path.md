----
description: Setting up a shared network took two steps, and an app killed between them could never attach that network again. The first step is now safe to repeat, both steps are available as one call, and the sample apps were moved onto it.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/e2e/fixtures/formation-responder.ts, docs/architecture.md, packages/cadre-core/README.md, packages/reference-app-rn/README.md
----

# Founding a strand is resumable

Closes the implement ticket `strand-founding-resume-path`, itself from upstream report
**gotchoices/sereus#12**. Implementation landed in `e2cab3f`; this review pass added
documentation corrections, one test, and two backlog tickets.

## What shipped

**`CadreNode.publishStrand` is idempotent for identical content.** It reads the `Strand`
row first; a live row whose `(Type, MemberPrivateKey)` match the arguments is returned
unwritten instead of re-inserted. Mismatching content throws an error naming the differing
columns rather than surfacing `UNIQUE constraint failed: Strand.Id`. The read and the insert
are not atomic, so the insert's uniqueness rejection is also caught, re-read, and resolved
the same way — that is the concurrent-founding case, two machines of one party on the same
id. Never an overwrite on either path. Return type changed from `Promise<void>` to
`Promise<StrandRow>` so the idempotent branch's outcome is observable.

**`CadreNode.foundStrand` is the single founding entry point**: read-or-publish, then
`addStrand(..., founder: true)`, returning `{ instance, strandRow }`. On an already-published
strand it adopts the stored row *including* its `MemberPrivateKey`, so a caller that mints a
key per attempt stops presenting a key that does not match the membership already seated in
the strand. A `Type` disagreement with the published row throws.

**Reference apps moved onto it**: React Native `createChatStrand` and
`createClosedChatStrand`, web `createClosedChatStrand`. Both closed-strand callers now return
the resolved membership key rather than the one they minted.

**Support pieces**: `isStrandIdConflict` classifies the uniqueness rejection by message text;
`FoundStrandConfig` / `FoundStrandResult` in `types.ts`; the founding contract documented in
`docs/architecture.md`.

## Review findings

Read the implement diff (`e2cab3f`, +747/−80 across 9 files) before the handoff summary, then
the surrounding code: `control-schema.ts`'s `Strand` DDL, `launchStrand`, `handleStrandAdded`,
`StrandInstanceManager.startStrand`, `bootstrapFounderMembership`, and every doc and README
that names `publishStrand` or the founding sequence.

### Major — filed as new tickets

- **`foundStrand` can return a headerless strand and report success.**
  `launchStrand` returns an already-tracked instance and silently discards the `founder` flag
  it was asked for, so whoever launches the strand *first* decides whether the founder
  bootstrap runs. Two reachable routes: an app that attached the strand itself (the React
  Native app's `strand:discovered` handler does exactly this after a restart), and this
  node's own `StrandWatcher` — `foundStrand` publishes the row before calling `addStrand`, and
  `launchStrand` awaits a network round (`resolveCohortSeed`) between its tracked-instance
  check and `startStrand`, so a poll landing in that window auto-launches the row as a joiner.
  Either way the strand comes up `active` with no `Header`. For a closed strand the bootstrap
  also seats the founding `Member` and `Manager`, so the loss is a strand that can never admit
  anyone. **Verified**, not inferred: the new characterization test below passes today.
  The implement handoff flagged the React Native arm and explicitly left the filing decision
  to review; the sharper statement — that `foundStrand` itself no-ops onto the joiner instance
  and claims success — settles it. Filed as
  `tickets/backlog/bug-founded-strand-can-come-up-headerless.md`, at the representation rung
  (founder-ness is not persisted anywhere) rather than as a patch to either call site.
- **The web end-to-end host fixture never founds its closed strand.**
  `reference-app-web/e2e/fixtures/formation-responder.ts` publishes the row then calls
  `addStrand` without `founder: true`, while its comment claimed byte-identity with the
  browser's `createClosedChatStrand`, which founds. So the invitation end-to-end test passes
  against a closed strand with no manager — a shape the app never produces. Pre-existing, not
  introduced here, but the implement handoff looked at this file and reported only that the
  ignored `publishStrand` return left it working. Filed as
  `tickets/backlog/debt-e2e-formation-host-never-founds-its-strand.md`; fixing it needs a
  Playwright run, which is out of reach inside a ticket. The misleading comment was corrected
  inline so nobody trusts the parity claim meanwhile.

### Minor — fixed in this pass

- **`foundStrand`'s docstring overclaimed.** It asserted "Always founds (`founder: true`),
  never merely attaches", which the code cannot keep. Rewritten to state the actual condition
  and carry a `NOTE:` describing both routes above.
- **`docs/architecture.md` described the pre-`foundStrand` ordering.** The strand-lifecycle
  events paragraph still called `addStrand` then `publishStrand` "the ordinary founding
  order" — now inverted by `foundStrand`, and the inversion is exactly what opens the
  watcher race. Corrected, and a known-gap sub-bullet added under the founder-bootstrap
  section.
- **Both READMEs documented the retired pattern.** `packages/cadre-core/README.md` had no
  `foundStrand` row at all, described `addStrand` as "manually add a strand (testing/direct
  API)" rather than the join path, and said nothing about `publishStrand` being idempotent.
  `packages/reference-app-rn/README.md` still walked through `publishStrand(id, 'c', memberKey)
  + local addStrand`. Both updated.
- **One test added**, `packages/cadre-core/test/publish-strand.spec.ts` → *"KNOWN GAP:
  founding a strand already ATTACHED as a joiner leaves it headerless"*. It publishes a row,
  attaches it the way the React Native handler does, calls `foundStrand`, and asserts the
  `Header` count is 0 while the instance reports `active`. It characterizes the defect rather
  than the wanted behaviour, and says so at the site: when the backlog ticket lands the
  expectation flips to 1 instead of the case being deleted. This is what upgraded the finding
  from "read the code and inferred it" to reproduced.

### Evidence appended to an existing ticket

- `tickets/backlog/debt-cadre-node-single-file-size.md` — `wc -l
  packages/cadre-core/src/cadre-node.ts` now reports **6075** lines, up from the 5104 that
  ticket recorded on 2026-08-18. Roughly 230 of the growth is this change's founding logic
  landing on the same class. Appended as another measurement arm; not a new ticket.

### The implementer's reviewer checklist — answered

All four items were raised deliberately in the handoff, so each got a verdict:

- **Text-matching `UNIQUE constraint failed: Strand.Id` as the race discriminator** —
  accepted, no change. It fails closed (an upstream reword resurfaces the raw error rather
  than doing anything unsafe), the read-first path means a reword degrades only the rare race,
  and two specs assert against the live engine's real rejection text, so a reword reddens
  rather than rotting silently.
- **`strandRowMismatches` treating `(Type, MemberPrivateKey)` as the whole of "identical
  content"** — confirmed correct. `control-schema.ts`'s `Strand` table is exactly
  `Id, MemberPrivateKey, Type, StampId`, and `StampId` is a single-use authorization nonce
  minted per attempt, so treating it as a nonce and not as content is right. Worth adding:
  `MemberPrivateKey` is itself declared `unique`, so reusing one key across two strand ids
  fails as `UNIQUE constraint failed: Strand.MemberPrivateKey` — which the explicit `Strand\.Id`
  match correctly keeps out of the idempotency branch.
- **Steering a stuck caller toward `unpublishStrand`, destructive for closed strands** —
  acceptable as written. The same sentence carries the warning, and the alternative (attach
  instead) is offered first.
- **`foundStrand` and `publishStrand` deliberately disagreeing on a key mismatch** — confirmed;
  keep the split. `publishStrand` is being asked to write that key and must refuse a different
  one; `foundStrand` is resuming onto what exists. Both sites document the asymmetry and point
  at each other.
- **Return shapes** (`Promise<StrandRow>`; `{ instance, strandRow }` rather than a bare
  `StrandInstance`) — confirmed, keep both. The row's `MemberPrivateKey` is honestly
  `string | null` where the instance's is `string | undefined`, and the row is what a closed
  strand's caller actually needs.

### Considered and dismissed — no action

- **The idempotent no-op branch performs no control-database write, so it skips the insert's
  authorization check.** A node holding an owner key but not enrolled in `OwnerKey` now
  succeeds on a repeat publish where it previously got an unauthorized rejection. Not a new
  hole: `addStrand(..., founder: true)` was never gated by that check either, and the control
  database is per-party, so the row in it is the party's own. Idempotency meaning "the desired
  state already holds" is the ordinary contract here.
- **`foundStrand` costs one redundant `queryStrand` per founding** — its own pre-read plus the
  one inside `publishStrand`. The pre-read is load-bearing (it is what lets `foundStrand` adopt
  a stored key where `publishStrand` would throw), founding happens once per strand lifetime,
  and no latency was measured. Not worth extra API surface.
- **`publishStrand` returns the row it constructed rather than re-reading after a successful
  insert.** Every column is text with no engine-side normalization, so the constructed row and
  the stored row cannot differ.

### Tripwires

None newly recorded. The implementer's existing tripwire at the no-op branch — `queryStrand`
does not filter rows whose `StampId` a `Revocation` has retired, so on a sibling still
physically holding a row deleted elsewhere while alone, an owner-signed republish no-ops onto
that doomed row — was reviewed against the `Strand` DDL, which documents the same read-side
omission deliberately, and left exactly as written.

### Validation

Green in the foreground: `yarn lint` (clean), `yarn build` (all workspaces), `yarn typecheck`
(all workspaces plus the three coverage guards), `@serfab/cadre-core` **1796 passed / 1
skipped across 109 files** (up one from the implement pass — the new characterization test),
`@serfab/reference-app-web` 66, `@serfab/reference-app-rn` 192. No pre-existing failures
surfaced, so no `.pre-existing-error.md` was written.

**`packages/integration-tests` was not run**, in this pass or the implement pass. It exceeds
ten minutes of wall clock with no output, which puts it outside what a ticket can run. That is
a deferral, not a pass, and it remains the highest-value thing a human or CI can add: the
two-machine founding race is argued from the code and simulated in a unit test, never actually
raced. The implement pass reasoned through what the suite touches — `harness/strand-join.ts`
publishes *after* `addStrand` and ignores the return, as do
`strand-late-cadre-join.integration.ts` and `strand-unpublish-sibling-convergence.integration.ts`
— and nothing in the tree asserts that a duplicate publish throws, so no assertion should have
flipped.

## Known coverage limits carried forward

- The race branch is simulated from a single node (one `queryStrand` blinded so the insert
  really collides against the live engine), not genuinely concurrent.
- The `landed === null` rethrow — collision, then the re-read finds nothing — is uncovered;
  constructing it needs a delete interleaved between rejection and re-read.
- Nothing exercises `foundStrand` across a real process restart with persistent storage; the
  specs use the default in-process node.

## Deliberately out of scope

Local-only founding sites were left alone, as the implement ticket scoped:
`reference-app-ns/src/chat-strand.ts` and the web `addChatStrand` both pass `founder: true`
and never publish — local islands where the interruption cannot happen.
`integration-tests/src/harness/strand-join.ts` keeps its `addStrand`-then-publish order;
migrating it would change which lifecycle events fire, which several scenarios assert on.

## Needs a human: reply on gotchoices/sereus#12

The reporter is carrying a local patch, so this still needs answering. **Not posted from an
agent run** — draft only:

> Fixed. `publishStrand` is now idempotent: it reads the `Strand` row first and returns it
> unchanged when `(Type, MemberPrivateKey)` already match, so a founding interrupted after
> the publish committed can simply be repeated. A row with the same id but different content
> throws an error naming the columns that differ instead of `UNIQUE constraint failed:
> Strand.Id` — the two cases that error could not distinguish ("already done, carry on" vs.
> "genuine conflict") are now distinct. The concurrent case is covered too: if another
> founder wins the insert race, the rejection is caught, the landed row re-read, and the call
> no-ops only when the content matches.
>
> There is also a new `CadreNode.foundStrand({ strandId, type, memberPrivateKey, sAppConfig })`
> that does the whole founding — publish the row, then `addStrand(..., founder: true)` — and
> is safe to re-run. Prefer it over hand-rolling the pair. It matters most for closed
> strands: on a resume it adopts the STORED `MemberPrivateKey` and returns the resolved row,
> because a caller that mints a fresh key per attempt would otherwise present a key that
> cannot read the strand. Both reference apps now use it.
>
> One honest caveat while you are on this path: `foundStrand` can only found the strand if it
> is the call that launches the local instance. If your app has already attached that strand
> — its own discovery handler, or the strand watcher picking up the freshly published row —
> `foundStrand` returns the running instance and reports success without founding it, leaving
> the strand with an empty `Header`. Nothing records which machine published a strand, so the
> library cannot currently detect this; it is tracked as a separate defect. In practice: call
> `foundStrand` before anything else can attach the id.
>
> Your `queryStrand` pre-check keeps working — it is a coarser version of the same guard. It
> skips the publish whenever a row exists, without comparing content, so it silently
> tolerates a mismatched row where `publishStrand` now throws. Nothing about it becomes
> wrong; you can drop it once you are on a build with this change.
>
> If anyone is already stuck: no app-data wipe is needed. The `Strand` row is already
> published, so attach instead of republishing — `addStrand` (or `foundStrand`) with the id
> and, for a closed strand, the `MemberPrivateKey` read back off the row. `unpublishStrand`
> plus a fresh publish also clears it for an OPEN strand, but is destructive for a closed one:
> that row's `MemberPrivateKey` is stored nowhere else. This recovery note is also in the
> `publishStrand` docstring.
