----
description: Every package in this repo currently fails to load because a networking library we depend on renamed one of its functions, and the middle library that sits between us and it was never updated. Nothing in this repo can be built, tested, or run until that middle library is fixed.
files: package.json, ../optimystic/packages/db-p2p/src/cohort-topic/host.ts, ../optimystic/packages/db-p2p/src/cohort-topic/stream-util.ts, ../optimystic/packages/db-p2p/src/reactivity/notify-transport.ts, ../optimystic/packages/db-p2p/src/reactivity/push-state-gossip.ts, ../Fret/packages/fret/src/rpc/protocols.ts
repro: verified
----

**Category (b) — a dependency outside this repo.** What unblocks it: `@optimystic/db-p2p` stops
importing `readAllBounded` from `p2p-fret` and moves to that library's replacement API. This
repository can read `../optimystic` but does not edit it, so the change cannot land here.

# Sereus cannot build or run: `../optimystic` imports a function `../Fret` deleted

## What happens

Every entry point in this repo dies at module-load time:

```
$ node -e "import('@serfab/cadre-core')"
CADRE-CORE IMPORT FAIL: The requested module 'p2p-fret' does not provide an export named 'readAllBounded'
```

`yarn build` fails the same way, in `@serfab/quereus-plugin-sereus`'s browser-bundle step, four
times over:

```
../../../optimystic/packages/db-p2p/dist/src/cohort-topic/host.js:56:21: ERROR: No matching export
  in "../../../Fret/packages/fret/dist/src/index.js" for import "readAllBounded"
```

This is not a partial outage. `cadre-core` is unloadable, so every suite that touches it — which is
effectively all of them — is red, and no ticket in this repo that needs a build can make progress.

## Why

The three repos are linked, not versioned, against each other:

- this repo's root `resolutions` pins `@optimystic/*` to `link:../optimystic/packages/*`
- `../optimystic`'s root `resolutions` pins `p2p-fret` to `portal:../Fret/packages/fret`

On 2026-08-18, `../Fret` commit `f5f2eb6` ("ticket(implement): rpc-framing-src") **replaced** the
exported `readAllBounded` with a `sendFramed` / `readFramed` pair. The commit's own diff comment
states the intent:

> `sendFramed` and `readFramed` ship together for the same reason: a consumer given only the
> reader hand-rolls the writer, and the framing has to match.

`../optimystic/packages/db-p2p` was never updated. It still imports the deleted name at 16 sites
across 7 files (4 source, 1 test harness, 2 specs).

The two functions are **not** the same operation, so this is a port and not a rename:

| | old `readAllBounded(stream, maxBytes, timeoutMs?, opts?)` | new `readFramed(stream, maxBytes, timeoutMs?, opts?)` |
| --- | --- | --- |
| reads | every byte until the stream ends | exactly one length-prefixed frame |
| writer side | plain `stream.send(body)` | `sendFramed(stream, body)` (varint length prefix) |

Adopting `readFramed` therefore changes what goes over the wire for `db-p2p`'s cohort-topic and
reactivity protocols — both ends must move together.

## Why this is the human's call, not the pipeline's

Two defensible resolutions exist and they land in different repositories:

1. **`db-p2p` adopts FRET's framing** — swap each `stream.send(frame)` / `readAllBounded` pair for
   `sendFramed` / `readFramed`. Follows the direction FRET deliberately moved in, and keeps one
   framing convention across both protocol families. Costs a wire-format change in `db-p2p`
   (v0.24.0 is published, so released peers would not interoperate with the new build). Note
   `db-p2p`'s own comment in `stream-util.ts` says its bodies are already self-delimiting via the
   db-core codec, so FRET's prefix is redundant here — harmless, but redundant.
2. **`db-p2p` keeps read-to-end and inlines its own bounded reader** — copy the pre-`f5f2eb6`
   `readAllBounded` body into `db-p2p`. No wire change, no compatibility break, at the cost of ~60
   duplicated lines and a helper FRET intentionally stopped owning.

A third option — `../Fret` re-exports `readAllBounded` as a compatibility shim — is available but
appears to run against the point of the FRET ticket that removed it.

**Recommended default: option 1**, on the grounds that FRET's change was deliberate and both
`../optimystic` and this repo currently carry a stated "no backwards compatibility yet" posture. It
is fully reversible — the port is confined to 7 files in one package.

**If nothing is done:** this repo stays unbuildable and its ticket pipeline cannot run at all.

## Companion ticket

A fix-stage ticket describing the same defect has been filed on the owning repo's own board at
`../optimystic/tickets/fix/db-p2p-imports-removed-fret-read-all-bounded.md`, so that repository's
pipeline can resolve it. Once it lands and `../optimystic` is rebuilt, delete this ticket — there
is no work left in this repo.

## How to confirm it is unblocked

```bash
cd c:/projects/sereus
node -e "import('@serfab/cadre-core').then(()=>console.log('OK'))"
yarn build
```
