description: Each machine now saves, per workspace, the ring library's routing table with every peer's signed address, and loads it again after a restart. The "two relay-only machines restart" test passes using only that saved table, with Sereus's own address book left in memory, which is what allows the address book to be removed next.
prereq:
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-network-state.ts, packages/cadre-core/src/strand-network-state-file.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/package.json, packages/cadre-core/test/strand-network-state.spec.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/README.md, packages/cadre-host/src/orchestrator/node-identity.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/node-local-slots.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/node-local-slots.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/strand-restart-party.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, packages/integration-tests/src/scenarios/strand-relay-only-restart-reconverges.integration.ts, docs/architecture.md, docs/strands.md, docs/testing.md, .release-notes.pending.md
----
# Strand network state persisted

Implement commit `ticket(implement): strand-network-state-persisted`; review fixes are in the commit carrying this ticket.

## What is true now

- Every strand node is built with Optimystic db-p2p's `persistence` option. db-p2p saves the node's network state (its FRET routing table, each entry carrying the peer's signed address record, plus the network-size high-water mark and which peers it saw serving the strand) and re-imports it when the node is next built.
- Sereus owns only the storage: `StrandNetworkStateStore` (`MemoryStrandNetworkStateStore` default, `PersistentStrandNetworkStateStore` over a `DurableSlot`, `FileStrandNetworkStateStore` behind `@serfab/cadre-core/strand-network-state-file`), injected as `CadreNodeConfig.strandNetworkState.store`. One record per party, keyed by strand id. cadre-cli and the three reference apps inject a durable one.
- `unpublishStrand`, `forgetJoinedStrand` and self-revocation forget a strand's state. A save that arrives from the strand node after the forget is dropped (`forgetGeneration`), until a new runtime is built for the strand.
- Every `@optimystic/*` range is `^1.8.1`.

## The gate for `remove-strand-peer-book`

The gotchoices/sereus#18 restart scenario (`strand-relay-only-restart-reconverges`) converged with the strand peer book at its in-memory default in all three arms, in the implementer's runs: the default arm 4 of 4 (strand nodes reconnected at 0.87–0.96 s), the two-process arm 4 of 4, and the negative control (network state in memory too) did not converge in 180 s, as intended. The review read those logs (`tickets/.logs/strand-network-state-persisted.all-arms.log`) and could not re-run the arms (see "Not run in review"). `remove-strand-peer-book` re-runs the default arm as its first step.

## Behaviour change: restarting alone

A node that restarts while every other member of a strand is offline now remembers them as serving the strand, so its first writes fail with `Failed to get super-majority` until FRET marks them unreachable: 4–6 s through a loopback relay (implementer's measurement). Documented in `docs/architecture.md` ("Restarting alone") and the release note.

## Review findings

**Checked, by reading the implement diff before the handoff, and the upstream code it depends on** (`../optimystic/packages/db-p2p/src/libp2p-key-network.ts`, `../Fret/packages/fret/src/service/fret-service.ts`, read only):

- *The store and adapter.* `load` returns the stored object and db-p2p does not mutate it (`importTable` maps into new arrays). A failed slot write rejects the save, which db-p2p logs and the snapshot's write chain survives. The forget guard covers all three forget sites, because each forgets before the strand stops; a relaunch builds a new adapter and saves again. No defect found.
- *"A save during import"* (listed as a known gap). Not a real window with these stores. FRET's `importTable` writes every entry into its table synchronously before its first `await`, and the only `await` before that is the adapter's `load`, which resolves from memory. A save triggered during the rest of the import already exports the imported entries.
- *"Restarting alone".* Weighed for a ticket; left as the tripwire the implementer parked (`NOTE:` at the `persistence` option in `buildStrandRuntime`). db-p2p carries its own accepted-tradeoff `NOTE:` for this behaviour (`membershipOf`), and the 4–6 s was measured through a loopback relay. FRET keeps an unreachable peer in the table marked `dead` rather than removing it, and exports that state, so a peer that was offline for a whole session is still saved and still re-probed.
- *Resource cleanup.* Found one gap, below.
- *Wiring parity.* Every place that injects the peer book also injects the network state (cadre-cli, RN, NS, web, the integration harness). Lint, typecheck, `knip` and `check:dep-ranges` pass.
- *Tests.* Both new tests kept. The round-trip test pins the load policy for this record; the guard test pins a real branch (a late save must not restore a forgotten strand). No test added: nothing found needed one.
- *Docs.* Read `docs/architecture.md`, `docs/strands.md`, `docs/testing.md` and the release note against the code. Statements about when db-p2p saves match `libp2p-key-network.ts`.

**Found and fixed in this pass (comments and docs only; no executable code changed):**

- `forgetJoinedStrand` and `forgetRevokedJoin` doc comments named only the peer book as forgotten; they now name the saved network state too. The `strandNetworkStateStore` field comment now says which detach keeps the state.
- `reference-app-web/src/lib/node-local-slots.ts` header said "all three records"; it now lists the records the file holds.
- `docs/architecture.md` Lifecycle paragraph now says a machine that detaches a strand because another machine of its party removed it keeps the state.
- `packages/cadre-cli/README.md` "Node State" now names `strand-network.<partyId>.json`.

**Tripwires recorded (not tickets):**

- *A strand's saved state is never aged out.* When another machine of the party unpublishes or leaves a strand, this machine's watcher detaches it (`handleStrandRemoved`) without forgetting its state, and a strand stopped and never relaunched keeps its entry too. Forgetting on the watcher path was considered and rejected as an inline fix: the watcher's query returns an empty list while the control database is absent, so its "removed" is not proof the strand is gone, and acting on it could erase every strand's saved table. Parked as a `NOTE:` on `PersistentStrandNetworkStateStore` with the revisit conditions.
- Already parked by the implementer and confirmed in place: saved record lagging the live one and self-revocation stopping saves (`NOTE:`s at `strandNetworkStatePersistence`), write amplification (`NOTE:` at `PersistentStrandNetworkStateStore.save`).

**Handed to `remove-strand-peer-book`** (appended to that ticket's "Edge cases", since it owns the same code): after a graceful stop, FRET's leave notice makes the side that stayed remove the leaver from its table, so its later saves omit the leaver and only the leaver remembers the pair. Harmless while the book exists, because the book keeps both sides. Read from FRET's source, not observed; that ticket is asked to confirm it and either extend the scenario or state it in the docs.

**Major findings:** none. Nothing in the diff is wrong in a way that needs its own ticket.

## Not run in review

- **Every test suite.** The stale-build guard refused `yarn workspace @serfab/cadre-core test` twice during the review: `../optimystic`'s `db-p2p` `dist` is older than its source, and that repository had 16 uncommitted files, so it is being edited. Per `tickets/rules/sibling-repos.md` nothing was built there. The review changed only comments and docs, so the executable code is what the implementer tested: cadre-core 2381 passed and 1 skipped, cadre-cli 254, reference-app-rn 302, reference-app-web 67, reference-app-ns 131, and the integration files listed in the implement handoff (logs under `tickets/.logs/strand-network-state-persisted.*`). `@serfab/cadre-core` was rebuilt after the comment edits so its own `dist` is fresh.
- **The 13 `control-*` integration files**, not run by the implementer either, for the same reason. Control nodes take no `persistence`, so this change does not reach them, by inspection.
- Device and browser end-to-end flows for the reference apps.

## Pre-existing failures

The two control-cohort harness failures the implementer reported were handled by the runner's triage (`tess: triage pre-existing test failure`), which removed `tickets/.pre-existing-error.md`. Nothing new to report.
