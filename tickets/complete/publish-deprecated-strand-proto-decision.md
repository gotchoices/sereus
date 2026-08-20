description: A package we no longer publish or maintain (`@serfab/strand-proto`) was removed from the build, the release process, and the repository, and the follow-up review swept the stale references the removal left behind.
files: package.json, yarn.lock, eslint.config.mjs, knip.ts, scripts/publish-package.mjs, scripts/test-typecheck-allowlist.json, AGENTS.md, README.md, packages/README.md, docs/testing.md, docs/architecture.md, docs/strands.md, docs/releasing.md, docs/reference-app-rn.md, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-cli/docker/Dockerfile
----

# Complete: removal of `@serfab/strand-proto`

The package is gone from the repository: its whole `packages/strand-proto/` directory,
`docs/strand-proto.md`, its lockfile entries and libp2p-v4-era transitive dependencies, its
`pub:strand-proto` release script and its slot in the `pub` chain, its ESLint global-ignore
carve-out, its knip workspace block, and its entry in the test-file type-check allowlist (now
`{}`). Docs across `AGENTS.md`, both READMEs, `docs/architecture.md`, `docs/strands.md`,
`docs/testing.md`, `docs/reference-app-rn.md`, and `docs/releasing.md` were rewritten to describe
the five remaining publishable workspaces and the native `cadre-core` formation transport that
took the deleted package's place. No live runtime code changed — the only source edits repo-wide
are doc comments.

Already-published `@serfab/strand-proto@0.9.0` stays on npm; this is a removal from the repo, not
an unpublish.

## Review findings

**Checked:** the full implement diff read before the handoff summary; a repo-wide grep for
`strand-proto` / `strandProto` (outside `tickets/`, `node_modules/`); every publishable-package
count and workspace count the removal could have invalidated; the release/publish wiring
(`package.json` scripts, `scripts/publish-package.mjs`, `scripts/release-preflight.mjs`,
`scripts/smoke-published-install.mjs`); root `tsconfig`/vitest/`.yarnrc.yml`/`.gitignore` for
orphan references; lockfile sync; and the doc set the diff touched plus the ones it should have.

**Minor — fixed in this pass:**

- `scripts/publish-package.mjs` (two comments, lines 17 and 152) still said `yarn pub` is **six**
  `&&`-ed publishes. The docs were corrected to five; this file was missed. Fixed. The adjacent
  `NOTE:` that `yarn pub --tag alpha` tags only `cadre-host` is still accurate (it remains the
  last link in the chain) and was left alone.
- `packages/cadre-cli/docker/Dockerfile` carried a build-closure comment explaining that
  "strand-proto is deprecated and no longer a dependency of either package." That parenthetical
  only made sense while the package existed; removed, leaving the closure statement itself.
- `packages/cadre-core/src/strand-formation-protocol.ts`: the implementer's reword of the
  cadre-disclosure paragraph left a ragged mid-sentence line break; rewrapped. Three remaining
  mentions called the package "deprecated" — it is now *removed*, which is a different fact for a
  reader who can no longer find it in the tree — so they now say "removed" / "legacy", and
  "Mirrors the non-deprecated `seed-bootstrap.ts` service" dropped the "non-deprecated" qualifier
  that only existed to contrast with `strand-proto`.
- `docs/releasing.md` runbook step 6 gives only the POSIX `SEREUS_DIST_TAG=alpha yarn pub` form,
  while the repo's primary shell is PowerShell; added the PowerShell variant inline, matching the
  both-forms treatment the same doc already gives earlier.

**Major (new tickets):** none. This is a deletion plus a documentation sweep with no live logic
change, and the surviving publish chain, lint/typecheck carve-outs, and coverage gates were all
verified consistent with a five-package set — there is no defect class here to file against.

**Tripwires:** none recorded. The one candidate — `PLACEHOLDER_CADRE_ADDR` in
`strand-formation-protocol.ts`, which rejects the `cadre-a-1.local` placeholder addresses the
deleted transport used to emit — is not conditional: it is a permanent cheap structural check
against a peer sending junk, and its comment now says where the shape came from.

**Accepted tradeoffs:** none encountered at any site touched.

**Deliberately left alone:**

- `tickets/blocked/cut-the-interim-release.md` still says "five, not six" and points at
  `tickets/blocked/publish-deprecated-strand-proto-decision.md`, a path that no longer exists now
  that this ticket has moved through the board. That file is a human's inbox item and editing
  another agent's board entry is not this ticket's business; `docs/releasing.md` — the doc that
  ticket actually reads from — is already correct for whoever picks it up.
- Archived tickets under `tickets/complete/` mention `strand-proto` and old package counts. They
  are historical records; not rewritten.
- `packages/reference-app-rn/README.md:225` matches a `strand-proto` grep only as a substring of
  the scenario name `formstrand-protocol-thread-consent-and-provision`. Confirmed unrelated.

## Validation

Everything below run from the repo root after the review fixes:

| Command | Result |
| --- | --- |
| `yarn lint` | exit 0 |
| `yarn build` | all 9 workspaces build clean |
| `yarn typecheck` | exit 0 — 293 test files across 9 packages in-program, 0 allowlisted |
| `yarn workspace @serfab/cadre-core test` | 104 files, 1644 passed / 1 skipped |
| `yarn test:publish-package` | 20/20 |
| `yarn test:release-preflight` | 8/8 |
| `yarn test:dep-ranges` | pass |
| `yarn test:published-smoke-support` | pass (derives its package set from the `pub:*` scripts — now five) |
| `yarn install --immutable` | exit 0 — lockfile in sync after the workspace deletion |

`yarn dep-check` (knip) exits 1, reporting 14 unused files and 62 unused exports spread across
`cadre-host`, `cadre-provider`, `reference-app-rn`, and `reference-app-web`. None of it touches
anything in this diff, the same 14-file count is recorded in `tickets/complete/27-debt-guard-test-files-typechecked.md`
from before this work, and `dep-check` is not part of the root `yarn test` gate. Not this ticket's
finding; nothing filed and nothing skipped.

## Not run

- **`yarn test` across all workspaces** and **`yarn smoke:published`** — both are release-time
  gates needing the network and real elapsed time (`integration-tests` drives multi-process libp2p
  scenarios), beyond what an agent run can hold. `smoke:published` is the one gate that would
  exercise the shortened `pub` chain end-to-end against a real registry; the publish scripts'
  own unit tests and `test:published-smoke-support` (which reads the `pub:*` list) both pass, so
  the wiring is verified as far as it can be offline. Worth running at the next real release.
