description: Several integration-test scenario files copy the same setup boilerplate (network transports, node config, authority bootstrap, peer-connection helpers); pull the shared pieces into the test harness so there is one copy to maintain.
prereq:
files: packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts
difficulty: easy
----

<!-- resume-note -->
THREE prior implement runs have now read the harness file and all 12 scenario files in
full and cross-checked the "## Verification (confirmed by prior session)" appendix
below against actual source. **All three hit the session's soft token budget before
making any edits — zero files have been changed by any of the three runs.** The
appendix is correct (verified byte-for-byte against live source three times, across
three separate sessions, including the multi-party-workflows correction below) — the
recurring failure is process, not content: serially re-reading all 13 files into one
context before touching a single Edit call reliably exhausts the budget first.

**Session 4 strategy change — do not repeat the same failure mode.** Do NOT start by
reading the harness file and 12 scenario files into your own context again. Instead:

1. Read `packages/integration-tests/src/harness/test-network.ts` yourself (one file)
   and apply the 8 new exports (`wsTransports`, `createSignedSAppConfig`,
   `ControlNodeOpts`, `controlNodeConfig`, `makeOwnOwner`, `randomPeerId`,
   `connectControlNodes`, `bootPair`) per the "Design" section below — this is the
   one file every scenario edit depends on, so land it first, directly, yourself.
2. For the 12 scenario files, dispatch one `Agent` (general-purpose or
   cavecrew-builder, your call) per file — in parallel batches of ~4-6 — each given
   ONLY that file's path and its exact per-file bullet copied verbatim from the
   "Verification" appendix below (plus the harness export signatures from "Design").
   Each subagent reads its own single file fresh and applies its own edit; none of
   them need the other 11 files or your context. This is what keeps your own context
   small enough to reach the typecheck/lint/test step instead of dying on reads.
3. After all subagents report back, run `yarn workspace @serfab/integration-tests
   typecheck` and `yarn lint` yourself (their output tells you if any subagent
   mis-transcribed an import), then run the tests per the Acceptance section.

The appendix below is final — do not re-verify it against source again before
editing; that re-verification is exactly what has burned three sessions' budget with
zero edits landed. The one correction already folded in: **in
`multi-party-workflows.integration.ts`, keep `generatePrivateKey` in the
`@optimystic/quereus-plugin-crypto` import (it's also called standalone at ~L235 for
Party A's strand member key, independent of the deleted `createSignedSAppConfig`) —
drop only `getPublicKey`.** `harness/index.ts` needs no changes (checked for name
collisions against `port-allocator.ts`, `test-party.ts`, `test-cadre-host.ts`,
`wait-utils.ts`, `types.ts` — zero matches).
<!-- /resume-note -->

## Design (resolved — implement as specified, no open questions)

Add the following exports to `packages/integration-tests/src/harness/test-network.ts`
(re-exported automatically through `harness/index.ts`'s existing `export * from
'./test-network.js'`), placed near the existing `waitForCrossNodeControlSync` /
`waitForCadrePeerConverged` free functions at the bottom of the file:

```ts
/** WebSocket + circuit-relay transports shared by every e2e/integration scenario. */
export function wsTransports(): Transformer[] // (or whatever the real libp2p transport factory return type is — match the existing scenario signatures)

/**
 * A properly signed sApp config with a NON-realtime `latencyHint` (`'interactive'`) —
 * realtime strands never hibernate, so any wake/hibernation scenario requires this.
 */
export function createSignedSAppConfig(schema: string, version: string): SAppConfig

export interface ControlNodeOpts {
  partyId: string;
  privateKey?: PrivateKey;
  bootstrapNodes?: string[];
  profile?: 'storage' | 'transaction';
  enableRelay?: boolean;
  listenAddrs?: string[];
  hibernation?: boolean;
  /** Override the proactive control-cohort reconcile cadence (ms). */
  reconcileMs?: number;
}

/** Build a `CadreNodeConfig` for one control-network test node. */
export function controlNodeConfig(opts: ControlNodeOpts): CadreNodeConfig

/**
 * Make a freshly-started node its own control owner (genesis): enroll its derived
 * public key in `OwnerKey` and wire seed-bootstrap with the matching private key, so
 * it can owner-sign `CadrePeer` inserts (and mint seeds). Returns the owner PUBLIC key
 * (base64url) — the key an enrollee pins into its node-local trusted-owner anchor
 * (`trustOwnerKeys`) so this owner's membership vouchers pass its authorized-member
 * predicate. Callers that don't need the anchor key (most current callers) simply
 * discard the return value.
 */
export async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<string>

/** A real Ed25519 peer id for a peer that is NEVER started (a pure row subject). */
export async function randomPeerId(): Promise<string>

/**
 * Establish a DIRECT control-network connection from `reader` to `writer` and wait
 * until BOTH sides report it, SCOPED to this specific peer pair (so the recipe stays
 * correct when several readers attach to one writer, e.g. a 3-node full-mesh
 * scenario). This is the test-only stand-in for production control-cohort discovery.
 * Both-sides confirmation is a hard precondition of a replicating write: only once
 * each peer sees the connection can the control collection's cohort span them and a
 * commit be non-local-only.
 */
export async function connectControlNodes(reader: CadreNode, writer: CadreNode): Promise<void>

/**
 * Boot node A (owner + writer, storage profile so it holds the CadrePeer blocks) and
 * node B (a plain READER — deliberately NOT its own owner, so every row it observes
 * must have arrived over the wire) on a fresh party, DISCONNECTED. A vouches B
 * (`authorizePeer`) right after B starts, so A's inbound connection gate later admits
 * B's dial. Caller owns shutdown (`A.stop()` / `B.stop()`) and owns connecting them.
 *
 * `partyId` is built as `${partyIdPrefix}-${tag}-<timestamp>`; pass `partyIdPrefix` to
 * keep an existing scenario's party-id namespacing (default `'ctrl'`).
 */
export async function bootPair(
  tag: string,
  partyIdPrefix?: string,
): Promise<{ A: CadreNode; B: CadreNode }>
```

These names/shapes are chosen to make each hoist a pure move with call-site parity —
verify against the current per-file source before landing:

- `wsTransports()` — byte-identical in all 10 scenario files listed above. Delete the
  local copy in each and import from `../harness/index.js` (already imported in most
  of these files for other harness helpers — extend the existing import).
- `createSignedSAppConfig()` — byte-identical (modulo object-literal key order,
  functionally identical) in `push-wake-e2e`, `strand-formation-e2e`,
  `rbac-signed-write`, `multi-party-workflows`, `strand-membership-closed-strand-e2e`.
  Delete local copies, import from harness. NOTE: `strand-formation-e2e.integration.ts`
  also has `createUnsignedSAppConfig` / `createTamperedSAppConfig` /
  `createWrongKeySAppConfig` — those are scenario-specific (deliberately-invalid
  variants used nowhere else); leave them local, just delete the one function that
  duplicates the harness version.
- `controlNodeConfig()` / `ControlNodeOpts` — replaces the `nodeConfig()`/`NodeOpts`
  pair in exactly 4 files: `push-wake-e2e`, `control-db-two-node-convergence`,
  `control-write-while-alone-convergence`, `control-cohort-auto-convergence`. The
  unified shape is push-wake's `NodeOpts` (superset: optional `privateKey`, optional
  `hibernation`) plus `control-cohort-auto`'s `reconcileMs` knob. For the 3 files that
  always pass `privateKey` and never set `hibernation`, the unified function produces
  byte-identical `CadreNodeConfig` output (optional field defaults to the same
  hardcoded value they use today — verify this explicitly for each call site, don't
  just assume). Do NOT touch the differently-shaped `nodeConfig()` /
  `createNodeConfig()` / `createTestNodeConfig()` helpers in `strand-formation-e2e`,
  `rbac-signed-write`, `multi-party-workflows`, `strand-membership-closed-strand-e2e` —
  those are a distinct (strand-scenario, not control-scenario) options shape and are
  legitimately scenario-family-local; the plan ticket's duplication table does not
  list them.
- `makeOwnOwner()` — present (same name) in all 4 control files above. 3 of them
  return `Promise<void>`; `push-wake-e2e`'s returns `Promise<string>` (the owner pub
  key, needed for `trustOwnerKeys`). Hoist push-wake's richer version; the 3 callers
  that don't need the return value just don't capture it — no call-site signature
  change required beyond dropping the local function and importing the shared one.
- `randomPeerId()` — byte-identical in `control-db-two-node-convergence`,
  `control-write-while-alone-convergence`, `control-cohort-auto-convergence`. Not
  present in push-wake (it derives peer ids from keys directly there) — no change
  needed in that file for this helper.
- `connectControlNodes()` — DIVERGED (see plan ticket problem statement): the
  `push-wake-e2e` copy is pair-scoped (`getConnections().some(c =>
  c.remotePeer.toString() === expectedPeerId)` on both sides); the
  `control-db-two-node-convergence` and `control-write-while-alone-convergence`
  copies just check `getConnections().length > 0` on both sides. Hoist the
  PAIR-SCOPED (push-wake) version as the one shared implementation — it is strictly
  more correct and behaves identically to the loose version in every CURRENT 2-node
  call site (there is exactly one connection to check either way). `control-cohort-auto-convergence`
  does not have this helper (it exercises the production auto-connect path with zero
  manual dials) — no change needed there for this helper.
- `bootPair()` — present in `control-db-two-node-convergence` (partyId prefix
  `ctrl-`) and `control-write-while-alone-convergence` (partyId prefix `ctrl-alone-`);
  otherwise byte-for-byte the same recipe. Hoist with a `partyIdPrefix` parameter
  (default `'ctrl'`) so `control-db-two-node-convergence`'s call
  (`bootPair('converge')`) and `control-write-while-alone-convergence`'s two calls
  (`bootPair('cadrepeer', 'ctrl-alone')`, `bootPair('devtoken', 'ctrl-alone')`)
  reproduce today's exact partyId strings (no behavioral change — party ids are
  timestamp-suffixed and only need to stay non-colliding within a run, but keep the
  prefix output identical anyway since it appears in debug logs).

Helpers to explicitly LEAVE LOCAL (legitimately scenario-specific — do not hoist):
`controlAddrs()`, `seedReceiverRecord()`, `bringUpHibernatingStrand()`,
`RESERVATION_WAIT`, `SIMPLE_SCHEMA` and any other schema constant, all of
`strand-formation-e2e`'s deliberately-invalid sApp config variants, and every
strand-scenario-family `nodeConfig`-shaped helper called out above.

## Imports the harness file will need to add

`test-network.ts` currently imports from `debug`, `@noble/curves/ed25519.js`,
`uint8arrays`, `@serfab/cadre-core`, and local harness modules. Adding the helpers
above requires new imports for: `webSockets` (`@libp2p/websockets`),
`circuitRelayTransport` (`@libp2p/circuit-relay-v2`), `generatePrivateKey` /
`getPublicKey` (`@optimystic/quereus-plugin-crypto`), `signSchema` and `SAppConfig` /
`CadreNodeConfig` types (`@serfab/cadre-core` — `signSchema` is new, the config types
may already be imported), `MemoryRawStorage` (`@optimystic/db-p2p`),
`generateKeyPair` (`@libp2p/crypto/keys`), `peerIdFromPrivateKey`
(`@libp2p/peer-id`), and the `PrivateKey` type (`@libp2p/interface`). All of these
packages are already dependencies of `@serfab/integration-tests` (see
`packages/integration-tests/package.json`) — no `package.json` change needed.

## Edge cases & interactions

- **`connectControlNodes` reconciliation must not change observed behavior in the
  2-node scenarios.** After swapping in the pair-scoped version, re-run
  `control-db-two-node-convergence.integration.ts` and
  `control-write-while-alone-convergence.integration.ts` — they are the landed
  network-backing regression anchors; both must still pass with identical timing
  characteristics (no new hangs, no timeout-window regressions).
- **3-node full mesh (push-wake scenario 4) is the reason the pair-scoped version
  exists** — confirm `push-wake-e2e.integration.ts`'s scenario 4 (`connectControlNodes(S,
  A)`, `connectControlNodes(Rx, A)`, `connectControlNodes(Rx, S)`) still passes after
  the hoist; this is the one call site where pair-scoping is load-bearing (three
  distinct pairwise connections must each be independently confirmed, not just "any
  connection exists").
- **`makeOwnOwner`'s widened return type.** Changing 3 call sites from `Promise<void>`
  to `Promise<string>` is source-compatible (unused return values are legal), but
  confirm `noUnusedLocals`/lint does not flag an unused `await makeOwnOwner(...)`
  expression-statement differently than before — it did not previously return a
  value, so nothing was ever destructured; this should be a no-op for lint.
- **`bootPair`'s default `partyIdPrefix`.** If a future call site passes no prefix, it
  gets `'ctrl'` (control-db-two-node-convergence's existing behavior) — make sure the
  default doesn't accidentally get applied to `control-write-while-alone-convergence`'s
  two call sites (both must keep passing `'ctrl-alone'` explicitly).
- **Import cycles / barrel re-export.** `harness/index.ts` re-exports `test-network.js`
  via `export *` already — no index.ts change needed unless a naming collision surfaces
  (e.g. another harness module already exports something named `wsTransports` or
  `randomPeerId`); check `port-allocator.ts`, `test-party.ts`, `test-cadre-host.ts`,
  `wait-utils.ts`, `types.ts` for name clashes before adding the new exports.
- **`createSignedSAppConfig` argument/behavior parity.** Confirm every hoisted call
  site still passes `(schema, version)` in that order and that none of the 5 source
  copies had a subtly different `latencyHint` or omitted field — they were verified
  byte-identical (mod key order) during planning, but diff each deleted block against
  the shared version while editing, not just at the end.
- **Scenario files that only use `wsTransports()`** (`convergence-stress.integration.ts`,
  `websocket-chat.integration.ts`) still need the harness import added even though they
  don't touch any other hoisted helper — don't skip them because the diff is small.

## Acceptance / TODO

- Add `wsTransports`, `createSignedSAppConfig`, `ControlNodeOpts`,
  `controlNodeConfig`, `makeOwnOwner`, `randomPeerId`, `connectControlNodes`,
  `bootPair` to `packages/integration-tests/src/harness/test-network.ts`.
- Update all 12 scenario files listed in `files:` above to import the applicable
  helpers from `../harness/index.js` and delete their local duplicate
  definitions (per the file-by-file breakdown above — not every helper applies
  to every file).
- Reconcile `connectControlNodes` on the pair-scoped implementation everywhere.
- Run `yarn workspace @serfab/integration-tests typecheck` and `yarn lint` —
  both clean.
- Run `yarn workspace @serfab/integration-tests test` (or at minimum the 12
  touched scenario files) — full pass, no behavioral change. Pay particular
  attention to `control-db-two-node-convergence.integration.ts` (the landed
  network-backing regression anchor — re-run it explicitly to confirm it still
  converges) and `push-wake-e2e.integration.ts` scenario 4 (the 3-node
  full-mesh case that depends on pair-scoped `connectControlNodes`).
- These are long-running real-libp2p integration tests; if the full suite risks
  exceeding the runner's 10-minute idle timeout, stream output (`yarn ... 2>&1 |
  tee`) and/or run the touched scenario files individually rather than the
  whole package at once.

## Verification (confirmed by prior session — all 12 scenario files + harness read in full)

Every helper described in "Design" above was checked against the live source and
matches exactly as specified (byte-identical `wsTransports`/`createSignedSAppConfig`
across the listed files, the `connectControlNodes` pair-scoped-vs-loose divergence,
the `bootPair` prefix difference, etc. — no surprises). What follows is the exact
edit list per file so the implementer can go straight to editing.

General pattern per file: delete the local helper(s), delete the now-orphaned
top-of-file imports those helpers alone needed (transport packages, key-gen
packages, `signSchema`, `CadreNodeConfig`/`SAppConfig`/`PrivateKey` types, etc. —
verify with a search for each symbol before deleting its import, since a few files
keep using an import directly even after the helper that used to need it is
hoisted), and extend the existing `'../harness/index.js'` import (or, for the two
files below still importing from `'../harness/wait-utils.js'`, switch that import
to `'../harness/index.js'`) with the newly-needed harness names. Replace
`nodeConfig(...)` call sites with `controlNodeConfig(...)` where applicable — field
names are unchanged.

- **push-wake-e2e.integration.ts** — delete local `wsTransports` (~L118-121),
  `createSignedSAppConfig` (~L131-141), `NodeOpts`+`nodeConfig` (~L143-168),
  `makeOwnOwner` (~L175-190), `connectControlNodes` (~L228-256). KEEP local:
  `controlAddrs`, `seedReceiverRecord`, `bringUpHibernatingStrand`,
  `RESERVATION_WAIT`, `SIMPLE_SCHEMA`. Drop now-unused imports `webSockets`,
  `circuitRelayTransport` (L96-97), `MemoryRawStorage` (L102),
  `generatePrivateKey`/`getPublicKey` (L103), `signSchema` (from the `@serfab/cadre-core`
  import block L104-112 — keep `CadreNode`, `SeedBootstrapService`,
  `collectStrandAddrs`, `ed25519KeyPairFromLibp2p`, `signPeerRecord`,
  `ed25519PublicKeyB64FromPeerId`, all still used by the kept-local helpers), and
  `CadreNodeConfig`/`SAppConfig` from the type import (L113 — keep `WakeAck`,
  `PeerAddressRecord`). Keep `generateKeyPair`, `peerIdFromPrivateKey`, `PrivateKey`
  (still used directly). Extend the L114 harness import with `createSignedSAppConfig`,
  `controlNodeConfig`, `makeOwnOwner`, `connectControlNodes` (no need to import
  `wsTransports` here — nothing in this file calls it directly once `nodeConfig` is
  gone). Note: this file does NOT use `bootPair`/`randomPeerId`.

- **control-db-two-node-convergence.integration.ts** — delete local `wsTransports`
  (~L57-59), `NodeOpts`+`nodeConfig` (~L61-84), `makeOwnOwner` (~L87-98),
  `connectControlNodes` (~L101-124), `randomPeerId` (~L126-129), `bootPair`
  (~L132-156). No helpers stay local in this file. Drop imports `webSockets`,
  `circuitRelayTransport`, `generateKeyPair`, `peerIdFromPrivateKey` (L44-47),
  `PrivateKey` type (L48), `ed25519KeyPairFromLibp2p` + `CadreNodeConfig` type
  (L50-51 — keep `CadreNode`), `MemoryRawStorage` (L49). The old `waitUntil` import
  (L52) becomes unused too (it was only called from the now-hoisted
  `connectControlNodes`) — drop it. Final harness import:
  `waitForCadrePeerConverged, controlNodeConfig, makeOwnOwner, connectControlNodes,
  randomPeerId, bootPair`. Call sites unchanged (`bootPair('converge')`,
  `connectControlNodes(B, A)`, etc.) — verify with a search before deleting
  `waitUntil`/`CadreNode` imports in case something was missed.

- **control-write-while-alone-convergence.integration.ts** — same shape as the
  two-node-convergence file: delete local `wsTransports` (~L42-44),
  `NodeOpts`+`nodeConfig` (~L46-69), `makeOwnOwner` (~L72-78), `connectControlNodes`
  (~L81-103), `randomPeerId` (~L105-108), `bootPair` (~L111-132, prefix
  `'ctrl-alone'`). UNLIKE the two-node file, `waitUntil` IS still used directly
  (second test, `resolveDeviceToken` polling ~L192-202) — keep that import. Drop
  the same transport/keygen/type imports as above. **Call-site change required**:
  the hoisted `bootPair(tag, partyIdPrefix = 'ctrl')` defaults to `'ctrl'`, not
  `'ctrl-alone'` — update both call sites to `bootPair('cadrepeer', 'ctrl-alone')`
  and `bootPair('devtoken', 'ctrl-alone')` (today they call `bootPair('cadrepeer')`
  / `bootPair('devtoken')` because the prefix was hardcoded locally) to keep the
  exact same partyId strings.

- **control-cohort-auto-convergence.integration.ts** — delete local `wsTransports`
  (~L46-48), `NodeOpts`+`nodeConfig` (~L50-76, keep the `reconcileMs` field — the
  hoisted `ControlNodeOpts`/`controlNodeConfig` already support it), `makeOwnOwner`
  (~L79-89), `randomPeerId` (~L91-94). This file has NEITHER `connectControlNodes`
  NOR `bootPair` locally — don't import those. `ed25519KeyPairFromLibp2p` IS still
  used directly in this file (L137, deriving `aOwnerKey` for `pinnedKeyTrustPolicy`)
  — unlike the other 3 control files, KEEP that import. Also keep
  `pinnedKeyTrustPolicy` and `generateKeyPair` (key generation stays local here).
  Drop `webSockets`/`circuitRelayTransport`, `peerIdFromPrivateKey` (only used
  inside the now-hoisted `randomPeerId`), `PrivateKey` type, `CadreNodeConfig` type,
  `MemoryRawStorage`. Extend harness import with `controlNodeConfig`, `makeOwnOwner`,
  `randomPeerId` (keep existing `waitUntil`, `waitForCadrePeerConverged`).

- **strand-formation-e2e.integration.ts** — delete local `wsTransports` (~L66-68),
  `createSignedSAppConfig` (~L78-89). KEEP local `createUnsignedSAppConfig`,
  `createTamperedSAppConfig`, `createWrongKeySAppConfig`, `createTestNodeConfig` —
  none of these are touched, but `createTestNodeConfig` calls `wsTransports()`
  internally (~L136), so `wsTransports` MUST still be imported (from harness) even
  though nothing else in this file calls it. Drop `webSockets`/`circuitRelayTransport`
  imports (L14-15). Keep `generatePrivateKey`/`getPublicKey` (used by the 3 kept
  invalid-config variants) and `signSchema` (used by `createTamperedSAppConfig`/
  `createWrongKeySAppConfig`). Extend the existing harness import (currently
  `TestCadreNetwork, signMessageEd25519, waitUntil` from `'../harness/index.js'`)
  with `wsTransports, createSignedSAppConfig`.

- **rbac-signed-write.integration.ts** — delete local `wsTransports` (~L34-36),
  `createSignedSAppConfig` (~L67-78). KEEP local `createTestNodeConfig` (also calls
  `wsTransports()` internally, ~L58 — same reasoning as above, still need the
  import). Drop `webSockets`/`circuitRelayTransport` (L23-24). Drop `signSchema`
  from the `@serfab/cadre-core` import (L26) — no longer used anywhere in this file
  once `createSignedSAppConfig` is gone (keep `CadreNode`, `StrandProvisioner`
  type). Keep `generatePrivateKey`, `getPublicKey`, `digest`, `sign` (L28 — all
  still used by `createMember`/`signItem`/`signDelete`). Extend the harness import
  (currently just `waitUntil`, L29) with `wsTransports, createSignedSAppConfig`.

- **multi-party-workflows.integration.ts** — delete local `wsTransports`
  (~L106-108), `createSignedSAppConfig` (~L59-69). KEEP local `createNodeConfig`
  (the strand-family shape — do NOT touch it; it calls `wsTransports()` internally
  at ~L120, so the import is still needed). Drop `webSockets`/`circuitRelayTransport`
  (L17-18). Drop `signSchema` from the `@serfab/cadre-core` import (L20-29 block —
  no other use in file; keep `CadreNode` and the re-exported types). CORRECTED (see
  resume-note): `getPublicKey` (L30) is used ONLY by the now-deleted
  `createSignedSAppConfig` — drop it. `generatePrivateKey` is NOT solely used there —
  it is also called standalone at ~L235 (`const aPrivateKey = generatePrivateKey(...)`
  for Party A's strand member key) — KEEP `generatePrivateKey` in the L30 import.
  **This file currently imports
  `waitUntil` from `'../harness/wait-utils.js'` directly (L31), not from the
  barrel** — change that import to `'../harness/index.js'` and add `wsTransports,
  createSignedSAppConfig` to it (the barrel re-exports `wait-utils.js` too, so
  `waitUntil` keeps working unchanged).

- **strand-membership-closed-strand-e2e.integration.ts** — delete local
  `wsTransports` (~L94-96), `createSignedSAppConfig` (~L127-138). KEEP local
  `createTestNodeConfig`, `freshKeyPair`, and everything else — `createTestNodeConfig`
  calls `wsTransports()` internally (~L118), so keep that import. Drop
  `webSockets`/`circuitRelayTransport` (L66-67). Drop `signSchema` from the big
  `@serfab/cadre-core` import (L69-85) — no other use in file. Keep
  `generatePrivateKey`/`getPublicKey` (used by `freshKeyPair`) and `digest`/`sign`
  (used by `signItem`) from L88. Extend the harness import (currently `waitUntil`
  from `'../harness/index.js'`, L89) with `wsTransports, createSignedSAppConfig`.

- **convergence-stress.integration.ts** — delete local `wsTransports` (~L58-60)
  only (this file builds its `CHAT_SAPP_CONFIG` as an inline const object, not via
  a `createSignedSAppConfig` function — leave that as-is, out of scope). Drop
  `webSockets`/`circuitRelayTransport` (L19-20). **Currently imports from
  `'../harness/wait-utils.js'`** (`waitUntil, sleep`, L25) — change to
  `'../harness/index.js'` and add `wsTransports`.

- **websocket-chat.integration.ts** — delete local `wsTransports` (~L54-56) only.
  Drop `webSockets`/`circuitRelayTransport` (L16-17). **Currently imports from
  `'../harness/wait-utils.js'`** (`waitUntil`, L22) — change to
  `'../harness/index.js'` and add `wsTransports`.

After editing, `yarn workspace @serfab/integration-tests typecheck` will catch any
import left dangling (unused-import lint) or any accidentally-still-needed import
that got dropped — treat its output as the authoritative check rather than
re-deriving every import list by hand a second time.
