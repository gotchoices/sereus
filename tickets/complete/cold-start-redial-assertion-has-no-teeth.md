---
description: A test that is supposed to prove a phone can rejoin a party after its first connection attempt is turned away now actually depends on the rejoin code — switching that code off makes the test fail. Three test helpers that silently ignored a setting they were told to turn off were fixed at the same time.
files: packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/cadre-core/src/cadre-node.ts, docs/architecture.md, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
---

# Complete: cold-start redial scenario now has teeth

## What landed

**The scenario now measures the code it names.** `control-cohort-cold-start-retry.integration.ts`
gained a step 3b between "confirm the first dial was refused" and "the owner vouches the joiner":
it deletes the owner's entry from the joiner's libp2p peerStore and polls until that store really
holds no address for the owner. Before this, a second dialer — p2p-fret's stabilization loop,
which dials by bare peer id off exactly that peerStore entry — reconnected the joiner on its own,
so the final assertion passed even with `CadreNode.dialColdStartBootstrap` disabled. The two
dialers have independent address sources (`dialColdStartBootstrap` reads cadre-core's own
`bootstrapPeerStore`), which is what lets the strip remove one and leave the other.

**Three test helpers stopped dropping `enableRelay: false`.** `rbac-signed-write:54`,
`strand-formation-e2e:131`, `strand-membership-closed-strand-e2e:185` each tested the flag for
truthiness, so an explicit `false` was silently discarded and the node fell back to its profile
default (relay **on** for storage nodes). Now forwarded on `!== undefined`, matching the harness
helper. Latent-only: no caller passes `false` to those three today.

**A tripwire, not a ticket**, at `cadre-node.ts:2438`: a connection this node still holds in
`status: 'open'` after the remote aborted it counts as connected in the cold-start skip check, so
the retry stays suppressed for that peer until the connection monitor's next ping (~9 s). Bounded
and self-healing; the `NOTE:` names the two conditions that would make it matter.

**The feature fact reached `docs/architecture.md`.** The cold-start branch is *not* the only path
that recovers a stranded joiner in the field — while the libp2p peerStore still holds the owner's
address, FRET's probes reconnect on their own within seconds. The branch is load-bearing for what
those probes cannot serve: aged-out peerStore entries, and a process restart (the peerStore is
in-memory; `BootstrapPeerStore` persists). Recorded in the "Cold-start bootstrap retries" bullet,
which previously claimed this scenario proved the branch without qualification.

## Review findings

### Acceptance re-verified independently (the point of the ticket)

The implement handoff measured red once and said so. Re-measured here from scratch, on the final
reviewed tree:

| configuration | result |
|---|---|
| branch intact | **green**, 4.1 s (and again at 5.3 s, and once more inside the four-suite run) |
| `dialColdStartBootstrap` short-circuited before its dial loop, `@serfab/cadre-core` rebuilt | **red** — `Timeout waiting for B re-dials A from its retained seed addresses after 45000ms` |
| suppression removed, rebuilt | **green** |

`cadre-node.ts` was restored from a byte copy; its md5 matches the backup and `git diff` on that
file is empty, so the committed `NOTE:` is the only change to it. Note for anyone repeating this:
an early `return` at the very top of the method — the recipe written into the module doc — does
not compile. TypeScript loses the narrowing the rest of the method depends on and emits four
`possibly undefined` errors. Suppress after the guard block instead.

That closes the handoff's stated "red measured 1/1" gap: two independent red observations now
exist, from different agents on different trees.

### Fixed in this pass (minor)

- **Peer-id round trip removed.** Step 3b parsed `peerIdFromString(aPeerId)` three times per poll
  iteration to rebuild an object the test already had — `A.peerId` is a `PeerId`. Now captured
  once as `aPeer` and used directly; the `@libp2p/peer-id` import the change had added is gone
  again, and the poll body collapsed from a five-line if/return to one expression.
- **Duplicated prose collapsed.** The module doc's eight-line "ABOUT THE FEATURE" paragraph was a
  feature-level fact sitting in a test file. Moved to `docs/architecture.md` where that feature is
  described, and replaced in the module doc by a four-line pointer.

### Filed (major)

- **`tickets/backlog/debt-scenario-node-config-builders-duplicated.md`** — architecture-first
  reading of the `enableRelay` arm. The bug needed fixing in four places because the same
  test-node config builder is copy-pasted four times (two of the copies are byte-identical). The
  invariant that retires the whole class is one builder, not three more careful copies; the only
  real blocker is that the harness helper cannot accept a caller-supplied storage provider.
  Site-claim grep over `backlog/ fix/ plan/ implement/ review/` found nothing already touching
  those paths.

### Checked and clean

- **Every `enableRelay` forwarding site in the repo** — grep finds four, all now on
  `!== undefined`. None missed.
- **libp2p peerStore API** — `delete` / `has` / `get` / `all` all exist as used on
  `@libp2p/interface@3`; `delete` removes the whole record, which is what makes FRET's
  `hasAddresses` test fail.
- **Step 3b's placement** — must sit between step 3 and step 4, and does. The handoff's stated
  reason is right but weaker than the real one: before the vouch, a FRET dial cannot *succeed*
  anyway, because the owner's gate still denies the joiner; after the vouch the peerStore entry is
  already gone. That ordering is what makes the window safe, not luck about timing.
- **The 5 s poll after the delete** looks like belt-and-braces over an already-awaited write, and
  it is — but it costs nothing and converts a future libp2p API drift into a loud 5 s failure
  instead of a silently un-teethed test. Left alone deliberately.
- **`docs/architecture.md`'s claim** that this scenario proves the branch was false when written
  and is true now. Qualified rather than removed, per above.
- **`packages/integration-tests/dist/`** still holds the stale `KNOWN GAP` text; it is
  `.gitignore`d build output, not source. No action.

### Checked, nothing found

- **Resource cleanup** — the scenario's `finally` stops both nodes; step 3b adds no handle, timer,
  or listener to clean up.
- **Error handling / type safety** — `yarn workspace @serfab/integration-tests typecheck` exit 0,
  no `any` introduced, no swallowed exception added. `waitUntil` swallows a throwing condition by
  design (pre-existing) and still times out loudly.
- **Source hygiene beyond the module doc** — the scenario is 213 lines, down 5 from the handoff.
  `cadre-node.ts` is 5485 lines and grew by 7 comment lines; that file's size is already tracked
  by `debt-cadre-node-single-file-size`, so it is not re-filed here.

### Not done, and why

- **No full integration-suite run.** Only the four affected files were exercised. The full suite
  runs well past the 10-minute agent budget and has a documented pre-existing red set
  (`tickets/.pre-existing-known.md`).
- **Windows only.** Every run was Windows/PowerShell. One peerStore delete is not
  platform-sensitive, but no Linux or CI run backs that up.
- **Flake surface untouched.** Step 5 still polls at 250 ms inside a 45 s budget; observed margin
  is ~4 s, roughly 10× headroom. Still a real network test, not a deterministic one.

## Validation

- `yarn workspace @serfab/integration-tests typecheck` — exit 0
- `eslint` over all five files the ticket touched — exit 0
- `yarn workspace @serfab/cadre-core build` — exit 0 (twice: with the suppression, and restored)
- `yarn workspace @serfab/integration-tests test` over `control-cohort-cold-start-retry`,
  `rbac-signed-write`, `strand-formation-e2e`, `strand-membership-closed-strand-e2e` —
  **4 files, 30 tests, all passed**, 92.5 s

No pre-existing failures were encountered, so `tickets/.pre-existing-error.md` was not written.
