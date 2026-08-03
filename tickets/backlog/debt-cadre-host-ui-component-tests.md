description: The self-hosted manager's dashboard has no way to test anything that draws on screen, so the safety prompt guarding an irreversible "leave this shared network" action is only ever checked by a person clicking it.
files: packages/cadre-host/vitest.config.ts, packages/cadre-host/package.json, packages/cadre-host/ui/vite.config.ts, packages/cadre-host/ui/src/components/ConfirmDialog.svelte, packages/cadre-host/ui/src/routes/Strands.svelte, packages/cadre-host/ui/__tests__/
difficulty: medium
----

# The cadre-host dashboard cannot test its own screens

## Situation

`packages/cadre-host/vitest.config.ts` runs one suite, in the `node` environment,
with no Svelte plugin. A test therefore cannot `import` a `.svelte` file at all:
there is nothing that compiles one, and no DOM for it to render into. Every test
under `ui/__tests__/` is consequently a plain-module test (`api`, `events`,
`router`, `typed-confirm`, `strand-removal`), and **every one of the dashboard's
seventeen components and pages is executed only when a human opens a browser.**

The package already depends on `jsdom`, and `ui/vite.config.ts` already configures
the Svelte plugin, so the pieces exist; nothing wires them together for tests.

## Why it matters now

The Strands page (landed in `feat-cadre-host-strand-removal-screen`) put the most
destructive action the dashboard offers behind a prompt that only a rendered
component enforces:

- Leaving a **closed** shared network destroys this party's membership key for it.
  It is stored nowhere else — the network can never be re-entered or re-shared.
- The only thing standing in front of that is a dialog whose confirm button stays
  disabled until the operator types the network's id exactly.
- The rule for "does the typed text match" is a plain function and is tested. The
  *wiring* — that the button really is disabled, that Enter obeys the same gate,
  that the field is emptied when the dialog is reopened on a different network so
  a stale match cannot be inherited — is not, and cannot be with today's setup.

The implementer flagged this honestly and the review pass moved everything that
could leave the template into tested plain modules. What remains is genuinely
component-shaped and needs a component runner.

## What this ticket is for

Make it possible to mount a Svelte component in a test in this package, then use
that to cover at minimum:

- **`ConfirmDialog`** — the typed-confirmation gate end to end: disabled on open,
  stays disabled on a near-miss, enables on an exact match and on a paste, Enter
  in the field does exactly what the button does, the field resets when the dialog
  closes and when it reopens against a different value, both buttons are inert
  while a confirmation is in flight, and dialogs that pass no `requireText` (the
  trust-circle callers) are unchanged.
- **`Strands`** — that the three list states (not yet loaded / failed / empty) are
  distinguishable, that a load failure does not discard an already-loaded list,
  that the confirm-and-delete path sends the confirmation flag for a closed
  network and never for an open one, and that a single removal produces exactly
  one piece of feedback.

Whatever shape the runner takes, the existing `node`-environment tests under
`src/**/__tests__/` must keep running as they do, including the stale-build guard
wired through `globalSetup` — see `debt-build-guard-wiring-unasserted`, which
also targets this config file and may constrain how it is restructured.

The same gap covers the other pages and components; Strands is only the sharpest
instance because its mistake is unrecoverable.
