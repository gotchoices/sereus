----
description: Setting up a shared network takes two steps, and if the app is killed between them the network can never be attached again — every later attempt fails on the step that already succeeded. Make the first step safe to repeat, and fix the sample apps that show the unsafe pattern.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/integration-tests/src/harness/strand-join.ts
difficulty: medium
repro: verified
----

# Founding a strand must be resumable

Filed from `tickets/fix/1-strand-founding-has-no-resume-path.md`, reported upstream as
**gotchoices/sereus#12**. Everything below the "Reproduction" heading was verified against the
code in this repo during the fix pass, not carried over from the report.

## Reproduction

Both halves reproduce in-process against a real control database, with no need for the slow
React Native schema apply that widens the window in the field. Using the existing
`packages/cadre-core/test/self-owner-node-helpers.ts` harness:

```ts
({ node } = await startSelfOwnerNode('repro-', { enrollOwner: true }));
await node.publishStrand(strandId, 'o');
await node.publishStrand(strandId, 'o');   // throws
```

Observed, on both a repeat of *identical* content and a repeat with a *different*
`memberPrivateKey`:

```
UNIQUE constraint failed: Strand.Id
```

Note the two cases are indistinguishable from the error alone. A caller cannot tell "I already
did this, carry on" from "this is a genuine conflict, stop".

## What was established

**`addStrand` is already idempotent; `publishStrand` is the asymmetric half.** Verified:
`addStrand(founder: true)` then `stopStrand` then `addStrand(founder: true)` again, against
persistent storage, re-attaches cleanly and leaves `Strand.Header` at 1, no throw.
`cadre-node.ts:4259` short-circuits an already-tracked instance, `StrandDatabase.initialize`
short-circuits on `initialized`, the Quereus schema apply is declarative (`declare schema` /
`apply schema`, so it converges rather than replays), and `bootstrapFounderMembership` is
insert-if-absent. `reference-app-web/src/lib/cadre-web.ts:509` already documents this. So the
fix belongs entirely on the publish half.

**"Identical content" can only mean `(Id, Type, MemberPrivateKey)`.** The `Strand` table
(`control-schema.ts:141`) holds `Id`, `MemberPrivateKey`, `Type`, `StampId` — and nothing that
records *who* inserted the row. So "is this row owner-signed by us?" is not answerable after
the fact, and does not need to be: the insert digest binds exactly
`(Id, Type, coalesce(MemberPrivateKey,''), StampId)`, and `StampId` is a single-use nonce, not
content. A live row whose three content columns match is, by construction, the state a repeat
publish would have produced — whichever branch of `AuthorizedInsert` seated it (owner-signed,
or the unsigned consent branch that an invite redemption uses). A mismatch on `Type` or
`MemberPrivateKey` must stay a hard error: silently accepting it would let a retry reopen a
closed strand or swap the key that gates its reads.

**A tombstoned strand cannot be resurrected by this change.** `unpublishStrand` deletes the row,
so `queryStrand` returns null and the ordinary publish path runs — which is the documented
re-seat behaviour (see the `unpublishStrand` docstring in `cadre-node.ts`). The idempotent branch
is only reachable when a **live** row is present, so it can never revive a deliberately removed
strand.

**Recovery for users already stuck does not require wiping app data** — but it does require an
app change, which is why the report saw no way out. The `Strand` row is already there; the
correct move is to skip the publish and just `addStrand`. `unpublishStrand` plus republish also
works for an *open* strand, but is destructive for a closed one (the `MemberPrivateKey` exists
nowhere else). Prefer attach-don't-republish in the recovery note.

**The reporter's `queryStrand` pre-check stays working, but is weaker than what we ship.** It
skips the publish whenever a row exists, without comparing content — so it silently tolerates a
mismatched row where the change below throws. It does not become *wrong*; it becomes a coarser
version of the same guard. Say so when replying upstream.

## Second arm: the interruption also leaves headerless strands

Verified: publish, then attach later as a **joiner** (no `founder` flag) — which is exactly what
`reference-app-rn/src/use-cadre.ts:174`'s `strand:discovered` handler does for open strands —
leaves the instance `active` with `Strand.Header` at 0 and sApp writes still succeeding. The
strand works, but its provenance record (`sAppId`, `sAppVersion`, `sAppSchema`,
`sAppSignature`) is never written, because the founder bootstrap only runs under `founder: true`
and nothing remembers that this node was the founder.

This is the same interruption and the same fix site: a resume must re-found (`founder: true`),
not merely attach. `bootstrapFounderMembership` being idempotent is what makes that safe.

## Consumer survey — five orderings in this repo alone

The original report counted three consumers; in-repo there are five, and the reference apps are
the pattern the others copy.

| site | ordering | on interruption |
| --- | --- | --- |
| `reference-app-rn/src/chat-strand.ts:97` (open) | publish, then addStrand | orphan: control row published, never founded |
| `reference-app-rn/src/chat-strand.ts:155` (closed) | mint key, publish, addStrand | bricks on a stable id; mints a **fresh** key each attempt |
| `reference-app-web/src/lib/cadre-web.ts:506` (closed) | mint key, publish, addStrand | same as above |
| `integration-tests/src/harness/strand-join.ts:92` | addStrand, then publish | resumable today, by luck of ordering |
| `reference-app-ns/src/chat-strand.ts` | addStrand only, never publishes | local-only island — *separate concern, out of scope here* |

Whether a consumer bricks depends on whether it reuses a stable strand id. The reference RN app
mints a fresh `uuid()` per tap (`app/settings.tsx:99`), so it orphans rather than bricks; an app
that persists its default strand id — as the reporter's does — bricks permanently.

**The closed path cannot be fixed by an idempotent publish alone.** Both closed-strand call
sites mint a new `memberPrivateKey` *before* publishing, so on a resume the content genuinely
differs and the conflict is correct. The call site must read the existing row and reuse its
stored key. That is why the work below is not only the core change.

## Direction

Do all three parts, in this order — they are one change, not a menu.

**Make `publishStrand` a no-op when an identical live row is already present.** Read the row
first; when `(Type, MemberPrivateKey)` match, log and return. When they differ, throw an error
that names the mismatch rather than surfacing `UNIQUE constraint failed: Strand.Id`. Read and
insert are not atomic, so also handle the losing side of a genuine race — two machines of one
party founding the same id concurrently — by catching the unique-constraint rejection, re-reading,
and no-op'ing only if the landed row matches; otherwise rethrow. Do not turn a race into a
silent overwrite.

**Give founding one entry point so callers stop re-deriving the sequence.** A `foundStrand` on
`CadreNode` that reads-or-publishes, reuses a stored `MemberPrivateKey` when the row already
exists, and then calls `addStrand(..., founder: true)`. This is what makes the closed path
resumable and what closes the headerless-strand arm. `AGENTS.md` says there is no
backwards-compat obligation yet, so changing `publishStrand`'s `void` return to hand back the
resolved row is on the table if that reads better than a second method — decide during
implementation and say which in the review handoff.

**Move the reference apps onto it, and document the two-step contract.** RN open and closed, plus
web closed, all go through the one entry point. The `publishStrand` docstring must say plainly
that founding is two steps, that publishing is idempotent for identical content, and what a
mismatch means.

## TODO

- Add a content-equality no-op branch to `CadreNode.publishStrand`, keyed on a live-row read of
  `(Type, MemberPrivateKey)`; throw a mismatch-naming error otherwise.
- Handle the concurrent-founding race: catch the unique-constraint rejection, re-read, no-op only
  on a content match, rethrow otherwise.
- Add `CadreNode.foundStrand` (read-or-publish, then `addStrand` with `founder: true`), reusing
  the stored `MemberPrivateKey` for a closed strand that is already published.
- Point `reference-app-rn/src/chat-strand.ts` (both `createChatStrand` and
  `createClosedChatStrand`) and `reference-app-web/src/lib/cadre-web.ts`'s
  `createClosedChatStrand` at it.
- Update the `publishStrand` docstring: two-step founding, idempotency rule, mismatch semantics,
  and the pointer to the single entry point.
- Tests in `packages/cadre-core/test/publish-strand.spec.ts`: repeat-identical-open is a no-op and
  leaves one row; repeat-identical-closed is a no-op; repeat with a different `Type` throws and
  names the mismatch; repeat with a different `memberPrivateKey` throws; unpublish-then-republish
  still re-seats; `foundStrand` twice yields one row and `Strand.Header` at 1.
- Decide `publishStrand`'s return shape (`void` vs. the resolved row) and record the choice in the
  review handoff.
- Write the recovery note for users already stuck (attach, do not republish; `unpublishStrand` is
  destructive for closed strands) — the docstring is the right home.
- **Needs a human before it happens:** reply on gotchoices/sereus#12 with the decision, since the
  reporter is carrying a local patch. Draft the reply in the review handoff; do not post it from
  an agent run.
