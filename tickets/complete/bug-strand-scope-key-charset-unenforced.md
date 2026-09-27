description: A strand's storage folder is named after an identifier another participant chose, and nothing checked that identifier was a sane folder name. It is checked now, at every point where such an identifier enters this node, and a node that meets a bad one refuses the strand quietly instead of retrying forever.
architecture: docs/architecture.md#storage-scope-keys
files:
  - packages/cadre-core/src/storage-scope.ts (`isValidStrandScopeKey`, `assertStrandScopeKey`, `assertScopeKeyCharset`, `InvalidStrandIdError`)
  - packages/cadre-core/src/strand-id.ts (the only two places cadre-core mints a strand id)
  - packages/cadre-core/src/strand-instance-manager.ts (`startStrand`), packages/cadre-core/src/cadre-node.ts (`handleStrandAdded`, `addStrand`, `publishStrand`, `resolveControlStorage`, `controlNetworkName`)
  - packages/cadre-core/src/strand-watcher.ts, strand-formation-manager.ts, strand-solicitation.ts, control-formation-recorder.ts
  - packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/README.md, docs/architecture.md
  - packages/cadre-core/test/strand-scope-key-validation.spec.ts, cadre-node-strand-added-failure.spec.ts, publish-strand.spec.ts
repro: verified
----

# Validate the strand id before it becomes a name

## What shipped

A strand's storage scope key is its strand id, used verbatim, and a strand row can arrive from another node in the party by replication. Every embedder turns that key straight into a real name (cadre-cli a directory under its storage path, the phone apps a LevelDB filename, the browser an IndexedDB database name), and `buildStrandRuntime` turns the same id into the libp2p protocol prefix `/optimystic/strand-<id>`. Nothing checked its shape. Now something does.

**The rule** lives in `storage-scope.ts` as `isValidStrandScopeKey`: non-empty, at most 128 characters, within `[A-Za-z0-9._-]`, not `.` or `..`, and not `control-`-prefixed. `assertStrandScopeKey` is the same rule as an assertion, throwing the new `InvalidStrandIdError` (carries `strandId`; the message states the rule and why it exists). All three are exported from `index.ts`.

**Four enforcement points**, each for a different reason:

- `StrandInstanceManager.startStrand`, unconditionally at the top, beside `assertSchemaSignature`. This is the guarantee: every strand launch passes here, with or without a storage provider, so it covers both the scope key and the protocol prefix. Deliberately NOT in `resolveStrandStorage`, which returns early when no provider is configured — a node with no storage still builds a protocol prefix from the id. A comment at each site says so.
- `CadreNode.handleStrandAdded`, first thing, **above** the no-sAppConfig branch — so a hostile id is never offered to the hosting app as a strand it could join. Emits `strand:error`, calls `strandWatcher.suppressStrand(id)`, then throws. The throw still matters: the watcher's catch runs `forgetStrand`, dropping the id from `knownStrands`, so its removed-strand loop never detaches a strand that never ran.
- `CadreNode.addStrand`, before `sAppConfigs.set` and `unsuppressStrand`, so an unusable id leaves no registered config behind and does not lift a suppression this node set deliberately.
- `CadreNode.publishStrand`, right after the existing blank-id trim (**added in review** — see findings). A published row replicates to the whole party, so without this one node can write an id that every member, including the publisher, then declines to launch.

**No infinite retry.** Before this, a permanently-invalid id would have gone watcher poll → `handleStrandAdded` → throw → `forgetStrand` → `recordFailure`, re-attempting and re-emitting `strand:error` every five minutes (`MAX_RETRY_BACKOFF_MS`) for the life of the process. `suppressStrand` is checked before `knownStrands` in `poll()`, so the strand is simply never offered again this session. Its doc comment now names both callers.

**Minting is centralized.** New `strand-id.ts` holds `mintStrandId()` (`strand-` plus 32 hex characters from the cross-platform CSPRNG — the recorder's deliberately unguessable form) and `mintPlaceholderStrandId()` (`strand-<ms>-<6 base36>` — the two no-network fallbacks, which held the identical expression twice). Both assert the predicate on the way out, so conformance holds by construction. `strand-formation-manager.ts`, `strand-solicitation.ts` and `control-formation-recorder.ts` now call these.

**A fifth, weaker assertion** sits at `CadreNode.resolveControlStorage`: `assertScopeKeyCharset(scope)`, the charset half alone (the strand rule rejects the `control-` prefix by design). It holds by construction today — base64url is inside the charset — so it guards a future edit to `controlStorageScope`, not a reachable input.

**Docs.** The "not yet enforced" caveats and their ticket references are gone from the `storage-scope.ts` module comment, the `isControlStorageScope` doc, the `RawStorageProvider` doc in `types.ts`, the *Storage scope keys* bullet in `docs/architecture.md` and `packages/cadre-core/README.md`, replaced with a statement of the rule and where it is enforced. A grep for the slug and for "not yet enforced" outside `tickets/` and `dist/` returns nothing.

**Tripwire parked by the implement pass:** `CadreNode.controlNetworkName` builds a libp2p protocol prefix from `control-` plus the party id **unencoded**, unlike the storage scope key. Safe today — a party id is locally configured rather than replicated in, and both ends of a connection derive the string identically. Recorded as a `NOTE:` at that method with the condition that would make it real work: a party id ever arriving from the network.

## Review findings

### Read first, handoff second

The implement diff (`7a365e79`) was read before the handoff summary, and every load-bearing claim in that summary was traced rather than taken:

- **Enforcement placement.** `startStrand`'s assertion sits after the already-running early return, which is only reachable by an id that passed on its first launch — correct. `handleStrandAdded`'s check is above the discovery branch, so a hostile id is never surfaced as joinable. `addStrand`'s is above `sAppConfigs.set` and `unsuppressStrand`.
- **The no-retry claim.** Traced through `StrandWatcher.poll()`: the suppression set is consulted before both `knownStrands` and the backoff gate, and the loop that clears suppressions only fires for ids whose control row has disappeared — which an invalid but present row has not. The claim holds.
- **The 128-character cap.** `randomBytes(128, 'hex')` takes **bits**, confirmed in the linked `quereus-plugin-crypto` source, so the longest minted id is 39 characters. The handoff's arithmetic is right and the cap has the headroom it claims.
- **Every other place a strand id becomes a name.** `getStrandStoragePath` is deprecated, sanitizes on its own and has no live callers. All four embedder providers build their name *inside* the provider callback, which only runs after `startStrand` has asserted. The one exception — `reference-app-web` pre-opens an IndexedDB store from a formation-supplied strand id before calling `addStrand` — cannot escape anything, because IndexedDB accepts any string as a database name.
- **Nothing existing breaks.** Swept every strand id reaching `publishStrand`/`foundStrand`/`addStrand` across packages: cadre-core mints lowercase hex, the web app uses `crypto.randomUUID()`, the phone app lowercase hex, and every unit and integration test id is within the charset.
- **Docs.** Grepped the tree for the ticket slug and for "not yet enforced": clean. `docs/strands.md` makes no charset claim and needed no edit.

### Fixed in this pass

- **`publishStrand` did not validate.** The handoff named this and left the decision to review; taking it. An embedder calling `publishStrand('../evil')` wrote the row to the control database and only failed later at `addStrand` — by which point the id had replicated to the whole party and every member, publisher included, would decline to launch it. Added `assertStrandScopeKey(trimmed)` immediately after the existing blank-id trim (after, so the id checked is the id stored), updated the method's `@throws` and the README clause, and widened the existing `publish-strand.spec.ts` test "rejects an id it could not use as a name, before any write" to cover it alongside the blank cases. Not a new test: one assertion on the test that already pins this method's pre-write refusals.
- **A test row was checking the wrong thing.** `strand-scope-key-validation.spec.ts` listed `['a Windows separator', 'strand\nested']`, which in TypeScript is a newline escape, not a backslash. It passed — a newline is outside the charset — but for the wrong reason, leaving the Windows separator itself untested. Now `'strand\\nested'`.

### Filed

- `tickets/backlog/bug-scope-keys-collide-on-case-insensitive-filesystems` — **the one major finding.** The new rule asks whether a key is *usable* as a name; it cannot ask whether a key is *distinct* as a name, and no per-key predicate can. Windows and macOS compare filenames without regard to case while the control database and the in-memory strand maps compare with it, so two keys differing only in capitalization are two things everywhere except on disk. Measured here on Windows 11: with `strand-abc` present, creating `STRAND-ABC` fails `EEXIST`. Both arms are affected — a strand id goes into the name verbatim, and the control key's base64url is case-significant (two party ids encoding to `IMKA` and `IMKa` found by search), which defeats the per-party control-store isolation that encoding exists to provide. Filed rather than fixed because closing it means either narrowing the published character set or changing how keys are spelled on disk, both of which are a maintainer's call. Filed at the class level, not as the strand instance, per *Architecture first*; the site-claim grep found no other open ticket touching `storage-scope.ts`.

### Considered and not acted on

- **Windows reserved device names and trailing dots.** `CON`, `NUL`, `aux`, `com1`, `lpt1` and `strand-abc.` are all inside the accepted charset, and all are classic Windows filename hazards — a trailing dot in particular used to alias the undotted name. Measured on Windows 11 before reporting any of it: all five device names created as ordinary folders, and `strand-abc.` did not alias `strand-abc`. Dropped.
- **`assertScopeKeyCharset` is unreachable by construction and untested.** The handoff flagged this and offered to delete it. Kept: four lines, it makes the control seam assert what the strand seam asserts, and its own doc already says it guards a future edit to `controlStorageScope` rather than an input.
- **A very long party id would overflow the filesystem's 255-byte path-component limit,** since `controlStorageScope` bounds nothing and the phone app lets a user type a party id. Not recorded as a tripwire: it fails loudly at store-open rather than silently, it is a pre-existing property of `controlStorageScope` that this diff does not touch, and `storage-scope.ts`'s module comment is already dense enough that one more paragraph would cost more attention than it returns.
- **`cadre-node.ts` is 7386 lines** (this diff adds 40). Already tracked by `backlog/debt-cadre-node-single-file-size`; not re-filed.
- **`mintPlaceholderStrandId` uses `Math.random`.** Documented at the site, reachable only on the two no-network fallbacks where no strand is provisioned. Unchanged.

### Tests

No tests cut: nothing in the new spec restates the implementation or verifies a mock, and the three behaviours it pins (the launch refusal, the predicate's branches, the no-retry suppression) each fail for their own reason. The predicate's two *accept* rows call `mintStrandId()`/`mintPlaceholderStrandId()`, which already assert on the way out, so they cannot fail independently of the mint — kept anyway, because they are the only written record of the accepted shapes and would catch a future tightening of the predicate that rejected a minted id. One assertion added, to the `publishStrand` defect above; no new test file.

### Validation

- `yarn lint` — clean.
- `yarn typecheck` — clean, including the vitest/test-file typecheck-coverage and stale-build-guard-wiring checks.
- `yarn build` (all workspaces) — clean.
- `yarn workspace @serfab/cadre-core test` — 137 files, 2256 passed, 1 skipped.
- `@serfab/cadre-cli` 236 passed, `@serfab/cadre-host` 657 passed / 4 skipped, `@serfab/cadre-provider` 222 passed, `@serfab/quereus-plugin-sereus` 113 passed / 1 todo.
- No pre-existing failures surfaced; nothing written to `tickets/.pre-existing-error.md`.
- `packages/integration-tests` was **not** run, for the reason the implement pass gave: it is the real-multi-party suite, `fileParallelism: false` with a 60 s per-test timeout, past the agent-runnable wall-clock budget, with standing flakes documented in `tickets/.pre-existing-known.md`. Nothing in this ticket's diff touches the network or replication paths those scenarios exercise.
