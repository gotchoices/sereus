----
description: wire svelte-check into a build-health gate and fix the latent error it already surfaces in cadre-host/ui events.ts:67
files: packages/cadre-host/ui/src/lib/events.ts, packages/cadre-host/ui/package.json, packages/reference-app-web/package.json, package.json
----

# Add a `svelte-check` gate (and fix the latent error it catches)

Carried forward from the lint-warning-cleanup fix ticket as a separate concern. ESLint's svelte pass lints
style/correctness rules but does **not** run `svelte-check` (svelte's own type/template diagnostics), so a
class of errors goes uncaught by any current script.

## Known latent error

`packages/cadre-host/ui/src/lib/events.ts:67` reports **"'ctor' is possibly 'undefined'"** under
`svelte-check`. No current gate catches it. This should be fixed as part of standing up the gate (and
serves as the proof the gate works).

## Scope

- Add a `svelte-check` invocation for each svelte UI package (`cadre-host/ui`, `reference-app-web`) — a
  per-package `check` script and a root aggregate, parallel to how `yarn lint` / `yarn typecheck` are
  wired in the root `package.json`.
- Decide whether it runs as part of `yarn typecheck` or as its own `yarn check:svelte` gate.
- Fix `events.ts:67` (and any other errors the first clean run surfaces — report them; a large backlog may
  warrant its own burndown ticket, mirroring the ESLint approach).

This is a build-health enhancement, not a blocker; promote from backlog when the build-health track is
ready to pick it up.
