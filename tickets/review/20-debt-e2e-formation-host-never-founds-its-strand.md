description: The browser end-to-end test's stand-in second party now sets up its invitation-only chat network with the same single call the real app uses, and the comments that wrongly said the network was never properly set up are gone.
files: packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/e2e/distributed/formation-convergence.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/cadre-core/src/cadre-node.ts
difficulty: easy
----

# Web e2e host fixture founds its strand with `foundStrand`

`packages/reference-app-web/e2e/fixtures/formation-responder.ts` boots an out-of-browser `CadreNode` that hosts a closed (invitation-only) chat strand for the browser under test to join. It used to call `publishStrand` and then `addStrand` with a hand-built row carrying `FounderOwnerKey: null`. That launched the strand as a joiner, and the node's own strand watcher founded it about 160 ms later (measured by the plan stage); `addStrand` only resolved once that happened. The end state was a founded strand, but the comments at the site said it was not.

## What changed

Only `formation-responder.ts`:

- `startFormationResponder` now makes one `node.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: getChatSAppConfig() })` call, the same call `createClosedChatStrand` in `packages/reference-app-web/src/lib/cadre-web.ts` makes. The strand is founded at launch, with no dependence on a watcher poll.
- It throws if the returned `founded` is false (the fixture must be the founder). This cannot happen with a fresh UUID on a fresh in-memory node; the check exists so a future change that breaks it fails the boot.
- The returned `instance` replaces the `node.getStrand(strandId)` lookup. The `libp2pNode` presence check stays, with its message now naming `foundStrand`.
- Comments: the wrong `NOTE:` block and the comment inside the old `addStrand` argument are deleted and replaced with a two-line comment; step 4 of the function's doc comment names `foundStrand`; the `hostUnclaimedStrands: false` comment in `buildResponderConfig` now names `foundStrand`'s publish and attach halves.

`packages/reference-app-web/README.md` (the fixture description near line 331) does not describe the two-step setup, so it is unchanged. No change to the spec, `cadre-web.ts`, or cadre-core.

## Validation run

From `packages/reference-app-web`:

- `yarn typecheck:e2e` — clean.
- `yarn playwright test e2e/distributed` — `2 passed (26.6s)`: the happy path (redeem, closed strand forms, responder seed converges to the browser) and the expired-invitation rejection. Log: `tickets/.logs/debt-e2e-formation-host-never-founds-its-strand.test.log`.

From the repo root: `yarn lint` — exit 0.

Not run: the tier 1 (solo) Playwright specs and the vitest suites. None of them import this fixture.

## Tests

None added. The existing distributed spec exercises the fixture, and the `founded` check is an assertion at the call site.

## For the reviewer

- The spec's `beforeAll` turns a responder boot failure into a skip, so a broken fixture shows as two skipped tests with a zero exit code. When re-running, read the summary for `2 passed`.
- The watcher-poll-between-publish-and-attach ordering (the reason `hostUnclaimedStrands: false` stays) was checked by reading `foundStrand` / `launchStrand` in `packages/cadre-core/src/cadre-node.ts` at the plan stage, not by a test that forces the ordering.
- I did not re-capture a `DEBUG='sereus:cadre*'` log to confirm the founder bootstrap lines now appear at launch rather than from the watcher; the evidence is the `founded === true` check passing (boot would otherwise throw and the tests would skip) plus the passing run.
