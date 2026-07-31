---
description: Tests and docs for the fix that lets a hosted customer node keep the same network identity across restarts are written and now confirmed passing — ready for review.
files: packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/test/entrypoint.spec.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/fake-docker.ts, packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts, packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts, docs/architecture.md, docs/STATUS.md
---

## Summary

Runtime fix (identity created before config, exported to child process, persisted
via a per-container named Docker volume) landed in prior tickets (`f01e715`,
`366c246`). This ticket added the missing test coverage and docs for that fix.
**No runtime code changed in this ticket** — pure test + docs addition.

## What was added

1. `packages/cadre-cli/test/entrypoint.spec.ts` — runs `docker/entrypoint.sh`
   under real `sh` against a fake `node` stub. 2 tests:
   - identity created before config, exported to child, recorded in `cadre.yaml`
   - identity byte-identical across a second start (durability)
   Gated with `describe.skipIf(!shAvailable())` so it degrades cleanly where `sh`
   is unavailable.

2. `packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts`
   — 7 tests on `ensureVolume`/`createContainer`/`removeContainer` volume wiring:
   fresh volume created + labelled, pre-existing volume reused, volume cleanup on
   create-failure (only when this attempt created it), pre-existing volume left
   alone on a failed recreate, `removeContainer` reads `Mounts` via inspect then
   force-removes container then removes the named volume, missing-volume
   termination is clean, legacy container with no matching label/mount removes
   nothing.

3. `packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts`
   — 3 tests on `ContainerService.provisionContainer`'s peerId recording via
   `waitForEnrollment`: peerId stamped + status set to running when `/status`
   reports healthy+peerId; peerId left unset when peerId is `null`; polls the
   derived `/status` URL, not `/health`.

4. `docs/architecture.md` — paragraph added under "Cold-start bootstrap retries"
   (Control Network Seed section) describing the Docker provider's per-container
   named-volume durability mechanism.

5. `docs/STATUS.md` — "Donated nodes hold a durable identity" bullet updated to
   say the multi-tenant-provider gap is closed, linking to
   `architecture.md#provider-integration` and
   `architecture.md#control-network-seed`.

## Verification performed this run

- `yarn workspace @serfab/cadre-provider test` — **107/107 pass** (17 files,
  includes the 10 new tests across the two new files above).
- `yarn workspace @serfab/cadre-cli test` — **157/157 pass** (13 files). Ran
  `entrypoint.spec.ts` in isolation with `--reporter=verbose` to confirm both
  tests actually executed (not silently skipped) in this environment — `sh` was
  available and both passed.
- `yarn typecheck` in both `packages/cadre-provider` and `packages/cadre-cli` —
  clean, exit 0.
- `yarn eslint` on all three new test files — clean, no output.
- Verified `#provider-integration` (`docs/architecture.md:705`, `##`) and
  `#control-network-seed` (`docs/architecture.md:154`, `###`) are real headings —
  the STATUS.md links resolve correctly. (A prior resume-note flagged this as
  unverified; now confirmed fine, no edit needed.)

## Known gaps / flag for reviewer

- `entrypoint.spec.ts` depends on a POSIX `sh` being on `PATH` (gated via
  `skipIf`). Verified it runs (not skipped) on this Windows Git-Bash-backed dev
  environment. Not verified against a CI runner or a plain Windows shell with no
  `sh` — if CI lacks `sh`, this suite will skip silently rather than fail, so
  coverage there is conditional. Worth a quick check of what shell CI actually
  uses.
- No new test asserts volume behavior when Docker itself returns a malformed
  `Mounts` array (only the "no matching mount" case is covered) — edge case, not
  exercised.
- Seed *trust* remains explicitly out of scope: a provider container still
  accepts/rejects seeds without owner-key pinning, tracked separately as
  `provider-owner-key-pinning`. Do not conflate with this durable-identity work.

## Review findings

(none yet — pending review)
