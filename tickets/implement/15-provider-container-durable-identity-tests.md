---
description: The fix that lets a hosted customer node keep one network identity across restarts is written and working; the automated tests and docs for it are now drafted, but nobody has confirmed they actually pass yet.
files: packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/test/entrypoint.spec.ts (new, written), packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/fake-docker.ts, packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts (new, written), packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts (new, written), docs/architecture.md (edited), docs/STATUS.md (edited)
difficulty: easy
---

<!-- resume-note -->
Prior run hit the session's soft token budget partway through **implement**, right
after writing all deliverables but **before running anything to verify them**. All
four deliverables from the previous resume-note are now written to disk exactly as
drafted there (that draft was hand-verified against the landed source in two prior
runs). This run additionally re-verified every claim in that draft against a fresh
read of the actual landed files (`docker-orchestrator.ts`, `container-service.ts`,
`fake-docker.ts`, `entrypoint.sh`, `types.ts`, `orchestrator.ts`, `container-health.ts`,
`config/types.ts`, `store.ts`, plus the three reference test files) — everything
matched, no drift. **Nothing here changes runtime behaviour** — this ticket is pure
test + docs.

## What is now on disk (written this run, not yet executed)

1. `packages/cadre-cli/test/entrypoint.spec.ts` — NEW. Runs `docker/entrypoint.sh`
   under real `sh` against a fake `node` stub, gated on `sh` being runnable
   (`describe.skipIf(!shAvailable())`). Two tests: identity created before config +
   exported to child + recorded in `cadre.yaml`; identity byte-identical across a
   second start. **Never executed — the ticket that drafted it flagged Windows
   Git-Bash shell quoting as the main risk.** Start here.

2. `packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts`
   — NEW, 7 tests covering `ensureVolume`/`createContainer`/`removeContainer` volume
   wiring (fresh volume created+labelled, pre-existing volume reused, volume cleanup
   on create-failure only when this attempt created it, pre-existing volume left
   alone on a failed recreate, `removeContainer` reads `Mounts` via inspect then
   force-removes then removes the named volume, missing-volume termination is clean,
   legacy container with no matching label/mount removes nothing). **Not yet run.**
   One TypeScript issue was found and fixed while writing it: the first test's
   `createContainer` mock originally had an untyped zero-arg implementation, which
   made `.mock.calls[0]![0]` fail to typecheck (`Tuple type '[]' of length '0' has no
   element at index '0'`) — fixed by giving the mock's implementation an explicit
   parameter type (same pattern as `docker-orchestrator-push.test.ts`'s
   `captureDocker()`). No other files were touched to fix this — verify no similar
   issue exists in the other new test file or entrypoint.spec.ts when you typecheck.

3. `packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts`
   — NEW, 3 tests on `ContainerService.provisionContainer`'s peerId recording via
   `waitForEnrollment` (peerId stamped + status running when `/status` reports
   healthy+peerId; peerId left unset when peerId is `null`; polls the derived
   `/status` URL not `/health`). **Not yet run.**

4. `docs/architecture.md` — edited. Inserted a paragraph into the "Cold-start
   bootstrap retries" bullet (under "Control Network Seed"), between "...both
   stores silently in-memory." and "Load policy matches the anchor's:", describing
   the Docker provider's per-container named-volume durability (volume name,
   `create_identity` ordering, env-export/`applyEnvironmentOverrides` mechanism,
   volume deletion on `removeContainer`). Already landed, not reverted.

5. `docs/STATUS.md` — edited. Under "Cadre-host node-donation realignment", the
   "Donated nodes hold a durable identity" bullet's closing sentence now says the
   multi-tenant-provider gap has been closed (was: "is open", pointing at the old
   backlog ticket) and links to `architecture.md#provider-integration` and
   `architecture.md#control-network-seed`. Already landed, not reverted.
   **UNVERIFIED: whether `#provider-integration` and `#control-network-seed` are
   real heading anchors in `docs/architecture.md`.** A grep for
   `^#+ Provider Integration|^#+ Control Network Seed` was mid-flight when the
   budget warning landed and never returned a result. Check this first — if
   `Provider Integration` isn't a literal heading, find the actual heading text
   that covers `DockerOrchestrator`/provider config (search `architecture.md` for
   "DockerOrchestrator" or "cadre-provider") and fix the markdown link fragment
   (GitHub/most renderers slugify headings as lowercase-hyphenated, e.g. `## Provider
   Integration` → `#provider-integration`) to point at whatever heading actually
   exists, or drop the link if there is no single heading and just reference the
   section prose.

## What is NOT done — do this next, in order

1. **Fix the STATUS.md anchor links** (see item 5 above) if they don't resolve.
2. `yarn workspace @serfab/cadre-provider test` (or `cd packages/cadre-provider &&
   yarn test`) — expect the prior ~97 passing tests plus the ~10 new ones across
   the two new files, all green. Fix any real failures; if a failure is clearly
   pre-existing/unrelated, follow the "Pre-existing test failures" protocol in the
   top-level ticket rules (check `tickets/.pre-existing-known.md` first) rather than
   silencing it.
3. `yarn workspace @serfab/cadre-cli test` — expect `entrypoint.spec.ts` to either
   run and pass, or skip cleanly if `sh` is unavailable in this environment. If it
   runs and fails, the failure is almost certainly shell-quoting in the test's
   `NODE_STUB` / `runEntrypointStart` harness (Windows Git Bash/MSYS is finicky
   about path translation and heredoc-style `case` blocks written from a JS
   template string) — the underlying `entrypoint.sh` behavior itself is already
   correct and hand-verified (see git history at `f01e715` / `366c246`), so iterate
   on the test harness, not the script under test.
4. `yarn typecheck` in `packages/cadre-provider` and in `packages/cadre-cli`.
5. Once everything above is green, write the `review/` handoff ticket per the
   standard implement→review contract (distilled summary, use cases for testing,
   known gaps — e.g. the entrypoint test's Windows-shell fragility if it turns out
   to be flaky, and that seed *trust* remains out of scope, tracked separately as
   `provider-owner-key-pinning`) and delete this ticket file.

## Out of scope (carried over, unchanged)

Seed *trust* is a separate defect with its own ticket (`provider-owner-key-pinning`)
— a provider container still rejects every seed regardless of this work. Do not
conflate them.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
