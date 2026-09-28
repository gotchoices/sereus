----
description: decide and reconcile the "tabs for code" indentation claim — no .editorconfig exists and indentation is actually mixed across packages
files: AGENTS.md, docs/STATUS.md, eslint.config.mjs, .editorconfig (does not yet exist)
difficulty: easy
----

# Reconcile the "tabs for code" indentation claim with reality

Flagged by the review of `build-health-eslint` and carried forward from the lint-warning-cleanup fix
ticket. Needs a maintainer decision — it is not machine-enforceable cleanup, so it does not belong in the
lint burndown tickets.

## The discrepancy

AGENTS.md says *".editorconfig contains formatting (tabs for code)"* and `eslint.config.mjs` defers
indentation to `.editorconfig` to avoid a formatter war. But:

- **No `.editorconfig` exists** anywhere in the repo.
- Indentation is in fact **mixed** — e.g. `packages/cadre-host/src` uses 2-space, `packages/cadre-core/test`
  uses tabs.

So "tabs for code" is currently enforced nowhere and isn't even consistently followed.

## Decision needed

A maintainer should choose one of:

- **(a) Commit to tabs:** add a real `.editorconfig` (`indent_style = tab` for code, with any per-type
  overrides), reformat the offending trees, and optionally wire an ESLint/formatter indentation rule so it
  stays enforced. This is a large, churny reformat — scope it deliberately and land it isolated from
  behavioral changes so diffs stay reviewable.
- **(b) Accept reality:** correct AGENTS.md and `docs/STATUS.md` to describe the actual (mixed, or
  per-package) convention and drop the unbacked "tabs for code" claim.

Until decided, this is documentation/tooling debt, not a bug. Pick (a) or (b) and update AGENTS.md +
`docs/STATUS.md` to match whatever is chosen.
