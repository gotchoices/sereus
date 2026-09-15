description: On a phone or browser, every party id the app connects with reads and writes the same local control-network store, so a node started for one party sees another party's strands (verified on the Android phone: a fresh party id listed 10 strands created under other party ids). Once restarted strands are re-attached again, an open strand from the other party would be auto-joined.
files:
  - packages/cadre-core/src/cadre-node.ts (~1493: `provider('control')`, a literal with no party id)
  - packages/reference-app-rn/src/cadre-phone.ts (`createStorage`: LevelDB `sereus-${id}`, so `sereus-control` for every party)
  - packages/reference-app-rn/src/phone-node-config.ts (~34: provider contract documents `'control'` for the control network)
  - packages/reference-app-ns/src/ns-storage.ts (~155: `sereus-${strandId}`, same shape)
  - packages/reference-app-web/src/lib/strand-storage.ts (~40-42: `CONTROL_STORE_KEY = 'control'`, "keep in sync" with CadreNode's literal)
  - packages/cadre-cli/src/commands/node-session.ts (~33: `${config.path}/${strandId}`; per-node path, so likely unaffected — confirm)
repro: verified
----

# The control-network store is not scoped to the party

## Evidence (device, 2026-09-15)

Galaxy Note 9, debug `reference-app-rn`. Several solo sessions ran today under different party ids: an auto-generated uuid at 16:33 (strands `82dc7f6b`, `7b228868`), and others earlier. At 16:48 the node was connected with party id `11111111-2222-4333-8444-555555555555`, which had founded exactly one strand (`c7160779`). Through the debugger:

- `node.partyId` = `11111111-2222-4333-8444-555555555555`
- `select * from Strand` on its control database: **10 rows**, including `82dc7f6b` and `7b228868` from the other party, all `Type 'o'`, same `FounderOwnerKey` (one device identity).
- `strandWatcher.knownStrands` (via `queryStrands()`): the same 10 ids.

## Cause

`CadreNode` resolves its control storage as `config.storage.provider('control')`, which carries no party id. Every in-tree embedder maps the key straight to a store name (`sereus-control` on RN and NS; `control` on web), so all parties on one device share one control block store. Strand storage is keyed by strand id, a uuid, so strands do not collide with each other; the control network is the only shared scope.

## Why it matters

- A node started for party B reads party A's `Strand` rows (and every other control table: owner keys, peers, invites, revocations) as if they were B's. Which of these a node acts on without further checks has not been audited.
- `use-cadre.ts` auto-joins discovered open strands. Today `fix/rn-restart-leaves-stored-strands-dormant` hides this: discovery events are lost at startup. Once that fix lands, starting as party B would join party A's open strands.
- Party B's writes land in the same store, so leaving a party or switching party id cannot cleanly discard one party's control data.

The usual case (one fixed party per device) does not show the problem. It shows whenever the party id changes: the RN app currently makes you type it each launch (`backlog/feat-rn-persist-node-start-options`), and a device can be removed from one party and join another.

## Direction

- Scope the control store to the party in cadre-core, e.g. `provider(\`control-${partyId}\`)` or a structured `{ scope: 'control', partyId }` argument. That way no embedder can get it wrong, and web's "keep in sync" constant goes away.
- Existing installs: data under the old unscoped key belongs to an unknown party. Pick one: ignore it (dev builds only so far), or adopt it only when it holds this party's genesis. Decide in the fix, and don't silently merge.
- Test: two `CadreNode`s started one after the other with different party ids over one storage provider. The second must not see the first's `Strand` rows.
- Confirm whether `cadre-cli` and `cadre-host` paths already include the party (per-node directory) and say so in the ticket's completion note.
