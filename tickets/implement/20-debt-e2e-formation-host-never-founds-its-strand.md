description: The browser end-to-end test builds its invitation-only chat network with two hand-written steps and a comment claiming the result is never properly set up; in fact it is set up, by a side route, so switch the test to the single call the real app uses and delete the wrong comment.
files: packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/cadre-core/src/cadre-node.ts, packages/reference-app-web/e2e/distributed/formation-convergence.spec.ts
difficulty: easy
----

# Make the web e2e's host fixture found its strand with `foundStrand`

`packages/reference-app-web/e2e/fixtures/formation-responder.ts` boots an out-of-browser `CadreNode` that hosts a closed (invitation-only) chat strand, so the browser under test has a real second party to redeem an invitation against. The browser app creates the same kind of strand in `createClosedChatStrand` (`packages/reference-app-web/src/lib/cadre-web.ts`) with one `CadreNode.foundStrand` call. The fixture instead calls `publishStrand` and then `addStrand` with a hand-built row carrying `FounderOwnerKey: null`.

## What the plan stage measured (2026-09-30)

The premise this ticket was filed on — that the fixture hosts a closed strand with no `Header`, `Member` or `Manager` row — is no longer true. Two runs of `yarn playwright test e2e/distributed` from `packages/reference-app-web`, unmodified tree:

- Both tests pass (`2 passed (30.2s)`, of which about 12 s is the vite build). The Playwright run is agent-runnable: chromium is installed and the whole command finishes well inside a minute. Log: `tickets/.logs/debt-e2e-formation-host-never-founds-its-strand.baseline.log`.
- With `DEBUG='sereus:cadre*'`, the responder's log shows the sequence: `publishStrand` inserts the row and the party key; `addStrand` launches the strand as a joiner and arms the first-sync gate ("launched as a joiner with no Strand.Header held yet — writes are withheld"); about 160 ms later the node's own strand watcher reads the published control row, whose `FounderOwnerKey` is this node's key, derives founder-ness from it, and runs the founder bootstrap on the already-running instance (`foundExistingStrand` → "Inserted Header", "Inserted founding Member", "Inserted founding Manager", "founder request honored (bootstrapped)"). Only then does the fixture's `addStrand` resolve, because it was waiting on that gate.

So the strand the browser joins is fully founded today. The hand-built `FounderOwnerKey: null` row does not keep it a joiner; it only routes the founding through the watcher instead of through the attach call. The end state matches the app; the path does not, and the two comments at the site (the `NOTE:` block above the `publishStrand` call and the comment inside the `addStrand` argument) state the opposite of what happens.

Consequence for the fixture as written: it depends on the watcher poll arriving to open the gate. If that poll were slow or absent, `addStrand` would sit in the first-sync wait (default 300 s, `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` in `packages/cadre-core/src/strand-first-sync-gate.ts`) and the spec's `beforeAll` would hit Playwright's 60 s timeout. `foundStrand` passes `founder: true` to the launch directly, so the database is published at launch with no gate and no dependence on the watcher.

## The change

In `startFormationResponder`, replace the `publishStrand` + `addStrand` pair with:

```ts
const strandId = crypto.randomUUID();
const { instance: strand, founded } = await node.foundStrand({
	strandId,
	type: 'c',
	memberPrivateKey: await generateStrandMemberKey(),
	sAppConfig: getChatSAppConfig(),
});
if (!founded) {
	throw new Error(`responder strand ${strandId} attached instead of founding — the host fixture must be the founder`);
}
```

and use the returned instance in place of the `node.getStrand(strandId)` lookup that follows (keep the `libp2pNode` presence check and its error). The `founded` check is the seam assertion that keeps the fixture honest about being a founder; it costs nothing and needs no separate test.

Comments to bring in line with the code:

- Delete the `NOTE:` block above the old `publishStrand` call and the comment inside the old `addStrand` argument. Replace with one short comment: the host strand is founded the same way the browser's `createClosedChatStrand` does it, with the shared signed config.
- Step 4 of the `startFormationResponder` doc comment: say `foundStrand` with the shared signed `getChatSAppConfig`; drop "byte-identically" and the `publishStrand` + `addStrand` wording.
- `buildResponderConfig`: the `hostUnclaimedStrands: false` comment names "`publishStrand` and `addStrand` below". The reason still holds — `foundStrand` publishes and then attaches, and a watcher poll between the two must not launch the strand as a schema-less replica — so reword it to name `foundStrand`'s two halves rather than delete it.
- `packages/reference-app-web/README.md` line 331 area describes the fixture; read it and correct it only if it repeats the publish-then-attach wording.

No change to `cadre-web.ts`, the spec, or cadre-core. No new test: the existing distributed spec is the check.

## Edge cases & interactions

- **Watcher poll racing the attach.** `foundStrand` publishes, then attaches. A watcher poll landing between the two sees the row; with `hostUnclaimedStrands: false` and no sApp config registered yet it cannot launch anything, and if it lands after the attach it finds the instance tracked and already founded (the bootstrap is insert-if-absent). Verified by inspection of `launchStrand` / `foundStrand` in `packages/cadre-core/src/cadre-node.ts`; the e2e run covers the ordinary ordering.
- **`founded` false.** Only reachable if a row with this id already existed under another machine's key; the id is a fresh UUID on a fresh in-memory node, so it cannot happen. The thrown error exists so a future change that breaks this fails the boot loudly. Note the spec's `beforeAll` turns a boot failure into a skip, so a thrown error here shows up as two skipped tests, not a red run — when verifying, read the run summary for `2 passed`, not just a zero exit code.
- **Database availability after boot.** `seedMessage` and `readStrandMessages` call `requireStrandDatabase`, which throws while the instance has no published database. A founder launch publishes it before `foundStrand` resolves, so these are usable as soon as boot returns. Verified by the happy-path test, which seeds and reads.
- **Membership key handed to the joiner.** The invitation is bound to the strand id, and the responder returns the stored row's `MemberPrivateKey` on redemption. `foundStrand` stores the key passed in (fresh publish), so the key the browser receives is unchanged in kind. The spec asserts `formed.memberKey` is truthy and the strand is type `'c'`.
- **Browser joiner's first sync.** The browser attaches as a joiner and waits for the host's `Header`; that already works today because the host strand is already founded by the time the invitation is minted. Founding earlier (at launch rather than ~160 ms later) only widens the margin.
- **Teardown.** `stop` removes the `connection:open` listener from the strand's libp2p node, then stops the node. Unchanged; keep using the same libp2p node reference the listener was added to.

## TODO

- Edit `packages/reference-app-web/e2e/fixtures/formation-responder.ts` as described: `foundStrand` call, `founded` check, use the returned instance, comment updates.
- Check `packages/reference-app-web/README.md` around line 331 and correct it if it describes the old two-step setup.
- From `packages/reference-app-web`: `yarn typecheck:e2e`, then `yarn playwright test e2e/distributed 2>&1 | tee ../../tickets/.logs/debt-e2e-formation-host-never-founds-its-strand.test.log`. Expect `2 passed`; two skipped means the responder failed to boot — read the skip reason.
- `yarn lint` from the repo root.
- If the run fails with the fixture founding directly, do not revert: record the failure output in the review handoff — it would mean the invitation path depends on the founding happening late, which is a real defect to file.
