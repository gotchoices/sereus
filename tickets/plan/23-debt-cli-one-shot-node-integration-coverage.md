<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-08-02T07:07:43.815Z (agent: claude)
  Log file: C:\projects\sereus\tickets\.logs\23-debt-cli-one-shot-node-integration-coverage.plan.2026-08-02T07-07-43-815Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: The command-line tool's one-off commands are never tested against a real running node, so a mistake in the shared "start up, do one thing, shut down" step would not be caught by any test.
files: packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/commands/subcommand.ts, packages/cadre-cli/src/commands/strands.ts, packages/cadre-cli/src/commands/validation-key.ts, packages/cadre-cli/test/subcommand-wiring.spec.ts, packages/cadre-core/test/strand-unpublish.spec.ts
difficulty: medium
----

# CLI one-shot commands have no real-node coverage

## What is untested

Every one-shot `cadre` command (`strand list`, `strand remove`, `validation-key add|remove|list`)
runs the same three steps: read the config file, start a `CadreNode` and wait for it to join the
control network, then perform one control-database operation and shut down. That middle step
lives in one function, `withConnectedNode` (`packages/cadre-cli/src/commands/node-session.ts`),
and **no test ever runs it.**

Coverage today stops on either side of it:

- `packages/cadre-cli/test/subcommand-wiring.spec.ts` drives the real commander parsing, the
  shared `runSubcommand`/`reportPlan` scaffolding and the node adapters — but replaces
  `withConnectedNode` with a stub that hands over a fake node.
- `packages/cadre-core/test/strand-unpublish.spec.ts` (and the validation-key equivalent) drive
  the control-database writes against a real database — but never through the CLI.

So a defect in config resolution, node construction, the connect-or-time-out race, or the
shutdown path would pass every suite in the repo and only surface for an operator.

## Why it is worth closing

These commands are the operator's only way to perform destructive control-plane writes
(removing a strand destroys a membership key that exists nowhere else). "The wiring is
obviously right" is exactly the assumption that a rename, an option-default change, or a
config-schema edit quietly invalidates.

## What a fix looks like

A test that stands up a single-node control network in-process — the same way
`strand-unpublish.spec.ts` already does — writes a temporary config file pointing at it, and
invokes the built command surface end to end, asserting on both the output and the exit code.
One such test per command shape (a read command and a destructive write command) is enough; the
point is to cover `withConnectedNode`, not to re-test each command's decision logic, which is
already covered.

Open questions for whoever picks this up:

- Whether it belongs in `packages/cadre-cli/test/` or in `packages/integration-tests/`, given
  it needs a real control network.
- Whether to invoke through `parseAsync` (in-process, but then `process.exit` has to be stubbed
  and the exit code inferred) or by spawning the built `dist/bin/cadre.js` as a child process
  (slower, but observes the real exit code and real stream separation).

## Related

- `debt-strand-unpublish-multi-node-convergence-test` covers a different gap: whether a *sibling*
  node converges after a removal. This ticket is about the CLI's own plumbing on one node.
