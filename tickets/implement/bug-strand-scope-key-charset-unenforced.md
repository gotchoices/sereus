description: A strand's storage folder is named after an identifier another participant chose, and nothing checks that identifier is a sane folder name — so a malformed or malicious one could make a node write data outside the folder it was supposed to stay in. Add the check, and make a node that meets such a strand refuse it quietly instead of retrying forever.
architecture: docs/architecture.md#storage-scope-keys
files:
  - packages/cadre-core/src/storage-scope.ts (home of the rule; add the predicate, the assertion and the error here)
  - packages/cadre-core/src/strand-instance-manager.ts (`startStrand` ~505, `resolveStrandStorage` ~320, `buildStrandRuntime` ~573)
  - packages/cadre-core/src/cadre-node.ts (`handleStrandAdded` ~4070, `addStrand` ~4543, `resolveControlStorage` ~1541)
  - packages/cadre-core/src/strand-watcher.ts (`suppressStrand`, `forgetStrand`, `MAX_RETRY_BACKOFF_MS`)
  - packages/cadre-core/src/strand-formation-manager.ts (~602), packages/cadre-core/src/strand-solicitation.ts (~378), packages/cadre-core/src/control-formation-recorder.ts (~292) — the three mint sites
  - packages/cadre-core/src/types.ts (`RawStorageProvider` doc), packages/cadre-core/src/index.ts (~123)
  - docs/architecture.md (*Storage scope keys*, ~1459)
  - packages/cadre-core/test/strand-instance-manager-storage-ownership.spec.ts (the harness the reproduction copies)
difficulty: medium
repro: verified
----

# Validate the strand id before it becomes a name

## What is wrong

An application that embeds cadre-core supplies a storage provider: a function handed a short name for what the data belongs to, which returns a place to keep it. That name is a **scope key**. Every application turns it straight into something real — the command-line tool into a directory under its storage directory, the two phone apps into a database filename, the browser into an IndexedDB database name. None of them escape it, because the contract in `types.ts` and `docs/architecture.md` promises every key contains only letters, digits, dot, underscore and hyphen.

That promise holds for the control database, whose key `controlStorageScope` builds by base64url-encoding the party id. It does not hold for strands: a strand's key is the strand's own id, used verbatim, and a strand row can arrive from another node in the party by replication. Nothing between the replicated row and the provider looks at the id's shape.

## Reproduced

Driven through `StrandInstanceManager.startStrand` against the doubles in `strand-instance-manager-storage-ownership.spec.ts` (libp2p and `StrandDatabase` mocked, so no real node boots), with the strand row's `Id` set by hand:

- `Id: '../../etc/passwd'` — the launch **succeeds** and the recording provider is called with exactly `'../../etc/passwd'`. The command-line tool's provider would build `FileRawStorage('<storage dir>/../../etc/passwd')`.
- `Id: 'control-ZmFrZQ'` — the launch succeeds and `isControlStorageScope` returns true for that strand's key, so the integration harness's `block-store-probe` would file the strand's store as a control database.

## The rule to enforce

A strand scope key is valid when it is non-empty, matches `^[A-Za-z0-9._-]+$`, is neither `.` nor `..`, and does not begin `control-`. Add a length cap of 128 characters as well — the longest id cadre-core mints is 39 characters (measured, see below), and a cap keeps a key from ever approaching the 255-byte filename-component limit that every mainstream filesystem enforces. The cap is the one judgment call here; drop it if it feels like guessing, but say so in the handoff.

## Where the check goes, and where it must not go

**Not inside `resolveStrandStorage` after its `if (!provider) return undefined` early return.** A node configured with no storage provider still reaches `buildStrandRuntime`, which builds `networkName` as `strand-` followed by the strand id, and from it a protocol prefix of `/optimystic/` followed by that name (`strand-instance-manager.ts` ~573). That is a second place a remotely-chosen string becomes a name, and a check that only runs when a provider exists misses it.

The assertion therefore belongs **unconditionally at the top of `StrandInstanceManager.startStrand`**, beside `assertSchemaSignature` — the one place every strand launch passes, storage provider or not, covering both the scope key and the protocol prefix.

Two further guards exist for behaviour rather than for the guarantee, described next.

## What a node does when it meets an unstorable strand

Today the failure path would be: watcher poll → `handleStrandAdded` → `launchStrand` → `startStrand` throws → `strand:error` emitted and rethrown → the watcher's catch calls `forgetStrand` → `recordFailure` schedules a retry on `pollInterval * 2^(failures-1)`, capped by `MAX_RETRY_BACKOFF_MS` at five minutes and **never abandoned**. A permanently-invalid id would therefore re-attempt and re-emit `strand:error` every five minutes for the life of the process.

The watcher already has the right mechanism: `suppressStrand` means "never offer this strand again this session", and its suppression check runs before the `knownStrands` check in `poll()`. So `handleStrandAdded` should validate the id **first — above the no-sAppConfig branch** — and on failure emit `strand:error`, call `strandWatcher.suppressStrand(id)`, and rethrow. Rethrowing still matters: the watcher's catch runs `forgetStrand`, which drops the id from `knownStrands`, so the removed-strand loop never later calls `onStrandRemoved` → `detachStrand` for a strand that never started.

Validating above the no-sAppConfig branch is deliberate. That branch records the row in `discoveredStrands` and emits `strand:discovered`; without the earlier check, a hostile id would be offered to the hosting app as a strand it could join, and the app's `addStrand` would then fail.

`addStrand` needs the same guard at its top, before `sAppConfigs.set` and `unsuppressStrand`. Without it an invalid id leaves a registered sApp config behind and lifts a suppression the node had deliberately set.

`suppressStrand`'s doc comment currently says the suppression records "a deliberate local stop, as opposed to a failed launch". Extend it honestly: it now also records a launch that can never succeed.

## Make the shape unrepresentable where ids are minted

Three sites mint strand ids, and two of them hold the identical expression:

- `strand-formation-manager.ts` ~602 and `strand-solicitation.ts` ~378 — both mint `strand-` plus `Date.now()` plus six base36 characters from `Math.random()`.
- `control-formation-recorder.ts` ~292 — `strand-` plus `randomBytes(128, 'hex')`, whose `128` is **bits**, not bytes: it returns 32 hex characters, so the id is 39 characters long. Measured by calling it; there is no length problem here, and its comment explains why it uses the cross-platform CSPRNG rather than `Date.now`/`Math.random`.

Route all three through one new `strand-id.ts` that imports the predicate from `storage-scope.ts`. Keep both existing shapes — the recorder's unguessable form is deliberate — but mint them in one place, so conformance holds by construction and a future change to a generator cannot quietly emit a shape that only fails later on a peer's disk. This also removes a duplicated expression, which the repo's DRY rule wants anyway.

## Sweep for other remotely-supplied strings that become names

Done; two things found and neither needs its own ticket.

- `delegate-admission.ts` ~79 builds a map key from the peer id and the strand id joined by a newline. No collision is reachable today — peer ids are base58 and never contain a newline — and the charset rule closes it regardless. Nothing to do.
- `control-database.ts` ~503 and `CadreNode.controlNetworkName` build a libp2p protocol prefix from `control-` plus the party id **unencoded**, unlike the storage scope key. This is not the same bug: a party id is locally configured rather than replicated in, and both ends of a connection derive the prefix identically, so an odd party id yields an odd but consistent protocol id. If it bothers the implementer, leave a `NOTE:` tripwire at `controlNetworkName` — do not widen this ticket to change it.

## Expected behaviour once done

- A strand id that is not safe as a path or database-name segment never reaches the embedder's storage provider, and never becomes a libp2p protocol prefix, on any platform.
- A node that meets such a strand emits one `strand:error` naming the id and the rule, does not start the strand, keeps running, and does not re-attempt it.
- The charset statement in `types.ts`, `storage-scope.ts` and `docs/architecture.md` becomes unconditionally true.

## Tests

Three, and no more. The existing test tree was swept for strand-id literals outside `[A-Za-z0-9._-]` and has none, so nothing should start failing.

- The **reproduction**, at the lowest layer that shows it: `startStrand` with `Id: '../../etc/passwd'` rejects and the recording provider is never called. Copy the doubles from `strand-instance-manager-storage-ownership.spec.ts`. Include an arm for an id beginning `control-`, since that is a distinct branch of the predicate rather than a second example of the same one.
- The **predicate's own table**, covering its real branches: accepts an id cadre-core mints; rejects empty, a traversal segment, `..`, a separator, and a `control-` prefix.
- The **no-retry behaviour**: `handleStrandAdded` with an invalid id emits `strand:error` and suppresses the strand in the watcher. `cadre-node-strand-added-failure.spec.ts` already drives `handleStrandAdded` directly against a fake strand manager — extend it there rather than starting a new file.

Do not add a test for the `resolveControlStorage` assertion: `controlStorageScope` returns base64url by construction, so there is no branch to pin.

## TODO

- Add to `storage-scope.ts`: `isValidStrandScopeKey(id: string): boolean`, `assertStrandScopeKey(id: string): void`, and an `InvalidStrandIdError extends Error` carrying the offending id and the rule (the repo's convention is the error class beside its module — see `PreSplitStrandIdentityError`, `StrandAwaitingFirstSyncError`). Export the three from `index.ts` beside `controlStorageScope`.
- Call `assertStrandScopeKey(strandId)` unconditionally at the top of `StrandInstanceManager.startStrand`, before `assertSchemaSignature`. Note in the comment why it is not in `resolveStrandStorage`.
- Assert the same rule for the control key in `CadreNode.resolveControlStorage`, one line, for symmetry at the second seam.
- Validate at the top of `CadreNode.handleStrandAdded`, above the no-sAppConfig branch: emit `strand:error`, `strandWatcher.suppressStrand(id)`, then throw.
- Validate at the top of `CadreNode.addStrand`, before `sAppConfigs.set` and `unsuppressStrand`.
- Extend `StrandWatcher.suppressStrand`'s doc comment to cover a permanently-unlaunchable strand.
- Add `strand-id.ts` with the two mint functions; point `strand-formation-manager.ts`, `strand-solicitation.ts` and `control-formation-recorder.ts` at it.
- Remove the three "not yet enforced" caveats and their ticket references: the `storage-scope.ts` module comment and the `isControlStorageScope` doc, the `RawStorageProvider` doc in `types.ts`, and the *Storage scope keys* bullet in `docs/architecture.md` (~1459). Replace each with a plain statement of the rule and where it is enforced.
- Write the three tests above.
- Run `yarn lint` and the cadre-core suite; report anything that fails.
