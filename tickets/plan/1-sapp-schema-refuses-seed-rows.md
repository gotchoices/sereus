description: The schema guide tells app authors to use "seed" rows to pre-fill tables like a list of roles, but Sereus never inserts those rows into a shared database, and whether it should is a design call with a real risk attached.
architecture: docs/schema-guide.md
files: packages/quereus-plugin-sereus/src/compose-strand.ts, docs/schema-guide.md, ../quereus/packages/quereus/src/runtime/emit/schema-declarative.ts
----

# Decision: should an app's seed rows be inserted into its strand?

**Blocked category:** the specification is silent. **Unblocks when:** a human accepts, edits or rejects the proposed rule below.

## Background, in plain terms

An app built on Sereus hands the plugin its database schema as text. Quereus schemas can include `seed` items — fixed rows the schema author wants present, such as `seed roles (('admin'), ('member'))`. Quereus inserts them only when the schema is applied with `apply schema <name> with seed`, and it does so idempotently: each seed row is inserted with `on conflict (<primary key>) do nothing`, so re-applying leaves existing rows (and any edits to them) alone (`../quereus/packages/quereus/src/runtime/emit/schema-declarative.ts`, the `withSeed` branch).

Sereus applies an app's schema in exactly one place, `applyAppSchema` in `packages/quereus-plugin-sereus/src/compose-strand.ts`, and it runs `apply schema App;` **without** `with seed`. So every seed item in an app schema is parsed and then ignored. Nothing in the repository applies seeds (`grep -rn "with seed" packages docs schemas` finds only the schema guide's own Quereus workflow example). Meanwhile `docs/schema-guide.md` has a "Seeds (Deterministic Bootstrapping)" section and a Practical Guidance bullet recommending seeds, and its larger examples use them. The implement ticket `debt-schema-guide-examples-never-executed` changes the guide to say plainly that seeds do not insert rows today, pointing here.

## Why it is not just "add `with seed`"

`applyAppSchema` runs on every node of a strand, each time that node connects, and also when an app claims a live strand (cadre-core's `StrandDatabase.attachAppSchema`). With `with seed`, every node would insert the same seed rows at bring-up. On one machine that is harmless. On a strand's network, two nodes inserting the same primary key at the same time is the concurrent-duplicate case the guide describes under "Ordering Events": exactly one commit wins and the other writer gets a `UNIQUE constraint failed` error — which, raised inside the apply, would fail that node's connect. Whether `on conflict do nothing` absorbs a *concurrent* duplicate on a networked strand, rather than only a sequential one, has not been measured.

## Proposed rule (recommended default)

> An sApp schema's `seed` items are not applied to a strand. Rows an app needs at birth are written by the app itself when it founds the strand, as ordinary writes. The schema guide says so, and the seed section shows seeds only as a Quereus feature for local databases.

Optionally, to stop authors being surprised: `applyAppSchema` rejects an app schema containing `seed` items with an error that says why.

## Alternatives rejected

- **Apply seeds on every connect (`with seed` in `applyAppSchema`).** Simplest, and matches what the guide currently implies, but puts a network write on every node's bring-up path and risks failing connects on the concurrent-duplicate race above. Would need a measured answer on how that race behaves before it could be recommended.
- **Apply seeds only when the strand is founded.** Avoids the race, but the plugin does not know whether this connect is the founding one — that knowledge lives in cadre-core's strand lifecycle — and seeds added in a later schema version would then never reach an existing strand.

## If we do nothing

The guide (once repaired) is honest that seeds do nothing in a strand, and seed items stay silently ignored. No data is at risk; an author who skips the note gets an empty table and discovers it at runtime.

## Reversibility

Fully reversible either way: no stored data depends on the choice, and switching later is a one-line change in `applyAppSchema` plus guide text.

## Maintainer decision (2026-09-30)

**Refuse seed rows.** Adopt the proposed rule: an sApp schema's `seed` items are not applied to a strand, and `applyAppSchema` refuses a schema containing any, with an error saying that rows an app needs at birth are written by the app when it founds the strand. Update `docs/schema-guide.md` so its seed section shows seeds only as a Quereus feature for local databases, and add a release note.
