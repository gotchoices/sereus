description: On a phone or in a browser, every party the app connects to shares one local database of party-wide records, so a node started for one party reads and writes another party's data. Give each party its own store so switching party ids starts clean.
files:
  - packages/cadre-core/src/cadre-node.ts (`resolveControlStorage` ~1489; the provider contract doc ~329)
  - packages/cadre-core/src/types.ts (`RawStorageProvider` ~118, `StorageConfig.provider` ~148)
  - packages/cadre-core/src/index.ts (export the new scope helpers)
  - packages/cadre-core/test/cadre-node-control-node-options.spec.ts (~261, ~317, ~376 assert the scope key)
  - packages/cadre-core/test/control-db-node-helpers.ts (~146 doc; `fileStorageProvider` already escapes)
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts (~30, ~147, ~169 comments only)
  - packages/reference-app-rn/src/cadre-phone.ts (`createStorage` ~83)
  - packages/reference-app-rn/src/phone-node-config.ts (~34 provider contract doc)
  - packages/reference-app-ns/src/ns-storage.ts (`makeLazyNsStorage` ~155)
  - packages/reference-app-web/src/lib/strand-storage.ts (`CONTROL_STORE_KEY` ~40-42)
  - packages/reference-app-web/src/lib/cadre-web.ts (`startCadre` ~284-296, `getControlDbHandle`/`getControlStorage` ~200-208)
  - packages/reference-app-web/src/lib/node-local-slots.ts (module doc names `CONTROL_STORE_KEY`)
  - packages/integration-tests/src/harness/block-store-probe.ts (`CONTROL_SCOPE` ~40, module doc ~28)
  - packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts (~67 `capture.provider('control')`)
  - docs/architecture.md (~1418 storage-provider section)
difficulty: medium
repro: verified
----

# Give the control database a per-party storage scope

## What is wrong

`CadreNodeConfig.storage.provider` is a factory cadre-core calls once per **scope**: once for the control database and once for each strand. The strand scopes are strand ids — uuids, globally unique, so two parties never collide there. The control scope is the literal string `'control'`, which carries no party id. Every embedder maps that string straight to a store name (`sereus-control` on React Native and NativeScript, the `control` IndexedDB database on web), so **every party on one device reads and writes one control database**.

The control database is where the party's own records live: its strands, its owner keys, its peers, its invitations, its revocations. Sharing it across parties means a node started for party B sees party A's rows as if party A had written them for B.

Everything else that is party-scoped in this codebase already knows it has to be. `PersistentTrustedOwnerStore`, `PersistentBootstrapPeerStore` and `PersistentEnrolledMachineStore` all take a `partyId` and `start()` **fails closed** when a store's party does not match the node's (`cadre-node.ts` ~1244, ~1279, ~1312). Both phone apps key their node-local slots by party id for exactly this reason — `reference-app-rn/src/node-local-slots.ts` (`anchorSlotKey`) and `reference-app-ns/src/node-local-slots.ts` (`trusted-owners.<partyId>`). The control block store is the one that was left unscoped.

## How it was reproduced

Two ways, both confirmed.

**On the device** (recorded in the fix ticket): Galaxy Note 9, debug `reference-app-rn`. A node connected as party `11111111-2222-4333-8444-555555555555`, which had founded one strand, read **10 rows** out of its control `Strand` table — including strands founded that morning under a different, auto-generated party id.

**In process, at the seam** (run 2026-09-15, then removed — it belongs in the tree as the regression guard below): two `CadreNode`s built with different `controlNetwork.partyId` over one memoizing provider. `buildControlNodeOptions()` is pure on a bare node, so no libp2p node starts and no database opens. The provider was asked for scope `'control'` both times and both nodes received the identical store object:

```
scopes requested: [ 'control', 'control' ]
```

## The fix

Scope the control store key to the party **inside cadre-core**, so no embedder can get it wrong and no embedder has to know the party id is part of the key.

Add a small module (`packages/cadre-core/src/storage-scope.ts` — not `cadre-node.ts`, which `backlog/debt-cadre-node-single-file-size` already flags as oversized), exported from `index.ts`:

```ts
/** The storage scope key for a party's control database. */
export function controlStorageScope(partyId: string): string;

/** Whether a scope key names a control database rather than a strand. */
export function isControlStorageScope(scope: string): boolean;
```

`controlStorageScope` returns `control-` followed by the base64url encoding of the party id's UTF-8 bytes. The encoding is not decoration:

- A party id is **arbitrary text**, not a validated uuid. Nothing in cadre-core checks its shape, and the React Native app lets you type it into Settings each launch. `reference-app-rn/src/secure-key-store.ts` (`secureStoreKeySegment`) already base64url-encodes it for the same reason, and its comment says so outright.
- Scope keys reach real namespaces unescaped: `cadre-cli` builds `new FileRawStorage(...)` over `${config.path}/${scope}`, React Native builds a LevelDB filename, web builds an IndexedDB database name. A party id containing `/` or `..` would escape the CLI's storage directory. Encoding keeps every scope key inside `[A-Za-z0-9._-]`, which is the invariant embedders already rely on today because strand ids are uuids.
- Decoding for debugging is one line: `atob(key.slice('control-'.length).replace(/-/g,'+').replace(/_/g,'/'))`. Put that in the doc comment, so the next person reading `sereus-control-MTExMT…` off a phone is not stuck.

`isControlStorageScope` is the prefix test. It is safe because a strand scope is a strand id and a uuid never starts with `control-`; say that in the doc rather than leaving it implicit.

`resolveControlStorage()` then calls the provider with `controlStorageScope(partyId)` and passes the same key as the cache label to `wrapStorageWithCache` (the label only names the store in the shared pool's `stats()`, but a per-party label makes those stats readable too).

### The provider contract needs rewording, not just a new value

`RawStorageProvider` in `types.ts` is typed `(strandId: string) => IRawStorage` and documented as "the literal string `'control'` … and each strand id". Rename the parameter to `scope` and state:

- the argument is an **opaque scope key**, safe to use directly as a file, directory or database name, always within `[A-Za-z0-9._-]`;
- the control scope is **party-specific**: two parties on one device ask for two different keys and must get two different stores;
- the single-instance form (`provider` given as an `IRawStorage` rather than a function) hands one store to every scope **by construction**, so it shares control data across parties as well as across strands. An embedder that can serve more than one party must use the factory form. (That form has never been exercised end to end — `backlog/debt-shared-store-provider-never-exercised-end-to-end` covers that separately; this ticket only needs the caveat written down.)

### Existing data: ignore it, do not adopt or delete it

Data under the old unscoped `control` key belongs to an unknown party — that is the whole defect — so nothing may merge it into a party's store. Only dev builds exist, so the simple choice is right: **never read it, never delete it.** Document the orphan at each embedder, in the same shape as the existing note in `reference-app-rn/src/cadre-phone.ts` about the abandoned `sereus-peer-identity` database. Deleting a user's blocks from a library upgrade is a worse failure mode than leaving a stale LevelDB file on disk.

### Web is the one embedder with real work

The browser app keeps its `kv` records — the tab's Ed25519 identity, its persisted party id, the trusted-owner anchor, the bootstrap peers, the enrolled-machine count — in the **same IndexedDB database** as the control blocks (`node-local-slots.ts` calls this shared fate: "Clear site data" must wipe them together). That creates an ordering constraint: the party id is read *out of* that database, so the database cannot be named after the party.

Split the two roles, keeping the physical database the `kv` records already live in:

- `strand-storage.ts`: keep the `'control'` key but rename and re-document it — it is no longer "the scope key cadre-core passes", it is the historical name of the database holding this tab's node-local `kv` records. The "keep in sync with `CadreNode`'s literal" comment goes away, which is the point of doing this in core.
- `cadre-web.ts` `startCadre`: open that database first (party id, identity, first-seen, the three slots, exactly as today), then `await openStores([controlStorageScope(partyId)])` before `node.start()`, and point `controlStorage`, `getControlDbHandle()` and `getControlStorage()` at the **party-scoped** store — `diagnostics.svelte.ts` (`collectStorage`, ~677) uses both to report block-store row counts and byte usage, so those must follow the blocks, not the `kv` records.

Consequence, state it plainly in the review handoff: an existing tab keeps its identity, party id and trust anchor, and starts with an **empty control block store** — strands it founded before the upgrade are not carried over. `runOwnerGenesis` re-anchors on every start, so the tab still comes up. Acceptable for dev builds; it is the same one-time reset every other embedder takes.

The alternative — pointing the control scope back at the existing database inside web's provider — was considered and rejected: it loses nothing today (web generates one party id per origin and persists it, so web never actually exhibits the bug) but it puts the party id back outside the key, which is precisely the mistake being fixed, and it would silently return the moment web gains party switching.

### React Native and NativeScript need no code change

`sereus-${scope}` already produces `sereus-control-<encoded party>`. Both get a documentation note about the orphaned `sereus-control` database, and `reference-app-rn/src/phone-node-config.ts` (~34) has a one-line provider-contract comment that now describes the wrong thing.

### CLI and host were already isolated — confirm and record it

Both were checked while researching this; the review handoff should say so:

- `cadre-host` gives every managed node its own `workdir/storage` directory and one party per node (`host-process-orchestrator.ts` ~556, ~961, ~1003). Host-managed nodes were never sharing a control store.
- `cadre-cli` maps the scope to `${config.path}/${scope}`, and a config file carries one `controlNetwork.partyId`. Two configs for two parties pointed at one `storage.path` **were** sharing before this fix and are separated by it. The directory simply becomes `control-<encoded party>` instead of `control`; no CLI code changes.

## The regression guard

One pure-unit spec in `packages/cadre-core/test/`, testing the property rather than one instance — it costs milliseconds because `buildControlNodeOptions` opens nothing:

- two nodes, two party ids, one memoizing provider → **two different stores**, and the two scope keys differ;
- the same party id twice → the **same** store (the provider contract's "call it again after a stop and reach the same durable backend" still holds);
- hostile party ids (`../../etc/passwd`, one containing `/`, one non-ASCII) → the scope key matches `/^[A-Za-z0-9._-]+$/`, and decodes back to the original party id.

The third case is what keeps the path-safety invariant from quietly rotting; without it the encoding looks like ceremony and the next editor removes it.

## TODO

- Add `packages/cadre-core/src/storage-scope.ts` with `controlStorageScope` and `isControlStorageScope`, base64url over `uint8arrays` (`cadre-node.ts` ~6587 shows the existing import shape); export both from `src/index.ts`.
- Point `resolveControlStorage()` (`cadre-node.ts` ~1489) at `controlStorageScope(this.config.controlNetwork.partyId)` for both the provider call and the `wrapStorageWithCache` label.
- Reword the provider contract: `RawStorageProvider` and `StorageConfig.provider` in `types.ts`, and the `controlStorage` field comment in `cadre-node.ts` (~329). Rename the parameter `strandId` → `scope`; add the opaque-key, charset and single-instance-form points above.
- Write the regression spec described under "The regression guard".
- Update the cadre-core specs that assert the old literal: `cadre-node-control-node-options.spec.ts` (~261, ~317, ~376), and the stale comments in `control-db-node-helpers.ts` (~146) and `strand-solo-write-budget.spec.ts` (~30, ~147, ~169 — its filter keys on the strand id, so no behaviour change there).
- Integration harness: replace `block-store-probe.ts`'s local `CONTROL_SCOPE` constant with `isControlStorageScope` in `forStrand`'s refusal and in the scope-collapse check, and fix the module doc (~28).
- `control-offline-read-after-restart.integration.ts` (~67): `capture.provider('control')` → `capture.provider(controlStorageScope(partyId))`. Comment-only fixes in `strand-late-cadre-join.integration.ts` (~621).
- Web: split the node-local `kv` database from the party-scoped block store across `strand-storage.ts`, `cadre-web.ts` and `node-local-slots.ts`'s module doc, as described above.
- React Native / NativeScript: orphan-database notes in `cadre-phone.ts` (~83) and `ns-storage.ts` (~155); fix the provider-contract line in `phone-node-config.ts` (~34).
- `docs/architecture.md` (~1418): describe scope keys and say that the control scope is per-party.
- Run `yarn lint`, the cadre-core suite, and the integration scenarios that touch the storage capture (`control-offline-read-after-restart`, `strand-late-cadre-join`). Type-check the web and React Native apps — the web change is the only one that can break a call site.
- In the review handoff, record: the CLI/host isolation finding above, the one-time empty control store on web, and the orphaned `sereus-control` / `control` stores left on existing devices.
