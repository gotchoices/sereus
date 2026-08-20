---
description: A test that is supposed to prove a phone can rejoin a party after its first connection attempt is turned away now actually depends on the rejoin code — it fails when that code is switched off. Three test helpers that silently ignored a setting they were told to turn off were also fixed.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
---

# Review: cold-start redial scenario now has teeth

Implemented exactly as the fix ticket specified — that ticket carried a prototyped and measured
remedy, so this was a write-up-to-code pass, not a re-investigation. All four arms landed.
Diff is 5 files, +76 / -15.

## What changed

**Arm 1 — the fixture gets teeth** (`control-cohort-cold-start-retry.integration.ts`):

- New **step 3b**, between the refusal settling (step 3) and A vouching B (step 4):
  `await B.getControlNode()!.peerStore.delete(peerIdFromString(aPeerId))`, followed by a 5 s
  `waitUntil` that B's libp2p peerStore really holds no address for A. Imports
  `peerIdFromString` from `@libp2p/peer-id` (already a declared dependency of the package).
- The strip is commented **at the site** as load-bearing, naming p2p-fret's stabilization loop
  as the dialer it removes and cadre-core's `bootstrapPeerStore` as the source it deliberately
  leaves intact, so a future reader does not mistake it for tidy-up and delete it.
- The module doc's `KNOWN GAP` paragraph was **replaced** (it described a gap that no longer
  exists) with four paragraphs: why the strip exists and what it removes, why the two dialers
  have independent address sources, the measured green/red numbers plus the re-verification
  recipe, and the doc-level finding about the feature (below).
- Step 5's comment now also cites step 3b as part of why the cold-start branch is the only
  remaining producer of the outbound connection.

**Arm 2 — three helpers stop dropping `enableRelay: false`.** Each
`...(opts.enableRelay ? { enableRelay: true } : {})` became
`...(opts.enableRelay !== undefined ? { enableRelay: opts.enableRelay } : {})`, matching the
already-fixed `controlNodeConfig` (`node-fixtures.ts:116`). Sites:
`rbac-signed-write.integration.ts:54`, `strand-formation-e2e.integration.ts:131`,
`strand-membership-closed-strand-e2e.integration.ts:185`.

**Arm 3 — tripwire parked in code, not filed as a ticket.** A `NOTE:` sits at the
`connected.has(peerId)` skip inside `CadreNode.dialColdStartBootstrap`
(`packages/cadre-core/src/cadre-node.ts:2438`) recording that a connection still held in
`status: 'open'` after the remote aborted it counts as connected there, suppressing the
cold-start retry for that peer until the connection monitor's next ping — measured ~9 s — and
naming the two conditions that would make it matter.

**Arm 4 — the feature finding is a doc fact, not a ticket.** Recorded in the scenario's module
doc: in a live deployment the cold-start branch is not the only recovery path. While B's libp2p
peerStore still holds the owner's address, FRET's stabilization probes reconnect a stranded
joiner on their own within seconds. The branch is load-bearing for what FRET cannot serve —
aged-out peerStore addresses, and process restart (peerStore is in-memory, `bootstrapPeerStore`
persists). Overlap, not redundancy.

## Validation performed

Everything below was run in this session, on the working tree as handed off.

**Acceptance (the point of the whole ticket) — the assertion now depends on the code.**

| configuration | result |
|---|---|
| `dialColdStartBootstrap` intact | **green**, 3.2 s |
| early `return` at top of `dialColdStartBootstrap`, `@serfab/cadre-core` rebuilt | **red**, `Timeout waiting for B re-dials A from its retained seed addresses after 45000ms` (test wall-clock 47.5 s) |
| suppression reverted, rebuilt, 3 consecutive runs | **green 3/3** — 4.35 s / 3.90 s / 3.86 s |

The red reproduces the fix ticket's measurement exactly: no dialer at all reconnects B to A
inside the full 45 s window once the peerStore address is gone. Before step 3b existed, the same
suppressed configuration went green in ~3.5 s. `packages/cadre-core/src/cadre-node.ts` was
restored from a byte-copy backup and rebuilt (`grep -c` for the suppression marker → 0, build
exit 0); `git diff` on that file shows the `NOTE:` block and nothing else.

**The three `enableRelay` suites, one run each, all green:**

- `rbac-signed-write.integration.ts` — 1 passed
- `strand-formation-e2e.integration.ts` — 22 passed
- `strand-membership-closed-strand-e2e.integration.ts` — 6 passed

As predicted, unchanged: no caller passes `enableRelay: false` to those three helpers today, so
the fix is latent-only.

**Other gates:** `yarn workspace @serfab/cadre-core build` (exit 0),
`yarn workspace @serfab/integration-tests typecheck` (exit 0), `eslint` over all five changed
files (exit 0). No pre-existing failures were encountered — every suite run in this session was
green, so `tickets/.pre-existing-error.md` was not written.

## Where to look hardest

- **Step 3b's placement is a correctness claim, not a preference.** It sits *after* step 3's
  "connection count is 0" poll and *before* step 4's `authorizePeer`. Earlier, and `applySeed`'s
  dial could still be in flight repopulating the entry; later, and FRET may already have
  reconnected. Worth a skeptical read.
- **The `waitUntil` after the delete tolerates two shapes** — entry absent, or entry present with
  `addresses.length === 0` — because libp2p's peerStore may recreate a bare record. If a libp2p
  upgrade ever makes `delete` leave addresses behind, this poll fails loudly at 5 s rather than
  silently un-teething the test; that is intended, but confirm you agree.
- **The claim "nothing re-populates the entry in between"** is argued in the module doc from
  three facts (identify needs a connection, `warmSiblingAddrBook` needs siblings, `applySeed`
  already ran). The red run corroborates it — but it is an argument, not an exhaustive
  enumeration of libp2p's peerStore writers.
- **The module doc is long.** It was already the longest part of the file and grew by ~40 lines.
  If a reviewer thinks the measurement table and re-verification recipe belong in
  `docs/testing.md` rather than the module header, that is a fair call — the fix ticket asked for
  them in the module doc, which is where they went.

## Known gaps / what was NOT done

- **The red measurement was taken once, not three times.** The fix ticket reported red 3/3 at
  `370ad30`; this session re-confirmed red 1/1 on the final tree. A 45 s timeout is not a
  marginal signal, but the asymmetry with the 3× green is real and stated rather than hidden.
- **Cross-platform:** all runs were Windows, via PowerShell and Git Bash. Nothing in the change is
  platform-sensitive (one peerStore delete), but no CI or Linux run backs that up.
- **Flake surface untouched.** Step 5 still polls at 250 ms inside a 45 s budget; observed margin
  is ~4 s, so headroom is roughly 10×, but this remains a real network test, not a deterministic
  one.
- **No integration-suite-wide run.** Only the four affected files were exercised — the full suite
  runs far longer than the 10-minute agent budget and has a documented pre-existing red set (see
  `tickets/.pre-existing-known.md`).
