# Sereus Docs/Packaging – STATUS

Purpose: Track decisions and options around packaging and documentation for Sereus bootstrap and future modules.

## Packaging Options (Aggregator vs Sub-packages)

- TODO: Evaluate adding top-level aggregator `sereus/index.ts`
  - Why: Provide a single import for client apps (`import { bootstrap } from 'sereus'`).
  - Pros: Simple DX, central place to surface cross-cutting utilities; version pinning in one package.
  - Cons: Extra layer that can mask sub-package boundaries; risk of accidental breaking changes when re-export order changes; adds release overhead.
  - Action: Prototype `sereus/index.ts` that re-exports `@sereus/bootstrap` only; defer publishing until a second module (e.g., `@sereus/core`) exists.

- TODO: Keep sub-package-first model (`@sereus/bootstrap`, future `@sereus/core`, `@sereus/identity`)
  - Why: Clear ownership and versioning per module; least coupling; encourages tree-shaking.
  - Pros: Scoped dependencies; independent evolution cadence.
  - Cons: Apps must manage multiple imports; doc/examples must show per-module imports.
  - Action: Continue publishing `@sereus/bootstrap`; revisit aggregator when ≥2 modules are stable.

- TODO: Protocol ID strategy
  - Keep default `'/sereus/bootstrap/1.0.0'` but allow override per manager and per call.
  - Document recommended app-specific IDs (e.g., `/mychips/bootstrap/1.0.0`, `/chat/bootstrap/1.0.0`).

## Documentation Roadmap

- TODO: Expand `sereus/docs/bootstrap.md` with sequence diagrams (stock/foil flows)
  - Add Mermaid diagrams for 2-message and 3-message flows.
  - Include error paths (rejection, timeout) and cadre disclosure timing.

- TODO: Author `sereus/docs/core.md` (future)
  - Thread lifecycle, schema application patterns, multi-party bootstrap patterns.

- TODO: Cross-link to Quereus schema guide
  - From bootstrap docs, link to `sereus/docs/schema-guide.md` for thread DDL patterns.

## Testing/CI

- TODO: Wire `@sereus/bootstrap` tests into workspace CI
  - Add root scripts to run sub-package tests; document Corepack/Yarn 4 usage.


