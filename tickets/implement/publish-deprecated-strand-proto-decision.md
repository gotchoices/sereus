description: A package we no longer publish or maintain (`@serfab/strand-proto`) needs to come out of the build, the release process, and the repository, because a maintainer already decided to stop shipping it and nothing in the repo depends on it.
files: package.json, packages/strand-proto/, eslint.config.mjs, knip.ts, scripts/test-typecheck-allowlist.json, AGENTS.md, README.md, packages/README.md, docs/testing.md, docs/architecture.md, docs/strands.md, docs/strand-proto.md, docs/releasing.md, docs/reference-app-rn.md
difficulty: easy

# Remove `@serfab/strand-proto` from the build, release chain, and repository

## Decision (already made — see prior ticket history)

A maintainer decided (2026-08-20) to stop publishing `@serfab/strand-proto` and to delete it
outright: no live instances, no external consumers besides whatever already resolved 0.9.0 off npm
(that stays resolvable forever regardless of what this repo does), and the standing position is to
take a known-wanted break now while it costs nothing. This is pure execution — no design question
remains.

The companion question — whether the historical protocol id `/sereus/bootstrap/1.0.0` (defined at
`packages/strand-proto/src/bootstrap.ts:13`, described in `docs/strand-proto.md:4,14`) is the same
protocol as any live transport — is already answered **no**. The three live protocol ids
(`/sereus/formation/1.0.0` in `strand-formation-protocol.ts`, `/sereus/seed/1.0.0` in
`seed-bootstrap.ts`, `/sereus/strand-addr/1.0.0` in `strand-addr-protocol.ts`) are unrelated strings
defined entirely outside this package. Deleting the package deletes that id along with it; nothing
live is affected.

## What "delete it" touches

Six kinds of reference, found by `grep -rl "strand-proto"` across the repo (excluding the package's
own tree and completed/archived tickets):

1. **The package itself** — `packages/strand-proto/` (source, tests, README, package.json,
   `dist/`, `tsconfig*.json`). Delete the whole directory. `workspaces: ["packages/*"]` in the root
   `package.json` picks up workspaces by glob, so no workspace-list edit is needed there.
2. **The publish chain** — root `package.json`:
   - `"pub"` script: drop `yarn pub:strand-proto &&` from the front of the `&&`-chain.
   - `"pub:strand-proto"` script: delete the line entirely.
3. **Lint/typecheck carve-outs that existed only for this package**:
   - `eslint.config.mjs:55` — remove the `'packages/strand-proto/**'` ignore entry (with whatever
     comment accompanies it).
   - `knip.ts:144` — remove the `'packages/strand-proto': { entry: [...] }` config block. Also reword
     the comment at `knip.ts:84` ("cf. strand-proto's test/manual") to describe the pattern without
     pointing at a package that no longer exists — or drop the cross-reference if it doesn't stand on
     its own.
   - `scripts/test-typecheck-allowlist.json` — remove the `"@serfab/strand-proto"` entry. Confirm
     nothing else currently uses this allowlist mechanism; if the file becomes `{}`, leave it as an
     empty object (the scripts that read it — `check-test-file-typecheck-coverage.mjs` and its
     `.test.mjs`) should tolerate an empty allowlist, but run `yarn test:test-file-typecheck-coverage`
     to confirm.
4. **`AGENTS.md`** — repo orientation line (currently ends "... Cross-package real-network tests:
   `integration-tests`. `strand-proto` deprecated."): drop the trailing `strand-proto` mention
   entirely (not just the word "deprecated" — the package no longer exists to describe).
5. **Docs that describe the package or reference its doc page**:
   - `docs/strand-proto.md` — delete the file (it exists to document this package).
   - `docs/architecture.md:1386` — remove the `[Bootstrap Protocol](strand-proto.md)` reference line
     from "Internal Documentation".
   - `docs/architecture.md:1398` — remove the `packages/strand-proto - Bootstrap session management
     (deprecated...)` bullet from "Existing Implementations".
   - `docs/architecture.md:518` — currently: "It mirrors the non-deprecated seed-bootstrap service
     ... and replaces the deprecated `strand-proto`." Rewrite to describe the formation transport on
     its own terms, without the now-dangling contrast (there's nothing left named "the deprecated
     strand-proto" to replace). Something like: "It mirrors the seed-bootstrap service's frame format
     (length-prefixed JSON frames over libp2p streams)." — check the surrounding paragraph for exact
     phrasing that reads naturally.
   - `docs/architecture.md:1418` — currently: "`formStrand()` with full `strand-proto` SessionManager
     integration via `StrandFormationManager`". This already describes *current* code (`cadre-core`'s
     live formation path), not the deleted package — the wording is a leftover from before formation
     moved off `strand-proto`, and it will read as a dangling reference once the package is gone even
     though the code it describes never used the package. Read `StrandFormationManager` and
     `strand-formation-protocol.ts` in `packages/cadre-core/src` and rewrite this clause to name what
     `StrandFormationManager` actually integrates with today, without mentioning `strand-proto`.
   - `docs/strands.md:4` — "History" section currently points at
     `sereus/packages/strand-proto/` and `sereus/docs/strand-proto.md`, both gone after this ticket.
     Reword the sentence to describe the history without a dangling path — e.g. name what the initial
     attempt was and that it has since been superseded by the native `cadre-core` formation transport,
     without linking a path that no longer resolves.
   - `docs/reference-app-rn.md:633` — "Party B calls `formStrand(invitation)` — this dials Party A's
     cadre via `strand-proto`, negotiates strand creation" is already inaccurate (formation is native
     to `cadre-core`, not this package — same fact established in `docs/architecture.md:518` today).
     Fix the wording to say what actually dials/negotiates (the native formation transport), while
     you're touching wording that depended on the package name.
   - `README.md` package table — remove the `@serfab/strand-proto` row entirely.
   - `packages/README.md` — its only "Notes" bullet is `Current: strand-proto/ (published as
     @serfab/strand-proto).`, which is now both wrong and the file's sole content line beyond the
     folder description. Remove that bullet; leave the surrounding "This folder contains
     publishable Sereus libraries..." text.
6. **`docs/testing.md`** — three spots, all listing `strand-proto` as one of the type-checked/covered
   packages:
   - Line ~72: parenthetical list of packages covered via `tsconfig.typecheck.json` — drop
     `strand-proto` from the list.
   - Lines ~137-142: the "Shippable source only" bullet exists specifically to explain why
     `strand-proto`'s three bit-rotted test files are allowlisted out of typechecking
     (`scripts/test-typecheck-allowlist.json`). Once the package and its allowlist entry are both
     gone, this bullet has nothing left to explain — remove it (it's illustrating a mechanism via an
     example that no longer exists; if the allowlist mechanism itself still deserves a one-line
     mention elsewhere in the doc, that's a separate, much smaller edit — don't invent a new example).
   - Line ~237: "`maestro/` (Maestro JS engine), `strand-proto` (deprecated), and non-package trees
     ..." — drop the `strand-proto` (deprecated) clause.
   - Two workspace-count mentions become stale once a workspace disappears: line ~64 ("`yarn
     typecheck` validates all 10 workspaces") and line ~74 ("injecting an unknown key into each of
     the ten configs") both count `strand-proto` among the total. Recount and update both to the new
     total (9) after deletion — don't just guess, re-derive it the way the doc's own list does
     (`cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`, `quereus-plugin-sereus`,
     `integration-tests`, `reference-app-ns`, `reference-app-rn`, `reference-app-web`).
7. **`docs/releasing.md`** — the whole file assumes six publishable packages and, in its "interim
   release" section (drafted 2026-08-03, dated content — treat it as living documentation to correct,
   not history to preserve), spends a full subsection ("Which packages ship: five, not six")
   justifying *excluding* `strand-proto` from one specific release. Once the package is deleted,
   there is no sixth package to exclude — that subsection's premise is gone, not just its subject.
   Needed edits:
   - Overview (lines ~8-16): "Six workspaces are publishable" → five; drop `strand-proto` from both
     the publishable list and the publish-order arrow chain.
   - Step 4 "Or publish individually" code block (lines ~86-92): drop the `yarn pub:strand-proto`
     line.
   - "Prerelease / RC" section (line ~120): "`yarn pub` is six `&&`-ed publishes" → five.
   - Bold recommendation line (~162-163): "for five of the six packages (everything except
     `strand-proto`)" → since there's no longer a sixth package, this becomes simply "for all
     publishable packages" (or equivalent) — the exclusion framing no longer applies.
   - "Which packages ship: five, not six" subsection (~192-203): remove or replace with a short note
     that `strand-proto` has been removed from the repo entirely (this ticket) rather than merely
     skipped for one release; the "permanent question" it points at
     (`tickets/blocked/publish-deprecated-strand-proto-decision`) no longer exists as an open
     question — don't leave a dangling reference to that ticket path.
   - Runbook step 6 (~352-361): currently manually publishes five named packages "not `yarn pub`,
     which also publishes `strand-proto`". Once `strand-proto` is out of the `pub` chain, `yarn pub`
     itself only publishes the (now five) real packages — simplify this step back to
     `SEREUS_DIST_TAG=alpha yarn pub` (matching the pattern already shown earlier in the file under
     "Prerelease / RC"), unless something else in that step depended on per-package sequencing.
   - Leave the rest of the interim-release recommendation (multi-machine caveats, dependency-floor
     bump, draft release notes, the blocker section) untouched — none of it is about `strand-proto`.

## Edge cases & interactions

- **`tickets/blocked/cut-the-interim-release.md`** references this ticket by its old path
  (`tickets/blocked/publish-deprecated-strand-proto-decision.md`) and describes the now-obsolete
  "five packages, not six" framing. That ticket is a human's inbox item in `blocked/`, not owned by
  this one — do not edit it. (Flagged here so the reviewer isn't surprised it still says something
  stale; whoever next picks up that blocked ticket will find `docs/releasing.md` already corrected.)
- **`scripts/test-typecheck-allowlist.json` going to `{}`**: confirm `check-test-file-typecheck-coverage.mjs`
  (and its test) accept an empty allowlist object rather than assuming at least one entry — read the
  script before assuming.
- **`yarn workspaces foreach -A run <script>` commands** (`build`, `test`, `typecheck`, `clean`) all
  discover workspaces by glob — no explicit list to edit, but they will simply stop touching
  `packages/strand-proto` once it's gone. Nothing to do here beyond confirming the commands still run
  clean.
- **`../optimystic` and `../quereus` linked workspaces** (via root `resolutions`) don't reference
  `strand-proto` — confirmed by the grep in the plan ticket; no cross-repo edit needed.
- **npm-side deprecation of the already-published 0.9.0**: out of scope for this ticket. It requires
  npm publish credentials this agent doesn't have, and the plan ticket's decision only calls for
  removing it from *this repo's* build/release/repository, not for touching what's already on the
  registry.

## TODO

- Delete `packages/strand-proto/` entirely.
- Remove it from the root `package.json` publish chain (`pub` script and `pub:strand-proto` script).
- Remove its eslint ignore entry (`eslint.config.mjs`).
- Remove its knip config block and fix the dangling comment reference (`knip.ts`).
- Remove its entry from `scripts/test-typecheck-allowlist.json`.
- Update `AGENTS.md` repo orientation to drop the `strand-proto` mention.
- Delete `docs/strand-proto.md`.
- Fix the five `docs/architecture.md` spots (two reference-list removals, two prose rewrites at lines
  518 and 1418, one bullet removal at 1398).
- Fix `docs/strands.md`'s History section to drop the dangling path.
- Fix `docs/reference-app-rn.md:633`'s stale "dials via strand-proto" wording.
- Remove the `@serfab/strand-proto` row from `README.md`'s package table.
- Remove the stale "Current: strand-proto/" bullet from `packages/README.md`.
- Fix the three `strand-proto` mentions and two workspace-count mentions in `docs/testing.md`.
- Rework `docs/releasing.md` per the itemized edits above (overview counts, individual-publish block,
  prerelease chain-length mention, recommendation line, the "five, not six" subsection, runbook step
  6).
- Run `yarn lint`, `yarn build`, `yarn typecheck`, and at least `yarn test:test-file-typecheck-coverage`
  + `yarn test:vitest-typecheck-coverage` to confirm the carve-out removals don't break the coverage
  gates. Full `yarn test` / `yarn smoke:published` are release-time gates already documented as
  needing the network and real time — run them if practical inside the runner's time budget, otherwise
  note in the handoff which were skipped and why.
