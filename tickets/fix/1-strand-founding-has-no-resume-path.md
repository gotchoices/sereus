----
description: Founding a workspace takes two steps, and if anything interrupts the app between them the workspace can never be attached again — every later attempt fails on the step that already succeeded. Reported from a real phone session.
files: packages/cadre-core/src/cadre-node.ts, packages/reference-app-rn/src/chat-strand.ts, packages/cadre-core/src/control-database.ts
repro: verified
severity: corruption
likelihood: normal-use
----

# Strand founding has no resume path

Reported as **gotchoices/sereus#12** by an outside consumer, with a captured reproduction, a local
fix they verified against the stuck data set, and a survey of three consumers. Read the issue; this
ticket exists so the work has an owner here, not to restate it.

## The defect

Founding a strand is two calls: `CadreNode.publishStrand` inserts the control-plane `Strand` row
(`cadre-node.ts:3994`), then `addStrand` attaches the local instance and applies the sApp schema.
Nothing makes the pair resumable.

Interrupt between them and the control row exists with no local instance. The only path the app has
re-runs `publishStrand`, which fails:

```
UNIQUE constraint failed: Strand.Id
```

and does so on that launch and **every later one**. The strand cannot be attached again short of
wiping app data.

The reporter's session, which shows the asymmetry plainly:

```
09:14:12  [CadreService] ✓ owner genesis in 5447ms — OwnerKey already present, seed flows enabled
09:14:15  [chat-strand] creating default chat strand: 990f1240-…
09:14:16  [App] default strand not attached yet: 'UNIQUE constraint failed: Strand.Id'
```

Owner genesis is idempotent and says so. Strand founding is not.

## Why the window is wide, and why that is not the point

`addStrand` applies the sApp schema, which on React Native currently does not converge at all
(#8 / gotchoices/Optimystic#8 — 20+ minutes on a four-table schema). So the gap is minutes, not
milliseconds, and a force-stop, phone restart, OOM kill or Metro reload lands in it.

**This outlives that fix.** A fast apply narrows the window; it does not close it, the failure is
permanent rather than a retry away, and the remedy is in a different place.

## The signal worth acting on

Three consumers reached three different orderings and only one is safe:

| consumer | what it does |
| --- | --- |
| `packages/reference-app-rn/src/chat-strand.ts` | unguarded in **both** founding paths — open at `:97`, closed at `:155`. Bricks on interruption, and this is the pattern being copied |
| Sereus Chat | was unguarded, copied from the reference; now checks `queryStrand` first |
| Health (`apps/mobile/src/services/CadreService.ts`) | a third way — a persisted `STRAND_FOUNDED_KEY` flag, publish placed *after* founding, call wrapped fail-soft |

As the reporter puts it: three consumers arriving at three different orderings, only one safe,
suggests the contract is not discoverable from the API rather than that two of them were careless.
That is an *Architecture first* argument — fix the representation, not the three call sites.

## Direction

The reporter's own ranking, which reads correctly to me:

1. **Make `publishStrand` idempotent for identical content.** Re-publishing the same `strandId` with
   the same type and member key *is* the already-published state, not a conflict; a no-op there makes
   founding resumable for every consumer with nothing to remember. `unpublishStrand` stays the way to
   actually change it. This is the rung that retires the class.
2. Failing that, a found-or-resume helper so the sequence has one entry point.
3. At minimum, guard both `reference-app-rn` call sites and document in the `publishStrand` docstring
   that founding is two steps and the caller owns the resume.

Prefer 1. Do 3 regardless — the reference app is the thing being copied, and leaving it as the one
unguarded consumer of three is what propagated this.

## What the fix pass must establish

- **What "identical content" means, exactly.** `publishStrand(strandId, type, memberPrivateKey)`
  writes an owner-signed row. Re-publishing with the *same* id and a *different* type or member key
  must still be a conflict — silently accepting that would let a closed strand be reopened, or its
  read-gating key be swapped, by a caller that thinks it is retrying. The idempotent case is
  byte-identical content and nothing else.
- **Whether the row can be present but not owner-signed by us**, or present from another member of
  the party via replication, and whether resuming onto someone else's row is safe.
- **Whether `addStrand` is itself idempotent** on a second attempt after a partial schema apply. The
  issue only proves the `publishStrand` half; if `addStrand` also strands state, fixing one leaves
  the bug reachable by a slightly different interruption.
- Whether `unpublishStrand` + republish is a viable recovery today for users already stuck, and
  whether that path needs documenting for them regardless of the fix.

## Edge cases & interactions

- Two machines of one party founding the same strand id concurrently — the idempotent branch must not
  turn a genuine race into a silent overwrite.
- A strand id previously unpublished (tombstoned): `cadre-node.ts:4026` says a fresh owner-signed
  publish re-seats it under a new stamp. Confirm the idempotency check does not resurrect a
  deliberately removed strand.
- The reporter fixed this locally with a `ControlDatabase.queryStrand(strandId)` pre-check. If we
  ship the idempotent publish, that guard becomes redundant but must not become *wrong* — a consumer
  already carrying it should keep working.

## TODO

- Reproduce the interruption directly, ideally without needing a 20-minute schema apply to widen the
  window.
- Decide between remedies 1 and 2 with the "identical content" question answered.
- Guard both `reference-app-rn` call sites either way.
- Reply on gotchoices/sereus#12 with the decision, since the reporter is carrying a local patch and
  should know whether to keep it.
