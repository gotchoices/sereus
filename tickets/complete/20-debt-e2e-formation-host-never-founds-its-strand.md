description: The browser end-to-end test's stand-in second party now sets up its invitation-only chat network with the same single call the real app uses, and the comments that wrongly said the network was never properly set up are gone.
files: packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/e2e/distributed/formation-convergence.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/cadre-core/src/cadre-node.ts
difficulty: easy
----

# Web e2e host fixture founds its strand with `foundStrand`

`packages/reference-app-web/e2e/fixtures/formation-responder.ts` boots an out-of-browser `CadreNode` that hosts a closed (invitation-only) chat strand for the browser under test to join. It used to call `publishStrand` and then `addStrand` with a hand-built row carrying `FounderOwnerKey: null`, which launched the strand as a joiner and left the founding to the node's own strand watcher a moment later. The comments at the site claimed the strand was never founded, which was false.

## What changed

Only `formation-responder.ts` (commit `ticket(implement): debt-e2e-formation-host-never-founds-its-strand`):

- `startFormationResponder` makes one `node.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: getChatSAppConfig() })` call, the same call `createClosedChatStrand` in `packages/reference-app-web/src/lib/cadre-web.ts` makes. The strand is founded at launch, with no dependence on a watcher poll.
- It throws if the returned `founded` is false, and uses the returned `instance` instead of a `node.getStrand(strandId)` lookup.
- The wrong `NOTE:` block and the comment inside the old `addStrand` argument are replaced by a two-line comment; step 4 of the function's doc comment and the `hostUnclaimedStrands: false` comment in `buildResponderConfig` now name `foundStrand`.

## Review findings

**Checked**

- The implement diff, read before the handoff: 16 lines added, 26 removed, one file. The new call matches `createClosedChatStrand` argument for argument (`strandId`, `type: 'c'`, a freshly minted member key, the shared signed config). The fixture has no `openStores` call where the app does; that is correct, because the fixture's storage provider is an in-memory factory and the app's is a pre-opened IndexedDB store.
- `foundStrand` in `packages/cadre-core/src/cadre-node.ts`: on a fresh id it publishes the row under this node's owner key, derives `founded` from that row, and passes `founder: founded` to `addStrand`. `founded` is therefore true on the fixture's path, and the throw is reachable only if a row with that id already exists under another machine's key.
- The reworded `hostUnclaimedStrands: false` comment against the code: the watcher skips an unclaimed strand only when that flag is false or a config is already registered (the `!this.hostUnclaimedStrands || this.sAppConfigs.has(strand.Id)` test), and `launchStrand`'s doc comment names "a `foundStrand` whose publish a watcher poll saw before its attach" as a replica launch. The comment is accurate. The flag's default for `profile: 'storage'` is true, so the explicit `false` is still needed.
- Error paths and cleanup: both new throws sit inside the existing `try`, so the `catch` stops the node before rethrowing. `stop` removes the listener from the same libp2p node it was added to.
- Type safety: `strand` is a non-optional `StrandInstance` from the result, so the dropped `?.` is right; `yarn typecheck:e2e` exits 0.
- Docs: `packages/reference-app-web/README.md` (the tier 2 paragraph near line 331) describes the fixture without naming the setup calls, so it needed no change. A search of `docs/`, package READMEs and the open ticket folders for the fixture's name found no other description of it. The file's header comment does not mention the two-step setup.
- Open tickets: nothing in `backlog/`, `fix/`, `plan/` or `implement/` references this fixture.

**Validation run in this pass**

- From `packages/reference-app-web`: `yarn typecheck:e2e` exit 0; `yarn playwright test e2e/distributed` reported `2 passed (29.5s)` (both tests `ok`, none skipped). Log: `tickets/.logs/debt-e2e-formation-host-never-founds-its-strand.review.log`.
- From the repo root: `yarn lint` exit 0.
- Not run: the tier 1 (solo) Playwright specs and the vitest suites. None import this fixture.

**Found**

- Minor: none. No edits were made in this pass.
- Major: none.
- Tests: none added and none cut. The change added no tests; the existing distributed spec exercises the fixture end to end, and the `founded` check is an assertion at the call site.
- Tripwires: none new. The one conditional concern in the area (a boot failure shows as two skipped tests with a zero exit code, because the spec's `beforeAll` converts it to a skip) is existing, documented behaviour in the README's tier 2 paragraph ("The tier self-skips if the responder cannot boot"), so it is not repeated at the site.

**Not verified**

- The ordering where a watcher poll lands between `foundStrand`'s publish and attach was checked by reading the code, not forced in a test.
- No `DEBUG='sereus:cadre*'` log was captured to show the founder bootstrap lines at launch. The evidence that the fixture founds directly is the `founded` check passing: a false value throws, the boot fails, and both tests would show as skipped rather than passed.
