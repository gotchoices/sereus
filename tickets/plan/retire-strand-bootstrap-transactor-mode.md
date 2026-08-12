----
description: A workspace started by a lone device runs on a private, local-only storage path instead of the normal shared one, and only switches over if the device happens to put it to sleep and wake it up again. Remove the special path and let the normal one handle the lone-device case, which it already does.
prereq:
files: packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-backfill.ts, docs/architecture.md, docs/strands.md
difficulty: hard
----

# Retire the strand `bootstrap` mode — one transactor, let the engine degrade

## What exists today

`StrandMode` (`packages/cadre-core/src/types.ts:646`) is `'bootstrap' | 'networked'`.
`selectStrandMode` (`packages/cadre-core/src/strand-cohort.ts:75`) picks it:

```ts
return explicitMode ?? (hasOtherPeers ? 'networked' : 'bootstrap');
```

`'bootstrap'` selects the Optimystic plugin's **local** transactor
(`strand-database.ts:25-31`, `:94`), backed by the same raw storage the networked path uses
(`strand-instance-manager.ts:344-345`). So a strand founded by a lone node reads and writes
entirely inside the process, with the peer-to-peer layer bypassed rather than merely idle.

This is a second, application-level answer to "how does a workspace scale from one machine to
many." Optimystic already answers it inside the engine: an isolated node resolves itself as
coordinator, skips the cohort read consult when the cohort is only itself, and skips the
super-majority gate at a cohort of one. Those paths are exercised on a real device — the
downstream report in `tickets/blocked/report-dependency-floor-bump-to-embedding-app` includes an
instrumented phone run where they all fire in single-digit milliseconds.

## Why retiring it is worth doing

**It is the wrong layer.** "A lone node serves itself" is a property of the storage engine, not of
Cadre. Keeping a parallel implementation here means two things to keep correct, two places to
diagnose, and — as the downstream report shows — a visible asymmetry that reads to an outside
integrator as *evidence that the other subsystem is broken*: strands work alone, the control
database has no equivalent mode, therefore the control database "must be missing a local path."
It is not; it uses the transactor that degrades. Retiring this mode removes the false lesson, and
the request it produced (add the same mode to the control database) should be declined rather than
implemented.

**The switch-over is not driven by anything reliable.** The mode is resolved at exactly two sites:
strand launch (`cadre-node.ts:3501`) and resume from hibernation (`cadre-node.ts:3011`). A strand
founded alone and left running therefore stays on the local transactor **after peers join** — there
is no cohort-growth trigger that relaunches it. Any node that disables hibernation (the
NativeScript reference app does) never re-resolves at all. Block backfill is gated the same way
(`strand-instance-manager.ts:375` runs it only when `mode === 'networked'`), so the peers do not
get the blocks by that route either. Whether this has bitten anyone in practice is unverified —
it is read from the code, and confirming or refuting it is part of this work (see below).

**It costs API surface for no capability.** `StrandMode`, the `mode` field on `StrandConfig`, and
`ResumeStrandOverrides.mode` (`strand-instance-manager.ts:85`) exist only to carry this choice.
An sApp author should not have to know the concept exists — which is the whole point of doing it
in the engine.

## What "done" looks like

- A strand runs on one transactor — the network one — regardless of how many machines are in the
  cohort. Solo is not a mode, it is a situation the engine handles.
- A lone node's strand reads and writes stay **fast**. This is the acceptance bar, not a hope:
  measure a solo strand's insert and select latency before and after, and state both numbers. If
  the network path is materially slower solo, that difference is the real ticket and this one
  should stop and hand off to it rather than shipping a regression.
- No strand needs a restart, a resume, or a hibernation cycle to start replicating once a second
  machine appears.
- `StrandMode` and its plumbing are gone, or reduced to whatever genuinely still needs to vary.
- The control database gains **no** equivalent mode.

## Known dependency outside this repo

Optimystic's isolated-node write path still pays a coordinator retry window before selecting
itself in some configurations — filed there as
`isolated-coordinator-lookup-pays-futile-retry-window`. That is latency, not correctness, and it
does not block this ticket; but it is the most likely reason a before/after measurement comes out
worse, so measure with a current linked workspace and say which version the numbers came from.

## Edge cases & interactions

- **Warm restart across the change.** A strand whose blocks were written through the local
  transactor must still read back through the network transactor on the next start. Both use the
  same raw storage, and the coordinator reads local storage first, so this is expected to work —
  but revision/metadata bookkeeping may not be identical between the two paths, and that is the
  one place a silent data-visibility regression could hide. Cover it with a restart test that
  writes under the old shape and reads under the new one.
- **Founder membership bootstrap.** `StrandDatabase` writes the founding `Header` /
  `Member` / `Manager` rows immediately after schema apply (`strand-database.ts:123-149`); that is
  a solo write by definition and must still complete promptly.
- **Block backfill.** With the mode gone, the `mode === 'networked'` gate at
  `strand-instance-manager.ts:375` needs a new condition or none at all — decide deliberately
  rather than defaulting to always-on.
- **Resume path.** `resumeStrandRuntime` re-resolves both the cohort seed and the mode; only the
  seed survives. Confirm nothing else keyed off the mode change to trigger work.
- **Launch failure cleanup.** `startStrand` drops the instance and its retained launch config on a
  failed launch so the id is free to retry; the retained config currently carries `mode`.
- **Open vs closed strands.** Closed strands carry a `MemberPrivateKey` and an explicit member
  list; open strands have neither. Confirm the solo path is the same for both.
- **The three reference apps** each launch strands differently (web browser storage, React Native
  LevelDB, NativeScript SQLite). A change to the transactor selection touches all three; the
  NativeScript app's `solo-smoke.ts` is the only on-device solo exercise of this path in the repo
  and should be run, not just the unit suites.

## What would confirm the switch-over gap

Start a node alone, create a strand (so it launches in `bootstrap`), then add a second cadre member
and write to the strand from the founder **without** hibernating or restarting it. If the second
member never observes the write, the gap is real as read. If it does, find out what re-resolved the
mode and say so — that mechanism would change this ticket's justification, though not its
conclusion.
