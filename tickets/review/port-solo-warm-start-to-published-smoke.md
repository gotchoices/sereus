---
description: The check that downloads our published packages and runs a real node against them now also covers the case of a phone that used to be in a group and is the only device left — the exact situation an outside team reported a freeze in.
prereq:
files: scripts/lib/published-smoke-scenario.mjs, scripts/smoke-published-install.mjs, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, docs/STATUS.md
difficulty: medium
---

# Review: solo warm-start ported into the published-install smoke scenario

## What landed

`scripts/lib/published-smoke-scenario.mjs` — the body `yarn smoke:published` copies into a
scratch project installed from packed tarballs plus the public registry — now carries **five**
cases instead of three. The two new ones are ports of
`packages/cadre-core/test/control-database-solo-warm-start.spec.ts`:

- **`solo warm start — start() then addStrand() with vanished prior-cohort peers on disk`.**
  Era 1 founds the party, registers self, and mints one signed-but-unreachable sibling at an
  RFC 5737 TEST-NET-1 address. Era 2 constructs a *fresh* `CadreNode` over the same temp
  directory, asserts the owner key and the full two-member set read back off disk, then goes
  `start()` → `addStrand()` with no genesis re-run and no `initializeSeedBootstrap` — the
  embedding app's order, so `resolveCohortSeed`'s `queryCadrePeers()` is the first control
  operation the app awaits. Asserts `instance.mode === 'networked'` and `status === 'active'`.
- **`solo cold boot — addStrand() before any genesis, in the embedder order`.** Same order with
  the stale rows removed: `hasOwnerKey()` false, `addStrand()` → `bootstrap`/`active`, then
  genesis and `registerSelf()` still accepted afterwards.

Both run over `FileRawStorage` under a `mkdtemp` directory removed in a `finally`, so only bytes
on disk cross each restart boundary. Both keep the labelled deadlines (`HANG: solo control op
<label> timed out after <n>ms`); `addStrand` gets its own `ADD_STRAND_TIMEOUT_MS = 60_000`
because it brings a second libp2p node up.

**Note on where the diff is.** The scenario file itself was written by the interrupted prior run
and is already committed in `0fb4b1e` ("tess: agent error … added resume note"); it does **not**
appear in this ticket's working-tree diff. Review it at its current contents, not as a diff
against `HEAD`.

## The minting route taken, and what it costs

The ticket offered two routes for minting the throwaway sibling. **Route 1 was taken**: add
`@libp2p/crypto` and `@libp2p/peer-id` to `SCENARIO_DIRECT_DEPS`, so the port is a faithful copy
of the spec's `mintBlackholePeer` — a signed `CadrePeer` record inserted through
`getSeedBootstrapService().insertSelfPeerRecord`, followed by the spec's **anti-vacuity
assertion** that `resolvePeerAddrs(peerId)` returns exactly the recorded addresses. Route 2
(`authorizePeer` on a peerId harvested from a throwaway second node) would have avoided the two
dependencies but writes `Sig: null`, so `resolvePeerAddrs` returns `[]` and the sibling row is
never proven real.

`@optimystic/db-p2p-storage-fs` was added to `SCENARIO_DIRECT_DEPS` as the ticket specified — no
memory fallback. It is also the one `@optimystic/*` with no root `resolutions` entry, so unlike
the others it genuinely resolves from the registry in every run, linked workspace or not.

`EXTRA_REPORTED` in `scripts/smoke-published-install.mjs` also gained `@libp2p/crypto` and
`@libp2p/peer-id`, so the pre-scenario version report shows which copy of each the scratch
project resolved. That is a judgement call beyond the ticket's list: a peerId minted against one
copy of `@libp2p/peer-id` while `@serfab/cadre-core` holds another would otherwise surface only
as a baffling assertion failure.

## What the port does NOT cover, relative to the vitest spec

Stated plainly, because this is the thing most likely to be misread as "the smoke covers the
warm-start suite":

- **Four of the six spec cases are not ported**, by design (the smoke is a release step and each
  case costs wall clock in a scratch install): the **revoked** prior cohort (`Revocation` join
  hiding rows, mode dropping back to `bootstrap`), the **closed** strand founded as the last
  member standing (founder `Member` row seated against an empty seed), the **three-sibling**
  variant, and the re-issue queue's **restart durability**. If a substrate regression lands in
  the revocation join or in closed-strand founder bootstrap, `yarn smoke:published` will not see
  it — only the vitest suite will.
- **The sApp signing key comes from a different generator.** The spec mints it with
  `@optimystic/quereus-plugin-crypto`'s `generatePrivateKey`; the port bridges the libp2p keypair
  it already has through cadre-core's published `ed25519KeyPairFromLibp2p`. Same key type and
  same base64url encoding, one fewer scratch dependency — but it means the port does not exercise
  `quereus-plugin-crypto`'s own key generation as installed from the registry.
- **`expectNotListening`'s exact failure text and vitest's diffing** are gone, as they were for
  the three existing cases; assertions are `node:assert/strict`.

## Validation actually run

- **`node scripts/lib/published-smoke-scenario.mjs` against the linked workspace: 5/5 pass.**
  Cadre-of-one cases 78 / 170 / 86 ms; warm-start vanished 3848 ms; cold boot 3606 ms. So the
  scenario body adds ~7.5 s of wall clock to a smoke run.
- `yarn lint` — clean.
- `yarn typecheck` — clean (281 test files across 10 packages in-program).
- `yarn test:published-smoke-support` — 23/23.
- `declaredRange()` resolves all five `SCENARIO_DIRECT_DEPS` with no cross-workspace
  disagreement (`@optimystic/db-p2p` `^0.22.0`, `db-p2p-storage-fs` `^0.22.0`,
  `@libp2p/websockets` `^10.1.3`, `@libp2p/crypto` `^5.1.13`, `@libp2p/peer-id` `^6.0.4`), so
  the scratch project's `package.json` is writable — that call throws on disagreement and would
  otherwise fail the run before npm ever installs.

## Known gaps — please treat these as the review's starting points

- **`yarn smoke:published` was never run end to end, and cannot be.** It still fails at HEAD on
  `ERR_MODULE_NOT_FOUND: Cannot find package 'chai'` when importing `@serfab/cadre-core` from a
  registry install (`tickets/blocked/optimystic-testing-barrel-breaks-consumer-install`), and per
  `docs/STATUS.md` installing `chai` by hand to get a green run is forbidden — it hides the exact
  defect the script exists to catch. **So the whole point of this port — that the warm-start shape
  runs against the substrate a customer installs — remains unproven.** What is proven is that the
  scenario body is correct and that the scratch project can be *described* (deps resolve, ranges
  agree). The registry half unlocks only when the `chai` defect clears.
- **The `--keep`/install path was not exercised with the three new dependencies.** Nothing
  confirms npm can actually install `@optimystic/db-p2p-storage-fs@^0.22.0`, `@libp2p/crypto` and
  `@libp2p/peer-id` into the scratch project from the public registry alongside the tarballs —
  that is downstream of the `chai` import failure but *upstream* of it in the script's order, so
  a reviewer with network could confirm just the install half by running `yarn smoke:published
  --keep` and reading the install log before the scenario crashes.
- **Temp-directory teardown on Windows is a plausible flake source.** `rmSync(dir, {recursive:
  true, force: true})` runs immediately after `node.stop()`. `force` swallows `ENOENT`, not
  `EBUSY`; if a `FileRawStorage` handle outlives `stop()` on a slower machine, the teardown
  throws and fails an otherwise-passing case. It did not fire across the runs here.
- **`Math.random()` for party and strand ids** is carried over from the spec's helpers. Fine for
  collision avoidance within a run; not a claim about anything.
- **The scenario file is still outside lint's reach** (`tickets/backlog/debt-tooling-scripts-unlinted-and-unchecked`),
  so its style was matched by hand against the existing three cases rather than enforced. It was
  syntax-checked (`node --check`) and executed.

## Cross-reference pointers updated

Nothing enforces that the spec and the port agree; the pointer comments are the whole mechanism,
and all three were updated:

- `scripts/lib/published-smoke-scenario.mjs` header — the "NOT yet ported" paragraph is gone,
  replaced by the keep-in-step wording naming both source specs and which two of the six cases
  are here (done in the prior run's commit).
- `packages/cadre-core/test/control-database-solo-warm-start.spec.ts` header — now points forward
  at the port, names the two ported cases, and says why the other four stay spec-only.
- `docs/STATUS.md` — the `- [ ] Not yet ported` bullet under "Control DB liveness" is folded into
  the surrounding prose of the `- [x]` bullet above it; "Installing what a customer installs" now
  describes the five-case scenario, the three added scratch dependencies with the reason each is
  there, and the rejected `authorizePeer` route. The "as of 2026-08-03 it fails" bullet now says
  how the scenario is verified out-of-band and, explicitly, what that verification does not prove.

## Worth a reviewer's attention

- Does the `mode === 'networked'` assertion in the vanished case still bite? It is the one line
  separating this case from a rename of the cadre-of-one restart case. It passed here, which
  means the disk rows were genuinely read back — but confirm the anti-vacuity guard
  (`assertWarmState`) really precedes it and really compares the full member set.
- The port's `foundCohort` returns bare peerId strings where the spec returns `OfflinePeer`
  objects. Deliberate (the port never needs the addrs afterwards), but it is a place the two
  files have already drifted in shape, if not in behaviour.
