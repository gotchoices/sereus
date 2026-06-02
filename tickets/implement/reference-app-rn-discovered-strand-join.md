----
description: Make RN discovered-strand auto-join functional — publish created strands to the control DB and wire joinChatStrand to a discovery event
prereq: reference-app-rn-message-pk-collision-free, bootstrap-dht-discovery-and-strand-cohort-wiring
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/README.md
----

## Problem

The RN README claims Phone B "sees the strand via control network sync and
auto-joins" (`README.md:136`). It does not. There are **two** stacked gaps, and
the original ticket only named the second:

### Gap 1 — created strands are never published to the control DB

`createChatStrand` (`chat-strand.ts:52-66`) calls only `cadreNode.addStrand(...)`.
`CadreNode.addStrand` (`cadre-node.ts:504-531`) **only** starts a local strand
instance and stores the `sAppConfig` in an in-memory map — it never writes the
`Strand` row to the shared control database. The control-DB insert is a separate
authority-signed operation, `ControlDatabase.insertStrand(strandId, type,
authorityKey, signStampId, memberPrivateKey?)` (`control-database.ts:376-401`),
which nobody in the RN app calls. `cadre-phone.ts:156-158` already documents the
gap: *"The strand must already exist in the control database (inserted via seed
or direct write)."*

Net effect: Phone A's strand never lands in the shared `Strand` table, so Phone
B's `StrandWatcher` poll (`strand-watcher.ts:104-139`) never observes it and
`handleStrandAdded` never fires. (The `websocket-chat` integration test sidesteps
this by calling `addStrand` independently on both parties with a hardcoded
`strandRow` and manually dialing strand-level libp2p — see
`websocket-chat.integration.ts:123-146` and its comment "strand peer discovery
via control network is not yet wired up.")

### Gap 2 — discovery handler skips silently with no app hook

Even once a strand row is published, `handleStrandAdded` (`cadre-node.ts:370-380`)
skips any strand with no registered `sAppConfig` and **emits no event**:

```ts
const sAppConfig = this.sAppConfigs.get(strand.Id);
if (!sAppConfig) {
  log('No sAppConfig registered for strand %s - skipping auto-start', strand.Id);
  return;
}
```

The RN app subscribes only to `strand:started` / `strand:stopped` /
`strand:error` (`use-cadre.ts:76-95`) and has no signal for a *discovered*
strand. The helper for this case, `joinChatStrand` (`chat-strand.ts:75-83`),
exists but is never called.

## Design

### cadre-core: emit a discovery event instead of skipping silently

Add a new event to `CadreNodeEvents` (`types.ts:400-414`):

```ts
'strand:discovered': { strandId: string; strand: StrandRow };
```

In `handleStrandAdded`, when no `sAppConfig` is registered, emit
`strand:discovered` (carrying the full `StrandRow`) before returning, instead of
just logging and dropping it. Existing self-configured strands (config already
present) keep auto-starting unchanged. This is the minimal, app-agnostic seam:
the hosting app decides whether/how to join a discovered strand by registering a
config and calling `addStrand`.

Note: `bootstrap-dht-discovery-and-strand-cohort-wiring` (prereq) threads `mode`
selection and cohort `CadrePeer` bootstrap into the discovery path so that, once
joined, the strand-level libp2p node actually finds the cohort. Design this
ticket assuming that lands — i.e. a `joinChatStrand`-driven `addStrand` on the
discovery path will boot a strand node seeded from the cohort. Do **not**
re-implement cohort bootstrap here.

### RN: publish on create

`createChatStrand` must, in addition to `addStrand`, publish the strand to the
control DB so peers can discover it. Use
`cadreNode.getControlDatabase()?.insertStrand(strandId, 'o', authorityKey,
signStampId)`. The phone holds the signing keys (`cadre-phone.ts` header:
"Authority role: the phone holds the signing keys"), so it can author the
authority-signed insert.

**Open implementation question for the implementer to resolve:** determine how
the phone obtains the authority public key + `signStampId` signer. Options to
investigate, in order of preference:
- An existing authority-key accessor on `CadreNode` / `ControlDatabase` (grep
  for `ensureAuthorityKey`, `insertAuthorityKey`, `initializeSeedBootstrap`,
  and how `cadre-cli` / `test-network.ts:105` obtains the authority signer for
  its `insertStrand` call — mirror that path).
- If the phone is not the party authority (e.g. the drone is), then publishing
  must go through the authority; in that case document the constraint and have
  `createChatStrand` insert via whatever authority handle the node exposes,
  failing loudly (not silently) if none is available.

Whatever the resolution, `createChatStrand` must surface a clear error if the
strand cannot be published, rather than silently starting a local-only strand
(the current masked-failure mode).

### RN: subscribe to discovery and join

In `useCadreInternal` (`use-cadre.ts:76-95`), subscribe to `strand:discovered`.
On fire, call `joinChatStrand(node, strand)` (which registers the chat
`sAppConfig` and calls `addStrand`), then `refreshStrands()`. Guard against
double-join (ignore if the strand is already in `node.getStrands()`), and
`console.warn` + surface errors on failure rather than eating them. Remember to
add/remove the handler in the effect's subscribe/cleanup alongside the existing
three.

`joinChatStrand` already exists and is correct (`chat-strand.ts:75-83`); this
ticket is its first real caller.

### README

Update `README.md` so the "Connecting Multiple Users" section (lines 129-137)
and the Key Concepts "Control network" description accurately describe the
now-working flow: Phone A creates and **publishes** a strand to the control DB;
Phone B's node emits `strand:discovered`; the app auto-joins via
`joinChatStrand`. Keep the description honest about the cohort-bootstrap
dependency for strand-level convergence.

## Scope boundary

- Open (`Type:'o'`) strands only. The closed-strand consent/RBAC demonstration
  is a separate ticket (`reference-app-rn-closed-strand-consent-demo`).
- Strand-level peer discovery / cohort bootstrap is owned by
  `bootstrap-dht-discovery-and-strand-cohort-wiring`; do not duplicate it.

## References

- `packages/cadre-core/src/cadre-node.ts:370-404` — `handleStrandAdded`.
- `packages/cadre-core/src/cadre-node.ts:504-531` — `addStrand` (no control-DB write).
- `packages/cadre-core/src/control-database.ts:376-401` — `insertStrand` signature.
- `packages/cadre-core/src/types.ts:400-414` — `CadreNodeEvents`.
- `packages/cadre-core/src/strand-watcher.ts:104-139` — poll → `onStrandAdded`.
- `packages/reference-app-rn/src/use-cadre.ts:76-145` — event subscriptions, `createStrand`.
- `packages/reference-app-rn/src/chat-strand.ts:52-83` — `createChatStrand`, `joinChatStrand`.
- `packages/reference-app-rn/src/cadre-phone.ts:154-162` — `addStrand` helper + control-DB note.
- `packages/integration-tests/src/harness/test-network.ts:105` — example `insertStrand` call.
- Docs: `docs/architecture.md` (control network, strand discovery), `docs/strands.md`.

## TODO

### Phase 1 — cadre-core discovery event
- Add `'strand:discovered': { strandId: string; strand: StrandRow }` to
  `CadreNodeEvents`.
- Emit it from `handleStrandAdded` in the no-`sAppConfig` branch (replacing the
  silent skip), keeping the auto-start path for configured strands unchanged.
- Add/adjust a `cadre-node` unit test asserting `strand:discovered` fires when a
  watched strand has no registered config.

### Phase 2 — RN publish-on-create
- Resolve how the phone authors the authority-signed `insertStrand` (see "Open
  implementation question"); mirror the existing authority-signer path.
- Update `createChatStrand` to publish the strand row to the control DB after/with
  `addStrand`; surface a clear error if publishing is unavailable.

### Phase 3 — RN discovery-join wiring
- Subscribe to `strand:discovered` in `useCadreInternal`; on fire, `joinChatStrand`
  then `refreshStrands`, with double-join guard and error surfacing.
- Wire handler add/remove into the existing strand-event effect.

### Phase 4 — docs + validation
- Update `reference-app-rn/README.md` (Connecting Multiple Users, Key Concepts).
- Build + typecheck cadre-core and reference-app-rn; run the cadre-node unit
  test and any affected integration test, streaming output with `tee`. Be honest
  in the handoff about what could not be exercised in-agent (real two-phone
  convergence needs the cohort-bootstrap prereq + devices).
