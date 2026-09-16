description: Each party now gets its own local database of party-wide records, so a node started for one party can no longer read or write another party's data on the same device or browser. Review the change.
files:
  - packages/cadre-core/src/storage-scope.ts (new — `controlStorageScope`, `isControlStorageScope`)
  - packages/cadre-core/src/cadre-node.ts (`resolveControlStorage` ~1495; `controlStorage` field doc ~328)
  - packages/cadre-core/src/types.ts (`RawStorageProvider` ~118, `StorageConfig.provider` ~161)
  - packages/cadre-core/src/index.ts (exports both helpers)
  - packages/cadre-core/test/control-storage-scope.spec.ts (new — the regression guard)
  - packages/cadre-core/test/cadre-node-control-node-options.spec.ts
  - packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts (comments + param renames)
  - packages/integration-tests/src/harness/block-store-probe.ts (`control()` accessor replaces the `CONTROL_SCOPE` literal)
  - packages/integration-tests/test/block-store-probe.spec.ts
  - packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts, strand-membership-closed-strand-e2e.integration.ts, strand-late-cadre-join.integration.ts
  - packages/reference-app-web/src/lib/strand-storage.ts, cadre-web.ts, node-local-slots.ts, diagnostics.svelte.ts
  - packages/reference-app-rn/src/cadre-phone.ts, phone-node-config.ts
  - packages/reference-app-ns/src/ns-storage.ts, cadre-phone.ts
  - packages/cadre-cli/src/commands/node-session.ts (doc + param rename only)
  - docs/architecture.md, docs/reference-app-ns.md, packages/cadre-core/README.md, packages/reference-app-web/README.md, packages/reference-app-ns/README.md
difficulty: medium
----

# Review: per-party storage scope for the control database

## What changed

`CadreNodeConfig.storage.provider` is a factory cadre-core calls once per **scope**. Strand scopes are strand ids (uuids, globally unique). The control scope used to be the literal string `'control'`, with no party id in it, so every party on one device shared one control database — its strands, owner keys, peers, invitations and revocations all in one place, read by whichever party's node started.

The control scope key is now `controlStorageScope(partyId)`: the literal `control-` followed by the base64url encoding of the party id's UTF-8 bytes. New module `packages/cadre-core/src/storage-scope.ts` holds it and `isControlStorageScope`, both exported from `index.ts`. `resolveControlStorage()` passes that key to the provider and uses the same string as the cache label.

The encoding is not cosmetic. A party id is arbitrary text (nothing in cadre-core validates it; the React Native app lets a user type one into Settings), and scope keys reach real namespaces unescaped — cadre-cli builds `${config.path}/${scope}`, React Native a LevelDB filename, the browser an IndexedDB database name. Encoding keeps every key inside `[A-Za-z0-9._-]`, which is the invariant embedders already relied on when strand ids happened to be uuids. The decode one-liner is in the `controlStorageScope` doc comment and in `docs/architecture.md`.

## How to exercise it

**The regression guard** — `packages/cadre-core/test/control-storage-scope.spec.ts`. Pure unit, milliseconds: `buildControlNodeOptions` is pure on a bare `new CadreNode`, so no libp2p node starts and no database opens.

- two party ids over one memoizing provider → two different scope keys and two different stores;
- the same party id twice → the same store (the provider contract's "call it again after a stop and reach the same durable backend" still holds);
- six hostile/awkward party ids (`../../etc/passwd`, an embedded `/`, a Windows drive path, non-ASCII, the empty string, a plain uuid) → the key matches `/^[A-Za-z0-9._-]+$/` and decodes back to the original;
- `isControlStorageScope` accepts its own keys, rejects a uuid, and rejects the pre-fix literal `'control'`.

**Commands run, all green:**

```
yarn lint
yarn typecheck                                        # every workspace
yarn build
yarn workspace @serfab/cadre-core test                # 129 files, 2125 passed / 1 skipped
yarn workspace @serfab/cadre-cli test                 # 232 passed
yarn workspace @serfab/quereus-plugin-sereus test     # 112 passed / 1 todo
yarn workspace @serfab/reference-app-web test         # 66 passed
yarn workspace @serfab/reference-app-web check:svelte # 0 errors
yarn workspace @serfab/reference-app-rn test          # 209 passed
yarn workspace @serfab/reference-app-ns test          # 103 passed
yarn workspace @serfab/integration-tests exec vitest run test/block-store-probe.spec.ts src/scenarios/control-offline-read-after-restart.integration.ts   # 25 passed
yarn workspace @serfab/integration-tests exec vitest run src/scenarios/strand-late-cadre-join.integration.ts                                             # 3 passed
```

`strand-late-cadre-join` also prints the new key shape in its diagnostic output, which is a cheap manual confirmation: `newcomer storage scopes after the quiet window: [control-bGF0ZS1qb2luLWRlY2xpbmUtMTc4OTUxOTIzMTY2OQ]`.

**One pre-existing failure, already tracked — not re-reported.** `yarn workspace @serfab/integration-tests exec vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts` gave 8 passed / 1 failed. The failure is `"a joining node runs the join against its OWN database and both nodes converge"` at line 919 (`select Key from Strand.Member` returns `undefined`). `tickets/.pre-existing-known.md` line 640 lists that exact test under `strand-unique-index-sync-stale-revision`, which sits in `tickets/blocked/`; the file is recorded there as intermittent across many runs. The test this ticket actually edited in that file — `"replicates the founder's blocks PHYSICALLY into the joiner's own block store"` — passed. No `.pre-existing-error.md` was written, per the "already listed with a blocked slug, do not re-triage" rule.

## Things a reviewer should look at hardest

**The web app is the one embedder with real logic changes, and it takes a one-time data reset.** The browser keeps its `kv` records — the tab's Ed25519 identity, its persisted party id, the trusted-owner anchor, the bootstrap peers, the enrolled-machine count — in the same IndexedDB database the control blocks used to live in. The party id is read *out* of that database, so the database cannot be named after the party. The two roles are now split:

- `strand-storage.ts` keeps the key `'control'` under the new name `NODE_LOCAL_STORE_KEY`, re-documented as the historical name of the node-local `kv` database rather than a cadre-core scope key;
- `startCadre` opens that database first (party id, identity, first-seen, the three durable slots, exactly as before), then `await openStores([controlStorageScope(partyId)])` before `node.start()`, and points `controlStorage`, `getControlDbHandle()` and `getControlStorage()` at the **party-scoped** store.

**Consequence, stated plainly: an existing tab keeps its identity, party id and trust anchor, and comes up with an empty control block store.** Strands it founded before the upgrade are not carried over. `runOwnerGenesis` re-anchors on every start, so the tab still boots. The old unscoped blocks are left in place — unread and undeleted — because they belong to a party that was never recorded alongside them, which is exactly the defect being fixed; adopting them into any party's store would reintroduce it. This is dev-build-only behaviour and the same one-time reset every other embedder takes.

**React Native and NativeScript needed no code change** — `sereus-${scope}` already produces `sereus-control-<encoded party>`. Both got documentation notes about the now-orphaned `sereus-control` database, in the same shape as the existing note in `cadre-phone.ts` about the abandoned `sereus-peer-identity` database. The practical effect on the phone: switching the party id in Settings now starts on a clean control store instead of inheriting the previous party's strands — which is the behaviour the fix ticket recorded as wrong on the Galaxy Note 9 (a node connected as one party read 10 `Strand` rows, including strands founded under a different auto-generated party id).

**CLI and host were already isolated — confirmed while implementing, recorded here as the ticket asked:**

- `cadre-host` gives every managed node its own `workdir/storage` directory and one party per node (`host-process-orchestrator.ts` ~556, ~961, ~1003). Host-managed nodes were never sharing a control store. It builds no storage provider of its own — it spawns `cadre-cli` — so nothing there changed.
- `cadre-cli` maps the scope to `${config.path}/${scope}` and a config file carries one `controlNetwork.partyId`. Two configs for two parties pointed at one `storage.path` **were** sharing before this fix and are separated by it: the directory becomes `control-<encoded party>` instead of `control`. No CLI code change beyond a parameter rename and a doc paragraph.

## Deviations from the ticket, and why

**The integration harness got a `control()` accessor rather than each scenario rebuilding the key.** The ticket said to write `capture.provider(controlStorageScope(partyId))` at the call sites. `RawStorageCapture.provider` mints a store on demand, so a call site that built the key from the wrong party id — or from a party id the node never used — would silently receive a **fresh empty store**, and `readBlockIndex` on an empty store reports empty rather than throwing. Every coverage assertion downstream would then pass vacuously, which is the precise failure `block-store-probe.ts` exists to prevent. `capture.control()` finds the store minted under whatever control-scoped key the node actually asked for, and **throws** (`BlockStoreProbeError`, naming the scopes seen) when there is none. Two new unit tests cover both halves.

The scenario assertions I did not just mechanically translate: `strand-membership-closed-strand-e2e.integration.ts` line ~1060 used to assert `capture.scopes()` contains `'control'`. It now asserts `capture.scopes().filter(isControlStorageScope)` has length exactly 1 — the same anti-vacuity floor, stated against the property rather than a literal, and it additionally catches a capture that somehow saw two control scopes.

**Diagnostics `kv` count, not in the ticket.** The web diagnostics panel counted six IndexedDB object stores on the control database, one of which is `kv`. After the split those `kv` rows live in the node-local database, so the panel would have reported a flat `kv: 0`. `collectStorage` now counts the five block stores on the party-scoped database and `kv` on the node-local one, via a new `getNodeLocalDbHandle()` export. The alternative — leaving a diagnostic silently reading zero — seemed worse than the small addition. Worth a look: it is the one behaviour change in this diff nothing in the test suite covers, because the web unit tests do not exercise `collectStorage` (they cover the stores and formatting helpers). The `e2e/solo/diagnostics.spec.ts` assertion on `diag-storage-backend` is unaffected — the label is still `IndexedDBRawStorage`.

**Docs beyond the one line the ticket named.** `docs/architecture.md` gained a "Storage scope keys" subsection (the table, the two invariants, the decode snippet) and three corrected sentences elsewhere; `packages/cadre-core/README.md`, `packages/reference-app-web/README.md`, `packages/reference-app-ns/README.md` and `docs/reference-app-ns.md` each carried a `(strandId) => IRawStorage` signature or a "partitions by key `'control'`" sentence that is now wrong. All were corrected.

## Tripwires parked in code (index only — the reasoning is at the site)

- `packages/integration-tests/src/harness/block-store-probe.ts`, in `controlOrNull` — `control()` returns the first control-scoped store it finds, which is unambiguous only because one capture belongs to one node and one node serves one party. `NOTE:` at the site says to make it refuse a second control scope if a scenario ever drives two party ids through one capture.

## Known gaps — treat these as the floor, not the finish line

- **Nothing exercises a real two-party device end to end.** The regression guard proves the *key* differs and the stores differ at the seam where the bug lived (`buildControlNodeOptions`), and it proves the charset/round-trip invariant. It does not start two nodes for two parties against one persistent backend and prove the rows stay apart. That would need a file-backed two-node scenario in `integration-tests`; it was not written, and the pure-unit guard is what actually catches a regression of this specific defect.
- **The single-instance provider form (`provider` given as an `IRawStorage` rather than a factory) still shares one store across every scope and every party by construction.** The contract now says so in `types.ts`, `docs/architecture.md` and the cadre-core README, but nothing enforces it and nothing exercises it end to end — `backlog/debt-shared-store-provider-never-exercised-end-to-end` covers that separately. This ticket only wrote the caveat down.
- **The web change was verified by typecheck, `check:svelte` and the unit suite, not by running the app.** `startCadre`'s two-phase open (node-local database → read party id → party-scoped database) has no unit coverage; the web tests do not construct a `CadreNode`. Loading the app and confirming a tab still comes up with its previous identity and an empty control store is the obvious manual check, and it was not performed.
- **No migration path, deliberately.** Data under the old unscoped key is never read and never deleted, on every platform. If a reviewer disagrees with "leave it", the argument to beat is that the orphaned rows have no recorded party, so nothing can merge them into a party's store without re-creating the defect — and deleting a user's blocks during a library upgrade is the worse failure mode.
- **`storage-scope.ts` uses tabs; `cadre-node.ts` and `types.ts` use two spaces.** That split already exists in `packages/cadre-core/src` (16 of 70 files are tab-indented, all the newer ones) and `yarn lint` is silent on it, so the new file follows the newer convention. Flagging it only so it does not read as an accident.
