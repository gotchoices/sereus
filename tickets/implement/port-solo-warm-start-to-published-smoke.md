---
description: We have a new test for a phone that used to be in a group and is now the only device left. It runs against our own source tree, but not against the packages a customer would actually download — and that gap is exactly where the problem an outside team reported would live. Port the test so the download-and-run check covers it too.
prereq:
files: scripts/lib/published-smoke-scenario.mjs, scripts/smoke-published-install.mjs, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, docs/STATUS.md
difficulty: medium
---

# Port the solo warm-start-alone case into the published-install smoke scenario

## Why this exists

`packages/cadre-core/test/control-database-solo-warm-start.spec.ts` landed with the
`solo-warm-start-blocks-on-prior-cohort-peers` fix ticket. It builds the state an embedding
React Native team's device is in — once part of a cadre, now the only device left, restarting
on `CadrePeer` rows a previous session wrote to disk — and boots it in that app's order
(`start()` straight to `addStrand()`, so `CadreNode.resolveCohortSeed`'s `queryCadrePeers()`
is the control database's first awaited operation). **It does not hang.** Six cases, ~32 s.

That result narrows the remaining difference between us and them to one of two places: their
own code (three defects were reported to them separately), or the **substrate version they
install**. The second is not idle: the last time this team reported an unreproducible solo
hang, the cause was exactly that — `@serfab/cadre-core` declared an `@optimystic/*` range two
minors behind the workspace this repo links, so they ran a substrate nothing here tests
(`docs/STATUS.md` → "Installing what a customer installs").

`scripts/smoke-published-install.mjs` is the one thing in this repo that runs against a real
registry install, and today it only carries the three **cadre-of-one** cases ported from
`control-database-solo.spec.ts`. The shape the team actually reports is the one it does not
run. Closing that is this ticket.

## What the scenario file can and cannot import

`scripts/lib/published-smoke-scenario.mjs` is copied verbatim into a scratch project outside
this repo and run by plain `node`, so it may only import what a registry consumer can. The
scratch project's direct dependencies come from `SCENARIO_DIRECT_DEPS` in
`scripts/smoke-published-install.mjs`, currently `['@optimystic/db-p2p', '@libp2p/websockets']`,
plus every packed `@serfab/*` tarball. It has no vitest and no `src/` access, so the vitest
spec's `expect` becomes `node:assert/strict` and the deadline wrapper is re-derived on
`Promise.race` (both already done in that file — reuse them, do not add a third style).

Everything the port needs from cadre-core is already on the published surface — verified
against `packages/cadre-core/src/index.ts`:

| needed for | symbol | exported at |
| --- | --- | --- |
| minting a signed sibling record | `signPeerRecord`, `ed25519KeyPairFromLibp2p` | `index.ts:270`, `index.ts:31` |
| the strand launch's sApp config | `signSchema` | `index.ts:337` |
| a closed strand's member key | `generateStrandMemberKey`, `strandMemberKeyPair` | `index.ts:167` |

Two things the spec uses are **not** reachable, and each has a decision attached:

- **`FileRawStorage`** (`@optimystic/db-p2p-storage-fs`) is what makes the spec's restart a
  real one — each run builds a fresh handle over the same directory, so only bytes on disk
  cross the boundary, unlike every other "restart" in this repo, which shares one live
  `MemoryRawStorage` object across it. Add `@optimystic/db-p2p-storage-fs` to
  `SCENARIO_DIRECT_DEPS`. **Prefer this over falling back to a shared `MemoryRawStorage`**: a
  memory fallback would reduce the new case to the strength of the existing restart case, and
  the disk path is the half a registry install could plausibly differ on. Note while you are
  there that this package is the one `@optimystic/*` with no root `resolutions` entry (see the
  two `NOTE:`s in `docs/STATUS.md` around "declared range"), which makes it *more* interesting
  to exercise here, not less.
- **`generateKeyPair` / `peerIdFromPrivateKey`** (`@libp2p/crypto/keys`, `@libp2p/peer-id`) are
  how the spec mints a throwaway sibling identity. Two routes; pick one and say which in the
  handoff:
  1. Add both to `SCENARIO_DIRECT_DEPS`. Keeps the port a faithful copy of the spec, including
     the anti-vacuity `resolvePeerAddrs` assertion.
  2. Harvest a real peerId by standing up a throwaway second `CadreNode` on
     `MemoryRawStorage` and reading its `.peerId`, then record the sibling with
     `node.authorizePeer(peerId, addrs)` instead of a signed record. No new dependencies, but
     an `authorizePeer` row carries `Sig: null`, so `resolvePeerAddrs` returns `[]` and the
     dial path is never armed. That is **acceptable here** — the warm-start case is about
     membership and strand mode, not about dialing — but it must be stated in a comment so a
     later reader does not mistake it for the spec's stronger guarantee.

## What to port

Not all six cases — the smoke run is a release step, not a suite, and every case costs wall
clock in a scratch install. Port the two that carry the finding:

- **Vanished prior cohort.** Era 1 founds the party and records one unreachable sibling; era 2
  restarts alone, asserts the rows came back off disk, then goes `start()` → `addStrand()` in
  the embedder's order. Assert `instance.mode === 'networked'` and `status === 'active'`.
- **Cold boot in the embedder order.** `addStrand()` before any genesis at all, then genesis
  still accepted afterwards. Cheap, and it is the pure form of the boot-order hypothesis.

Keep the spec's **anti-vacuity guard**: before each case does its real work, assert the warm
node reads back its owner key and the full member set. A warm start that silently came up on an
empty control database would pass every liveness assertion while testing nothing — that is the
one way this port can go quietly useless.

Keep the labelled deadlines. A regression must read as
`HANG: solo control op <label> timed out after <n>ms`, never a silent stall. `addStrand` needs
a wider budget than the 15 s per-op one (the spec uses 60 s — it brings a second libp2p node up).

## Validation, and the pre-existing red

`yarn smoke:published` **fails at HEAD for an unrelated upstream reason** and has since
2026-08-03: importing `@serfab/cadre-core` from a registry install throws
`ERR_MODULE_NOT_FOUND: Cannot find package 'chai'`
(`tickets/blocked/optimystic-testing-barrel-breaks-consumer-install`). So a green
`yarn smoke:published` is not available to you and is not the bar.

- **Do NOT install `chai` into the scratch project to get a green run.** That hides the exact
  defect the script exists to catch. `docs/STATUS.md` already says so.
- Validate the scenario body instead by running it against the linked workspace, or with `chai`
  installed by hand purely to verify (that is how the existing three cases were last confirmed —
  all three passed in 87–206 ms).
- `yarn smoke:published` packs and installs; budget for a build. `--skip-build` reuses each
  `dist/` but is refused when any `dist/` is older than its `src/`.

## Cross-references, which are the only thing keeping these files in step

Nothing enforces that the spec and the port agree; both files carry a comment pointing at the
other, and that is the whole mechanism. Three pointers need updating once the port lands:

- `scripts/lib/published-smoke-scenario.mjs` header — replace the "NOT yet ported" paragraph
  added by the fix ticket with the normal keep-in-step wording.
- `packages/cadre-core/test/control-database-solo-warm-start.spec.ts` header — it currently
  names no port; add the pointer back.
- `docs/STATUS.md` — flip the `- [ ] Not yet ported to scripts/lib/published-smoke-scenario.mjs`
  bullet under "Control DB liveness" and fold it into the surrounding prose.

## TODO

- Add `@optimystic/db-p2p-storage-fs` to `SCENARIO_DIRECT_DEPS` in `scripts/smoke-published-install.mjs`; decide and record the sibling-minting route (new libp2p deps vs. `authorizePeer`).
- Port the **vanished prior cohort** case into `scripts/lib/published-smoke-scenario.mjs` on `node:assert/strict`, reusing that file's existing `within` deadline wrapper and failure-reporting blocks.
- Port the **cold boot in the embedder order** case the same way.
- Keep the anti-vacuity warm-state assertions (owner key + full member set read back off disk) in both.
- Register both in the file's `cases` array with names in the existing style, and give `addStrand` its own wider budget constant.
- Add temp-directory setup/teardown for the file storage (`mkdtemp` + `rm -rf`), so a scratch project is not left with block directories.
- Verify the scenario body runs clean — against the linked workspace, or with `chai` installed by hand solely to verify. Do not commit a `chai` install.
- Update the three cross-reference pointers listed above.
- Confirm `yarn lint`, `yarn typecheck`, and `yarn test:published-smoke-support` still pass (the scenario file itself is currently outside lint's reach — see `tickets/backlog/debt-tooling-scripts-unlinted-and-unchecked`).
- In the review handoff, state plainly which minting route you took and what the port therefore does *not* cover relative to the vitest spec.
