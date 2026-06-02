description: Make strand hibernation actually release libp2p/db resources and rehydrate on wake
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, docs/architecture.md, docs/STATUS.md
----

Today `CadreNode.handleStrandHibernate` only flips `instance.status = 'hibernating'` and the strand keeps its full libp2p node + `StrandDatabase` open (`packages/cadre-core/src/cadre-node.ts:487-497` — note the "we keep it connected but could stop it here" comment). The active↔hibernating distinction is therefore cosmetic. This ticket makes hibernation **release** the strand's resources and **rehydrate** them on wake, so a hibernating strand holds no open strand-network connections, transports, or DB handles.

### Design

Introduce a quiesce/resume pair on `StrandInstanceManager` that mirrors `startStrand`/`stopStrand` but **retains the instance record** (so it can be brought back) instead of deleting it:

- `quiesceStrand(strandId)`: closes `instance.database`, stops `instance.libp2pNode`, clears both fields, sets `connectedPeers = 0`, leaves `status` for the caller to set (`hibernating`). The instance stays in the `instances` map with its identity/metadata (`strandId`, `sAppInfo`, `memberPrivateKey`, `latencyHint`, `lastActivity`, `nextCheckIn`). Mechanically this is `stopStrand` minus the `instances.delete` and minus `stopping`-guard semantics.
- `resumeStrand(strandId, overrides?)`: rebuilds the libp2p node + `StrandDatabase` for an already-tracked, quiesced instance and re-attaches them, setting `status = 'active'`. Must re-resolve volatile inputs that may have changed since launch — `bootstrapNodes` (cohort seed) and `mode` (cohort membership may have grown `bootstrap → networked`) — via `overrides`.

To support `resumeStrand`, the node+DB construction currently inline in `startStrand` (`strand-instance-manager.ts:181-246`) must be extracted into a private `buildStrandRuntime(instance, config)` that both `startStrand` and `resumeStrand` call. Retain the launch `StartStrandConfig` per strand (e.g. a private `launchConfigs: Map<string, StartStrandConfig>`, populated in `startStrand`, cleared in `stopStrand`) so `resumeStrand` has the storage/network/profile/privateKey/sAppConfig it needs without the caller threading them again. `overrides` supplies the freshly-resolved `bootstrapNodes` and `mode`.

`CadreNode` wires the orchestration:

- `handleStrandHibernate(strandId)` → `await strandManager.quiesceStrand(strandId)`, set `status = 'hibernating'`, emit `strand:hibernating`. Guard against a strand that is missing or already quiesced.
- `handleStrandWake(strandId)` → if the instance is quiesced (no `libp2pNode`), re-resolve the cohort seed (`resolveCohortSeed()`) and mode (`selectStrandMode`) exactly as `launchStrand` does, then `await strandManager.resumeStrand(strandId, { bootstrapNodes, mode })`; set `lastActivity = new Date()`, emit `strand:waking`. If the instance is already live (defensive), just flip status.

`StrandRow` reconstruction for resume: `strandId` is the row `Id`; `MemberPrivateKey` is preserved on `instance.memberPrivateKey`; `Type` is unused by the start path, so a minimal row suffices. (Confirm `startStrand` never reads `strandRow.Type` — it does not today.)

Wake is already triggered from three call sites that all funnel through `callbacks.onWake` → `handleStrandWake`: `HibernationManager.recordActivity` (activity while hibernating), `HibernationManager.wakeStrand` (force wake), and `CadreNode.wakeStrand`. Because resume is now async and does real I/O (node creation can take seconds — see the timing logs), `onWake` must be properly awaited along these paths. Audit the `void this.callbacks.onWake(...)` fire-and-forget in `recordActivity` (`hibernation-manager.ts:129`): hibernating-wake must not race a concurrent check-in/second activity. Add a simple per-strand "resuming" guard (in `CadreNode` or the manager) so overlapping wake requests coalesce rather than building two libp2p nodes.

`idle` state is intentionally left as a lightweight status flag for now (still fully running). Trimming connections on `idle` ("minimal connections" in the state table) is a separate refinement parked to backlog (overlaps `tickets/backlog/later/3-mobile-resource-awareness.md`); document `idle` accurately rather than overstating it.

#### State after this ticket

```
active --quiesce(stop node+db)--> hibernating   (no strand-network resources held)
hibernating --resume(rebuild node+db)--> active (cohort seed + mode re-resolved)
```

### Docs

- `docs/architecture.md:476-500`: the state table's "Connections" column and "Idle Strand Behavior" must match reality — hibernating = node stopped, DB closed, zero strand-network connections; wake = full rebuild. Keep the `realtime` never-hibernate row. Do **not** yet claim cohort-querying check-in or push-wake (those land in the dependent tickets); leave/trim those lines so the doc never describes unimplemented behavior.
- `docs/STATUS.md`: grep for any existing hibernation/cadre-core line; add or correct a checklist entry reflecting "hibernation releases strand resources and rehydrates on wake `[x]`; cohort check-in / push-wake `[ ]`."

### Key tests

- `strand-instance-manager.spec.ts`: after `startStrand` then `quiesceStrand`, the instance remains tracked but `libp2pNode`/`database` are `undefined` and the underlying `stop()`/`close()` were called once; `resumeStrand` rebuilds them (mock `createLibp2pNode`/`StrandDatabase`) and sets `status = 'active'`; `stopStrand` after quiesce still removes the instance and clears the retained launch config.
- `hibernation-manager.spec.ts` (extend): a tracked `interactive` strand driven past idle+hibernate timeouts fires `onHibernate`; a subsequent `recordActivity` fires `onWake` exactly once even under two near-simultaneous activity calls (resume coalescing).
- `cadre-node.spec.ts`: drive a strand through hibernate→wake with a fake/mocked strand manager and assert `quiesceStrand` then `resumeStrand(strandId, { bootstrapNodes, mode })` are called with a freshly re-resolved seed; `strand:hibernating` and `strand:waking` events emit.

## TODO

- [ ] Extract `buildStrandRuntime(instance, config)` from `StrandInstanceManager.startStrand`; have `startStrand` use it and cache the `StartStrandConfig` in a per-strand `launchConfigs` map.
- [ ] Add `quiesceStrand(strandId)` (stop node + close db, retain instance) and `resumeStrand(strandId, overrides?)` (rebuild via `buildStrandRuntime`, re-applying `bootstrapNodes`/`mode` overrides) to `StrandInstanceManager`; clear `launchConfigs` on `stopStrand`.
- [ ] Rewrite `CadreNode.handleStrandHibernate` to quiesce + set status + emit; rewrite `handleStrandWake` to re-resolve cohort seed/mode and resume.
- [ ] Add a per-strand resume/wake coalescing guard so overlapping wake triggers build only one runtime; make the `recordActivity` wake path await/serialize correctly.
- [ ] Confirm `stopStrand`, `untrackStrand`, `removeStrand`, `handleStrandRemoved` all behave when the instance is quiesced (no node/db) — they should no-op the missing handles cleanly.
- [ ] Update `docs/architecture.md` hibernation section (state table + idle behavior) and `docs/STATUS.md` to reflect only what this ticket lands.
- [ ] Add/extend the tests above; run `yarn workspace @serfab/cadre-core test` and the package typecheck/build, streaming output with `tee`.
