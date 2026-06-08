description: COMPLETE — RN discovered-strand auto-join. cadre-core gained a `strand:discovered` event + `CadreNode.publishStrand` (authority-signed Strand insert); the RN phone self-genesis as its own authority at startup, `createChatStrand` publishes the row, and `useCadreInternal` auto-joins discovered OPEN strands via `joinChatStrand`. Review found + fixed one correctness bug (blanket auto-join was also attaching CLOSED strands, bypassing the invitation/consent flow) and added the missing node-level `publishStrand` test coverage. Build + typecheck + full cadre-core suite (344) + lint all green.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/README.md
----

# Complete: RN discovered-strand auto-join

The RN README's claim that a second phone "sees the strand via control network
sync and auto-joins" is now backed by code: created strands are published to the
shared control DB (authority-signed `Strand` insert), the control-discovery seam
surfaces an unconfigured strand to the app as `strand:discovered`, and the RN
hook auto-joins discovered **open** strands.

## What shipped (implement)

### cadre-core (app-agnostic seam)
- **`types.ts`** — new `'strand:discovered': { strandId; strand: StrandRow }` on
  `CadreNodeEvents`.
- **`cadre-node.ts` `handleStrandAdded`** — the no-`sAppConfig` branch now emits
  `strand:discovered` (carrying the full row) instead of logging-and-dropping;
  the configured-strand auto-start path is unchanged.
- **`cadre-node.ts` `publishStrand(strandId, type='o', memberPrivateKey?)`** — the
  authority-signed `Strand` INSERT `addStrand` omits. Signs the canonical
  row-bound bytes via the crypto plugin, using `getSelfSigningKey()` (the ed25519
  key behind the PeerId / authority key). Throws loudly if not started, no signing
  key, or the control DB rejects the insert. Mirrors the existing
  `publishFormationInvite` exactly.

### reference-app-rn
- **`cadre-phone.ts`** — `startPhoneNode` runs `runAuthorityGenesis` after start
  (mirrors `cadre-cli start --authority` / reference-app-web). Fail-soft.
- **`chat-strand.ts`** — `createChatStrand` publishes the row **before** `addStrand`
  (publish-first → a publish failure never leaves a local-only strand).
- **`use-cadre.ts`** — `useCadreInternal` subscribes to `strand:discovered`, joins
  via `joinChatStrand`, double-join-guarded, surfaces failures.
- **`README.md`** — publish → `strand:discovered` → auto-join flow documented,
  with honest notes on the demo authority model and cohort-convergence dependency.

## Review findings

Approach: read the implement diff (`dc3c3c3`) with fresh eyes before the handoff
summary; traced `publishStrand` against the established `publishFormationInvite`
path, the `StrandWatcher` emit semantics, the closed-strand consent flow, and the
docs the change touched (and *should* have touched).

### Correctness / behavior
- **[MAJOR → fixed inline] Blanket auto-join attached CLOSED strands too,
  bypassing the invitation/consent flow.** `onDiscovered` in `use-cadre.ts`
  called `joinChatStrand` for *any* discovered strand. But closed strands are
  also published to the control DB (`createClosedChatStrand` →
  `publishStrand(id, 'c', memberKey)`), and `queryStrands` returns the
  `MemberPrivateKey`, so the event carries everything needed to attach. Net: as
  soon as a host created a closed strand, every other phone's watcher would
  auto-join it with no `formStrand` handshake — short-circuiting the entire
  `createClosedStrandWithInvite` / `joinViaInvite` consent machinery (in
  `complete/reference-app-rn-closed-strand-consent-demo`). **Fix:** `onDiscovered`
  now guards `if (strand.Type !== 'o') return;` — only open strands ("anyone can
  participate") auto-join; closed strands must go through the explicit invitation
  path. (`use-cadre.ts`)
- **[noted, no action] No retry on a failed auto-join.** `StrandWatcher` adds an
  id to `knownStrands` *before* invoking `onStrandAdded`, and `onDiscovered` only
  `console.warn`s on failure — so a transient join failure is never re-attempted
  until restart. This is pre-existing watcher behavior (it equally affects the
  configured-strand `launchStrand` path, which emits `strand:error`), not a
  regression introduced here; acceptable for the demo. Flagged for awareness if
  convergence robustness is later hardened.
- **[verified benign] Self-discovery race.** The publishing node's own 5s-interval
  watcher cannot observe the row before its own config is registered:
  `createChatStrand` awaits `publishStrand` then calls `addStrand`, which sets
  `sAppConfigs` synchronously — no macrotask timer can interleave that microtask
  chain. The `use-cadre` double-join guard + idempotent `startStrand` (returns the
  existing instance) cover any residual case. No action.

### Test coverage
- **[added] `publish-strand.spec.ts` (4 tests)** — closes the implementer's
  flagged "highest-value gap" (the node-level `publishStrand` had no automated
  test). Mirrors `publish-formation-invite.spec.ts`: happy path (row lands and is
  surfaced by `queryStrands`, the read the watcher uses), closed-strand member-key
  persistence (`queryStrand` returns `Type:'c'` + `MemberPrivateKey`), unauthorized
  rejection propagates (not-enrolled node → `Strand.Authorized` rejects, no row
  written), and not-started throws. All green.
- Existing `cadre-node.spec.ts` discovery tests (emit on unconfigured strand / no
  emit on configured strand) re-confirmed passing.
- The RN `use-cadre.ts` auto-join (incl. the new open-only guard) has no unit
  harness in this repo; it is verified by typecheck + lint and exercised by the
  Maestro `_setup.yaml` e2e on a real emulator + drone. Real two-phone
  convergence remains not exercisable in-agent (needs devices + drone).

### Docs
- README publish/discovery flow + authority-model note: accurate, reflects the
  code. `docs/reference-app-rn.md` (drone joins via `strandFilter:all` control
  sync) is now actually backed by the publish path — no stale claim. Checked
  `docs/STATUS.md`, `docs/architecture.md`, `docs/strands.md`: no references to
  the old log-and-drop behavior, nothing to correct.

### Categories with nothing to report
- **Type safety** — clean; `publishStrand`/the guard add no `any`. The two
  `no-explicit-any` lint *warnings* at `cadre-node.ts:88,228` are pre-existing and
  outside this diff.
- **Resource cleanup** — the `strand:discovered` handler is added/removed in the
  same `useEffect` cleanup as the other three; `publishStrand` opens no resources.
- **DRY** — `publishStrand` intentionally mirrors `publishFormationInvite`; the
  shared seam is already factored (`getSelfSigningKey`, `insertStrand`'s signing
  callback). No extractable duplication worth the indirection.

## Validation (all green)
- `yarn workspace @serfab/cadre-core test` — **344 passed (28 files)** (incl. the
  4 new `publish-strand` tests).
- `yarn workspace @serfab/reference-app-rn typecheck` — clean.
- `eslint` on all changed files + the new test — 0 errors (only the 2 pre-existing
  `cadre-node.ts` warnings).

## Known gaps / follow-ups (unchanged from implement)
- **Real two-phone convergence not exercised in-agent** — needs devices/emulators
  + a running drone + the strand-level cohort bootstrap (prereq
  `bootstrap-dht-discovery-and-strand-cohort-wiring`, complete). Verify via
  `yarn test:e2e` or manual two-phone testing.
- **Demo authority model** — first node to enroll its key is the founding
  authority; a second phone can always JOIN an open strand but may not be able to
  PUBLISH a new one. Pre-existing genesis behavior, documented in the README.
- **`reference-app-ns` parity** — the NativeScript reference app has the same
  original unpublished-strand gap; out of scope here, left untouched (a follow-up
  could port the publish + genesis + discovery wiring, including the open-only
  auto-join guard).
- **`websocket-chat.integration.ts`** — still hand-dials strands; does not use the
  publish/discovery path. Unaffected by this change; remains the place to assert
  control-network strand discovery once cohort bootstrap is proven on the harness.

## End
