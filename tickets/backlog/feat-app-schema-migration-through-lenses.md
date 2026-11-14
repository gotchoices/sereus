description: Let members of a shared workspace run different versions of an app, each keeping its own view of the shared tables, so one party upgrading no longer locks out the others. This uses the "lens" mechanism of the database engine Sereus builds on, and needs design work first.
architecture: docs/strands.md#direction-quereus-lenses
files: docs/strands.md, packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, ../quereus/docs/lens.md, ../quereus/docs/migration.md
tradeoffs: The stop-gap (every member on one schema version) is safe and simple, and each open question below (agreeing on a basis change, retiring columns, shipping lenses, replicated materialized views) is real design work that only pays once apps upgrade independently across parties.
----

# App schema migration through Quereus lenses

The decided direction is in docs/strands.md → "Direction: Quereus lenses". It replaces the stop-gap `app-schema-version-gates-strand-open`, under which every member must run the same `App` schema version.

## The shape

Quereus `docs/migration.md`: a shared **basis** schema that evolves additively only, and per-version **logical schemas** with **lenses** over it, local to each app. In a strand the basis is the `App` schema, which Sereus applies and Optimystic replicates. The reporter of gotchoices/sereus#59 showed that one member's lens over `App` reads, inserts, updates and deletes in step with a member using `App` directly.

## Questions the design must answer

- **Changing the basis.** Which version may add to it, and how the change is applied and recorded so that no member's apply removes what another added. Today every connect applies a full declarative diff.
- **Retiring from the basis.** A column or table no version uses any more: who decides, and how it is removed once no member still maps it.
- **Shipping the lens.** Whether `SAppConfig` carries the logical schema and lens beside the basis, and whether the author's signature covers them.
- **Derived tables.** The "expand" phase of migration.md maintains a materialized view from the old table. On a strand, rows arriving from another member are not derived into it (gotchoices/optimystic#58).
- **Retiring the stop-gap.** How a strand gated by `schemaVersion` moves to lens-based versions.
