description: A strand's storage folder is named after an identifier another participant chose, and nothing checked that identifier was a sane folder name. It is checked now, and a node that meets a bad one refuses the strand quietly instead of retrying forever.
architecture: docs/architecture.md#storage-scope-keys
files:
  - packages/cadre-core/src/storage-scope.ts (new: `isValidStrandScopeKey`, `assertStrandScopeKey`, `assertScopeKeyCharset`, `InvalidStrandIdError`)
  - packages/cadre-core/src/strand-id.ts (new; the only two places cadre-core mints a strand id)
  - packages/cadre-core/src/strand-instance-manager.ts (`startStrand` ~492, `resolveStrandStorage` doc ~312)
  - packages/cadre-core/src/cadre-node.ts (`handleStrandAdded` ~4091, `addStrand` ~4583, `resolveControlStorage` ~1565, `controlNetworkName` ~1447)
  - packages/cadre-core/src/strand-watcher.ts (`suppressStrand` doc)
  - packages/cadre-core/src/strand-formation-manager.ts, strand-solicitation.ts, control-formation-recorder.ts (the three former mint sites)
  - packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/README.md, docs/architecture.md
  - packages/cadre-core/test/strand-scope-key-validation.spec.ts (new), packages/cadre-core/test/cadre-node-strand-added-failure.spec.ts
repro: verified
----

# Validate the strand id before it becomes a name

## What shipped

A strand's storage scope key is its strand id, used verbatim, and a strand row can arrive from another node in the party by replication. Every embedder turns that key straight into a real name (cadre-cli a directory under its storage path, the phone apps a LevelDB filename, the browser an IndexedDB database name), and `buildStrandRuntime` turns the same id into the libp2p protocol prefix `/optimystic/strand-<id>`. Nothing checked its shape. Now something does.

**The rule** lives in `storage-scope.ts` as `isValidStrandScopeKey`: non-empty, at most 128 characters, within `[A-Za-z0-9._-]`, not `.` or `..`, and not `control-`-prefixed. `assertStrandScopeKey` is the same rule as an assertion, throwing the new `InvalidStrandIdError` (carries `strandId`; the message states the rule and why it exists). All three are exported from `index.ts`.

**Three enforcement points**, each for a different reason:

- `StrandInstanceManager.startStrand`, unconditionally at the top, beside `assertSchemaSignature`. This is the guarantee: every strand launch passes here, with or without a storage provider, so it covers both the scope key and the protocol prefix. Deliberately NOT in `resolveStrandStorage`, which returns early when no provider is configured — a node with no storage still builds a protocol prefix from the id. A comment at each site says so.
- `CadreNode.handleStrandAdded`, first thing, **above** the no-sAppConfig branch — so a hostile id is never offered to the hosting app as a strand it could join. Emits `strand:error`, calls `strandWatcher.suppressStrand(id)`, then throws. The throw still matters: the watcher's catch runs `forgetStrand`, dropping the id from `knownStrands`, so its removed-strand loop never detaches a strand that never ran.
- `CadreNode.addStrand`, before `sAppConfigs.set` and `unsuppressStrand`, so an unusable id leaves no registered config behind and does not lift a suppression this node set deliberately.

**No infinite retry.** Before this, a permanently-invalid id would have gone watcher poll → `handleStrandAdded` → throw → `forgetStrand` → `recordFailure`, re-attempting and re-emitting `strand:error` every five minutes (`MAX_RETRY_BACKOFF_MS`) for the life of the process. `suppressStrand` is checked before `knownStrands` in `poll()`, so the strand is simply never offered again this session. Its doc comment now names both callers.

**Minting is centralized.** New `strand-id.ts` holds `mintStrandId()` (`strand-` plus 32 hex characters from the cross-platform CSPRNG — the recorder's deliberately unguessable form) and `mintPlaceholderStrandId()` (`strand-<ms>-<6 base36>` — the two no-network fallbacks, which held the identical expression twice). Both assert the predicate on the way out, so conformance holds by construction. `strand-formation-manager.ts`, `strand-solicitation.ts` and `control-formation-recorder.ts` now call these.

**A fourth, weaker assertion** sits at `CadreNode.resolveControlStorage`: `assertScopeKeyCharset(scope)`, the charset half alone (the strand rule rejects the `control-` prefix by design). It holds by construction today — base64url is inside the charset — so it guards a future edit to `controlStorageScope`, not a reachable input. See *Known gaps* below.

**Docs and caveats.** The three "not yet enforced" caveats and their ticket references are gone, replaced with a statement of the rule and where it is enforced: the `storage-scope.ts` module comment and the `isControlStorageScope` doc, the `RawStorageProvider` doc in `types.ts`, and the *Storage scope keys* bullet in `docs/architecture.md`. A fourth, not in the ticket's list, was in `packages/cadre-core/README.md` ("Caveat, until `bug-strand-scope-key-charset-unenforced` lands") — also replaced. A grep for the slug and for "not yet enforced" outside `tickets/` and `dist/` now returns nothing.

## Tests

Three behaviours, in two files.

| Test | What it verifies |
|---|---|
| `strand-scope-key-validation.spec.ts` → "refuses a strand whose id is …" (two arms: a path traversal, a `control-` key) | The reproduction, at the lowest layer: `startStrand` rejects with `InvalidStrandIdError`, the recording storage provider is never called, `createLibp2pNode` is never called, and nothing is tracked. Two arms because `control-` is a distinct branch of the predicate, not a second example of the charset one. |
| `strand-scope-key-validation.spec.ts` → the predicate table (2 accept + 8 reject) | `isValidStrandScopeKey`'s real branches: accepts both shapes cadre-core mints (called through `strand-id.ts`, so a generator change that broke conformance fails here too); rejects empty, `../../etc/passwd`, `..`, `.`, a POSIX separator, a Windows separator, a `control-` prefix, and an id over the 128-character cap. |
| `cadre-node-strand-added-failure.spec.ts` → "suppresses a strand whose id is unusable…" | The no-retry behaviour: `handleStrandAdded` with an invalid id emits exactly one `strand:error` carrying `InvalidStrandIdError`, calls `suppressStrand` with that id, emits no `strand:discovered` (the check is above that branch), and rejects. Extends the existing file, which already drives `handleStrandAdded` against a fake strand manager. |

No test for the `resolveControlStorage` assertion: `controlStorageScope` returns base64url by construction, so there is no branch to pin — as the ticket directed.

## Validation run

- `yarn lint` — clean (exit 0).
- `yarn typecheck` — clean, including the vitest/test-file typecheck-coverage and stale-build-guard-wiring checks.
- `yarn build` (all workspaces) — clean.
- `yarn workspace @serfab/cadre-core test` — **137 files, 2256 passed, 1 skipped.** Run twice (before and after a rebuild), identical both times.
- Every other unit workspace (`cadre-cli`, `cadre-host`, `cadre-provider`, `quereus-plugin-sereus`, the three reference apps) — all green.
- `packages/integration-tests` was **not** run: it is the real-multi-party suite, `fileParallelism: false` with a 60 s per-test timeout, past the agent-runnable wall-clock budget, and `tickets/.pre-existing-known.md` documents its standing flakes. Nothing in this diff touches the network or replication paths those scenarios exercise, but a reviewer wanting the extra confidence should run it out-of-band.

Two transients during validation, both resolved and neither a finding. The first `yarn build` failed in `@serfab/quereus-plugin-sereus` with `TS7016: Could not find a declaration file for '@optimystic/quereus-plugin-crypto/plugin'`. That package is the linked `../optimystic` workspace, untouched by this diff; its `dist/plugin.d.ts` was mid-rebuild. The next `yarn build` was clean. Separately, a parallel `yarn workspaces foreach … run test` reported "Stale build detected" from `quereus-plugin-sereus`; run on its own it was green (113 passed). Nothing was written to `tickets/.pre-existing-error.md`.

## Known gaps and judgment calls — read these first

- **The 128-character cap is the one invented number.** The ticket flagged it as a judgment call and asked me to say so. Measured: the longest id cadre-core mints is 39 characters (`strand-` plus the 32 hex characters of `randomBytes(128, 'hex')` — 128 *bits*, i.e. 16 bytes). 128 leaves wide headroom while keeping a key clear of the 255-*byte* single-path-component limit every mainstream filesystem enforces; the charset is ASCII, so characters and bytes match. But nothing measures a real limit at 128 — it is a round number between "far above anything we mint" and "far below where filesystems complain". Cut it if you disagree; `isValidStrandScopeKey` is the only place it is used.
- **`assertScopeKeyCharset` cannot fail on any reachable input today, by design.** It exists so the control seam asserts something, matching the strand seam. It is exported from `storage-scope.ts` (`cadre-node.ts` imports it) but deliberately **not** from `index.ts`, and it has no test. If you would rather the control key's guarantee rest on `controlStorageScope`'s base64url alone, delete the function and its one call site; nothing else changes.
- **`publishStrand` does not validate, and probably should.** An embedder calling `node.publishStrand('../evil')` — or `foundStrand`, which is `publishStrand` plus `addStrand` — writes the row to the control database first and only fails at `addStrand`, so a nonconforming id replicates to the whole party before anyone refuses it, and every node including the publisher then declines to launch it. This is **not a regression**: the row replicated just the same before this change. It is outside the ticket's enumerated sites, so I did not widen the diff — but `publishStrand` already trims and rejects a blank id, and adding `assertStrandScopeKey(trimmed)` beside that check looks like a one-line strict improvement. Your call; it needs a cadre-core suite re-run if taken.
- **Tripwire parked, not filed:** `CadreNode.controlNetworkName` builds a libp2p protocol prefix from `control-` plus the party id **unencoded**, unlike the storage scope key. Safe today — a party id is locally configured rather than replicated in, and both ends of a connection derive the string identically, so an odd party id yields an odd but consistent protocol id. Recorded as a `NOTE:` at that method (`cadre-node.ts` ~1447) with the condition that would make it real work: a party id ever arriving from the network. Per the ticket's sweep, `delegate-admission.ts` ~79 (a map key joining peer id and strand id with a newline) needs nothing — peer ids are base58 and the charset rule closes it regardless.
- **Existing test-tree strand ids were swept** for literals outside `[A-Za-z0-9._-]`. Two turned up and neither touches a launch path: `packages/cadre-cli/test/admin-server.spec.ts` pushes `'ns/strand'` onto a fake node's row list (the admin server's unpublish path — never launched), and `packages/cadre-core/test/publish-strand.spec.ts` passes `'   '` to `foundStrand` expecting the pre-existing blank-id rejection. Both still pass.

## Where to poke

- `startStrand` is the load-bearing site. If the assertion were moved into `resolveStrandStorage` (the intuitive place), a node configured with no storage provider would slip through and still build `/optimystic/strand-<id>` from an unchecked string. The comments at both sites say this; check they would actually survive an edit.
- `handleStrandAdded` orders the check above the discovery branch on purpose. Moving it below re-opens the path where a hostile id is surfaced to the hosting app as joinable.
- `suppressStrand` versus `forgetStrand` is the distinction that stops the five-minute retry loop. A reviewer inclined to "just let the retry ladder handle it" should read the `suppressStrand` doc first.
- `mintPlaceholderStrandId` uses `Math.random`, which is not a CSPRNG; its doc says so. It is only reachable on the two fallback paths where no strand is actually provisioned. If one of those ever becomes a real provisioning path, it wants `mintStrandId` instead.
