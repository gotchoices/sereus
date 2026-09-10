----
description: Nothing records that this app was the one that created a shared network, so after a restart the app can rejoin its own network as an ordinary participant — and the call that is supposed to finish the setup then reports success while doing nothing, leaving the network permanently missing its founding records.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/src/use-cadre.ts, docs/architecture.md
difficulty: hard
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: The observable damage today is a missing provenance row on open strands, which nothing currently reads — a maintainer could reasonably decide that persisting founder state everywhere, and the migration that implies, is a large price for a row nobody queries yet, and wait until closed strands are the ones actually hitting it.
----

# A strand this node founded can come up as a joiner, and `foundStrand` won't notice

## Background in one paragraph

Creating a strand takes two writes: publish its `Strand` row to the party's shared control
database so every machine can see it, then start the strand locally *as its founder*, which
runs a one-time bootstrap writing the strand's own `Header` row (and, for a closed strand,
the founding `Member` and `Manager`). A machine that merely *joins* a strand someone else
created skips that bootstrap and receives those rows by sync. `CadreNode.foundStrand`
(added by `strand-founding-resume-path`) does both writes in one call and is safe to re-run
— that ticket fixed the case where an app killed between the two writes could never retry.

## What is still wrong

`foundStrand` can only found the strand if it is the call that actually *launches* the
local instance. If something already launched it as a joiner, `foundStrand` returns that
joiner instance and reports success — the bootstrap never runs, and the strand stays up
with no `Header`.

The single site is `CadreNode.launchStrand` (`packages/cadre-core/src/cadre-node.ts`, the
`const existing = this.strandManager.getInstance(strand.Id)` early return): it hands back an
already-tracked instance and silently discards the `founder` flag it was asked for. It has
no other option — founder-ness is not recorded anywhere a running instance can be asked
about, so it cannot tell "already founded, nothing to do" from "attached as a joiner, needs
founding".

Two ways something else launches first:

- **The app attaches it itself.** Nothing in the `Strand` row records which machine
  published it, so an app restarting and seeing its own orphaned strand come back over the
  control network cannot tell it apart from another party's strand. The reference React
  Native app's `strand:discovered` handler (`packages/reference-app-rn/src/use-cadre.ts`)
  therefore attaches, deliberately — founding another party's strand would write a second
  `Header` before sync delivered theirs. This arm is limited to open strands; that handler
  ignores closed ones.
- **This node's own strand watcher.** `foundStrand` publishes the row *before* calling
  `addStrand`, and `addStrand` registers the sApp config before `launchStrand` awaits
  `resolveCohortSeed` — a network round. A watcher poll landing in that window finds the row
  newly visible and the config registered, so `handleStrandAdded` auto-launches it with no
  `founder` flag. The default poll interval is 5s (`strandWatchInterval`); the window is as
  wide as the cohort-seed round takes. This arm applies to closed strands too.

Publishing before attaching is deliberate and should stay — it is what stops a failed
publish from silently leaving a local-only strand no peer could ever join.

## Why it matters

For an **open** strand the loss is the `Header` row: the strand's record of which sApp
(id, version, schema, signature) it runs. Nothing reads it today, which is why this has gone
unnoticed.

For a **closed** strand the loss is larger — the bootstrap also seats the founding `Member`
and `Manager`, and the schema's bootstrap branch that lets those first rows be written
without a signature is narrow (at most one `Member`, at most one `Manager`, that `Member`
being this `Manager`). A closed strand that comes up without them has no manager, so it can
never admit anyone, and the membership key on its control row is the only copy.

## Reproduction

`packages/cadre-core/test/publish-strand.spec.ts` →
`'KNOWN GAP: founding a strand already ATTACHED as a joiner leaves it headerless'`. It
publishes a row, attaches it with plain `addStrand` (what the RN handler does), then calls
`foundStrand` and asserts the `Header` count is **0** while the instance reports `active`.
The test passes today, characterizing the defect; when this ticket lands it should flip to
1 rather than being deleted.

The watcher-race arm is argued from the code, not reproduced — forcing a poll into the
`resolveCohortSeed` window needs a test seam that does not exist yet.

## What "fixed" should look like

Two rungs, and the first is what actually retires the class:

- **Make founder-ness representable.** Record, per strand, that this machine founded it —
  durably enough to survive a process restart, since that is exactly when the knowledge is
  lost. That single fact settles both arms: an app resuming its own orphan knows to
  re-found rather than attach, and the watcher's auto-launch can carry the right flag
  instead of defaulting to joiner. Where it lives is the open design question — a local
  store alongside the strand's data, or something on the control row itself, each with
  different consequences for a multi-machine party.
- **Stop the seam from losing the request silently.** `launchStrand` returning a tracked
  instance while dropping a `founder: true` it was handed is the mechanism that turns a
  missed launch into a silent wrong result. Once founder-ness is observable, that path
  should either satisfy the request (the bootstrap is insert-if-absent, so running it
  against an already-running instance is safe) or refuse it loudly — not ignore it.

Both reference apps and `docs/architecture.md` describe the gap in its current form; those
descriptions come out when it closes.
