description: REVIEW — RN discovered-strand auto-join is now functional end-to-end in code. cadre-core gained a `strand:discovered` event + `CadreNode.publishStrand` (authority-signed Strand insert); the RN phone self-genesis as its own authority at startup, `createChatStrand` publishes the row, and `useCadreInternal` auto-joins discovered strands via `joinChatStrand`. Build + typecheck (cadre-core, reference-app-rn, integration-tests) + full cadre-core test suite (316) + lint all green. Real two-phone convergence not exercisable in-agent.
prereq: reference-app-rn-message-pk-collision-free, bootstrap-dht-discovery-and-strand-cohort-wiring
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/README.md
----

# Review: RN discovered-strand auto-join

The RN README's claim that "Phone B sees the strand via control network sync and
auto-joins" is now backed by code. Both gaps the implement ticket named are
closed: created strands are published to the shared control DB, and a discovered
strand surfaces to the app as an event it can act on.

## What changed

### cadre-core (the app-agnostic seam)

- **`types.ts`** — new event `'strand:discovered': { strandId: string; strand: StrandRow }`
  on `CadreNodeEvents`.
- **`cadre-node.ts` `handleStrandAdded`** — the no-`sAppConfig` branch now
  `emit('strand:discovered', { strandId, strand })` (carrying the full row)
  instead of logging-and-dropping. The configured-strand auto-start path is
  unchanged.
- **`cadre-node.ts` new `publishStrand(strandId, type='o', memberPrivateKey?)`** —
  the authority-signed `Strand` INSERT that `addStrand` deliberately omits.
  Signs the canonical row-bound message bytes (from `buildAuthorizationMessage`,
  handed to `insertStrand`'s callback) directly via the crypto plugin's `sign(...,
  'ed25519', 'bytes', 'base64url', 'base64url')`, using the keypair from the
  existing private `getSelfSigningKey()` (the ed25519 key behind the node's PeerId,
  which `authorityKeyFromLibp2p` also exposes as the authority key). **Throws
  loudly** if the node isn't started or has no signing key, and propagates the
  control-DB rejection if the key isn't an enrolled authority — by design, so a
  publish failure never leaves a silent local-only strand.

### reference-app-rn

- **`cadre-phone.ts`** — `startPhoneNode` now runs `runAuthorityGenesis` after
  `node.start()` (mirrors `cadre-cli start --authority` and reference-app-web's
  genesis): `authorityKeyFromLibp2p(privateKey)` → `controlDb.ensureAuthorityKey(pub)`
  → `cadre.initializeSeedBootstrap(priv)`. This is what makes the phone able to
  author the strand insert **and** (via seed-bootstrap) self-register its own
  `CadrePeer` row so the cohort can find it. Fail-soft (warns; the join path needs
  no authority), with the real failure resurfacing at `publishStrand` time.
- **`chat-strand.ts`** — `createChatStrand` now calls `cadreNode.publishStrand(strandId,
  'o')` **before** `addStrand`. Publish-first means a publish failure throws and no
  local-only strand is started (the masked-failure mode this replaces). `joinChatStrand`
  was already correct; this ticket gives it its first real caller.
- **`use-cadre.ts`** — `useCadreInternal`'s strand-event effect subscribes to
  `strand:discovered`; on fire it double-join-guards (`node.getStrands().has(id)`),
  calls `joinChatStrand(node, strand)` then `refreshStrands()`, and `console.warn`s
  on failure rather than eating it. Handler is added/removed alongside the existing
  started/stopped/error three.
- **`README.md`** — "Connecting Multiple Users" and Key Concepts → "Control network"
  now describe the publish → `strand:discovered` → auto-join flow, with an honest
  note on the demo authority model and the strand-level cohort-convergence
  dependency.

## How to validate (use cases)

### Unit (ran green — `yarn workspace @serfab/cadre-core test cadre-node`)
- **`emits strand:discovered when a watched strand has no registered config`** —
  calls the private `handleStrandAdded` with an unconfigured row, asserts one
  `strand:discovered` carrying the exact `StrandRow`. (No node start needed; the
  branch only reads the empty `sAppConfigs` map.)
- **`does not emit strand:discovered for a strand that has a registered config`** —
  stubs `launchStrand`, pre-seeds `sAppConfigs`, asserts the auto-start path is
  taken and NO discovery event fires. Guards against the two branches crossing.

### Suggested reviewer probes (not yet covered by automated tests)
1. **`publishStrand` happy path against a real control DB** — the closest existing
   exercise is `control-authorization-binding.spec.ts` (`db.insertStrand` happy
   path) and the integration harness `test-network.ts`. A focused cadre-core test
   that starts a node, runs genesis (`ensureAuthorityKey` + `initializeSeedBootstrap`),
   calls `node.publishStrand(id)`, and asserts the row lands in `Strand` (and that
   the StrandWatcher on the SAME node then takes the auto-start path, not a
   self-discovery) would lock down the new method. **This is the highest-value gap.**
2. **`publishStrand` failure surfacing** — a node that is NOT an enrolled authority
   (skip genesis) calling `publishStrand` should reject at the `Strand.Authorized`
   constraint; confirm the error propagates out of `createChatStrand` rather than
   being swallowed.
3. **Discovery → join wiring** — `use-cadre.ts` is RN/React and has no unit
   harness here; the behavior is validated only by the Maestro `_setup.yaml`
   ("discover the shared strand"), which needs an emulator + drone.

### Build / typecheck / lint (all ran green)
- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` — **316 passed (24 files)**.
- `yarn workspace @serfab/reference-app-rn typecheck` — clean.
- `yarn workspace @serfab/integration-tests typecheck` — clean.
- `eslint` on all 6 changed files — 0 errors (2 pre-existing `no-explicit-any`
  **warnings** at `cadre-node.ts:88,228`, unrelated to this diff).

## Honest gaps / things for the reviewer to weigh

- **Real two-phone convergence was NOT exercised in-agent.** It needs devices (or
  emulators) + a running drone, plus the strand-level cohort bootstrap from the
  `bootstrap-dht-discovery-and-strand-cohort-wiring` prereq (complete). The code
  assumes that wiring: `joinChatStrand → addStrand → launchStrand → resolveCohortSeed`
  seeds the strand node from `CadrePeer` rows. Verify on real devices via Maestro
  (`yarn test:e2e`) or manual two-phone testing.
- **Demo authority model.** Each phone self-genesis as its own authority; the FIRST
  node to enroll its key into the shared control DB is the founding authority, and
  later joiners that sync that key get a no-op `ensureAuthorityKey`. Net: a second
  phone can always JOIN a discovered strand (joining needs no authority) but may not
  be able to PUBLISH a new one. If two phones start solo and insert different keys
  before syncing, both become authorities (split-brain) — pre-existing genesis
  behavior, not introduced here. Documented in the README; confirm this is the
  intended demo posture.
- **Self-discovery race (benign).** `createChatStrand` publishes then `addStrand`s.
  In the sub-millisecond window between the two, the publishing node's own 5s-interval
  StrandWatcher could theoretically observe the row before the config is registered
  and emit `strand:discovered` to itself. The `use-cadre` double-join guard +
  idempotent `startStrand` (returns the existing instance) make this harmless. Chose
  publish-first over add-first-with-rollback for simplicity; reviewer may prefer the
  rollback variant if the self-discovery noise is undesirable.
- **`reference-app-ns` parity untouched.** The NativeScript reference app
  (`packages/reference-app-ns`) has its own parallel `chat-strand.ts`/`cadre-phone.ts`
  with the SAME original unpublished-strand gap. It is out of scope for this RN
  ticket and was deliberately not modified — flagging for awareness (a follow-up
  could port the same publish + genesis + discovery wiring).
- **`websocket-chat.integration.ts` still manual.** That test calls `addStrand`
  on both parties and hand-dials strand libp2p; it does not use the new
  publish/discovery path. Unaffected by this change (verified by typecheck), but it
  remains the place to eventually assert control-network strand discovery once
  cohort bootstrap is proven on the test harness.
