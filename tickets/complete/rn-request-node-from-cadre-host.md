description: The phone app can now ask a self-hosted machine to lend it an always-on node, from a new Settings section that takes the machine's address and a token, shows progress in plain words, and cleans up after itself when something goes wrong. Review fixed a cleanup race on disconnect, turned off autocapitalize on the settings text fields, and filed the missing on-a-real-phone check as its own ticket.
files: packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/test/host-node-request.spec.ts, packages/reference-app-rn/test/phone-node-config.spec.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/cadre-phone.ts, docs/reference-app-rn.md
----

# Borrowing a node from a cadre-host, from the phone app

## Terms

- **cadre-host** — the self-hosted manager someone runs on a machine at home; it can lend nodes to other people's cadres.
- **Grant token** — the secret that host's admin issues with `cadre-host grant issue`, presented as `Authorization: Bearer <token>`.
- **Lent node** — the node cadre-host spawns as a child process into the phone's cadre.

## What shipped

**`src/host-node-request.ts`.** One exported function, `requestHostNode(hostUrl, grantToken, deps)`, driving six stages against `packages/cadre-host/src/server/routes/grants.ts`: `requesting` → `waiting-for-node` → `authorizing` → `seeding` → `connecting` → `connected`. No native imports; `fetch`, the node surface, the stage callback, an `AbortSignal` and the time budgets all arrive as dependencies.

- `POST /grants` sends `{ partyId, ownerKeys: [<this phone's owner public key>], profile: 'storage' }` and **no `bootstrapNodes`** — the phone has no address to be dialed at, so it is always the side that dials.
- `GET /grants/:id/peer` is polled while the host answers `peer_unavailable`, bounded at 90 s. Any other code stops the flow.
- `addDrone` is handed the host's address list unfiltered, each entry with `/p2p/<peerId>` appended.
- `PUT /grants/:id/seed` is retried while the host answers `502 seed_failed`, bounded at 30 s, then surfaces the host's own message.
- `reconcileControlCohort()`, then a 30 s wait for an **open** connection whose remote peer is the lent node's peer id.
- **Cleanup on any failure after the node was provisioned:** `removePeer`, then `DELETE /grants/:id` (bounded at 10 s, on its own AbortController so a cancelled request still frees the host's node). Both best-effort and logged; neither replaces the original error.
- Errors become a `HostNodeRequestError` carrying `stage`, the host's `code`, the host's own wording as `detail`, and the original error as `cause`. The `message` is written for a person.

**`use-cadre.ts`.** `requestHostNode(hostUrl, grantToken, onStage?)` on `UseCadreResult`, guarded like the other actions. A ref holding an `AbortController` plus a settle promise is the re-entry guard *and* the cancel handle: a second call while one runs rejects, and `stop()` aborts an in-flight request and waits (bounded) for it to unwind before tearing the node down.

**`app/settings.tsx` + `src/test-ids.ts`.** A "Host Node" section with host URL and grant token inputs, a Request button disabled while a request runs or either field is empty, a plain-language progress line, and the existing modal for the result or failure.

**`src/phone-node-config.ts`.** `network.connectionGater = { denyDialMultiaddr: () => false }`. libp2p's connection-gater points its `react-native` package field at the browser build, which refuses to dial insecure `ws://` and private (home-network and loopback) addresses — exactly what a lent node on the home network is. Verified during review that cadre-core's membership gater spreads the embedder's gater (`createMembershipConnectionGater`'s `...base`) and adds only `denyDialPeer` plus the inbound/relay hooks, so it never supplies this one.

**`docs/reference-app-rn.md`.** New section "Borrowing a Node From a cadre-host", plus the connection-gater paragraph in "Phone (RN app) Configuration".

## Review findings

Read the implement diff (`f03fa64`) before the handoff summary, then cross-checked every protocol claim against the host's own code (`routes/grants.ts`, `server/error-handler.ts`, `donation/donation-service.ts`) and cadre-core (`membership-connection-gater.ts`, `seed-bootstrap.ts`).

### Fixed in this pass

- **Disconnecting mid-request lost the local cleanup.** `stop()` called `abort()` and then fell straight through to `stopPhoneNode()` without waiting, while the flow's cleanup did the remote `DELETE` (bounded at 10 s) *before* the local `removePeer`. So on the one path where cancellation actually happens — the user taps Disconnect while a request runs — the node was reliably gone by the time `removePeer` ran, leaving a stale authorized-peer row and dial hint for a node the host had also terminated. The implement ticket's own comment and its hook test both asserted the opposite ("still had a live node to use"), so the claim was there but nothing enforced it. Two changes: `cleanup` now does `removePeer` first (the only half that needs a live node) and `endLoan` second, and `stop()` waits for the request to settle, bounded by `HOST_REQUEST_CANCEL_WAIT_MS` (5 s) so an abort the request is not currently interruptible by cannot hold up a logout. Covered by a new ordering test in `host-node-request.spec.ts` and a rewritten hook test that asserts the node is still up while the cancelled request unwinds.
- **Text fields auto-capitalized and auto-corrected.** `LabelledInput` passed no `autoCapitalize`/`autoCorrect`, so React Native's defaults apply: the first character is upper-cased and word substitutions are offered. Every field on this screen takes an identifier, an address or a token — a hand-typed grant token becomes a 401 and `http://…` becomes `Http://…`. Set `autoCapitalize="none"` and `autoCorrect={false}` on the shared component, which fixes the pre-existing fields (party id, multiaddr, seed, invite) at the same time. Device-only symptom, so no test asserts it.
- **A leak the cleanup cannot close was described as if it could.** If the host answers the provisioning `POST` with a body carrying no donation id, a node exists on the host and its id was what that reply was carrying — there is nothing to `DELETE` by. The message now says so and points the user at the host, instead of implying the app tidied up. New test.
- **Stale ticket paths in the new doc section.** It pointed at `tickets/blocked/rn-solo-founding-device-run`, which is in `tickets/complete/`. Fixed by naming ticket slugs without their stage folder in all four references, since the folder is what moves.
- **Documented what Disconnect does mid-request** in `docs/reference-app-rn.md`, including that the wait is bounded and what is left behind if it runs out.

### Test gaps closed

The implement tests covered the call sequence, both retry loops, cancellation, connection matching and every mapped error code well. The holes were all in the "reply is not what we expected" paths, which is most of what this module exists to handle. Added six tests: cleanup ordering; a `201` with no donation id; a peer reply with an empty address list; a success body that is not JSON; a failure body that is not the host's `{ ok:false, error:{ code } }` envelope (a proxy's error page — asserts it is described by status and *not* retried); and an address that already carries `/p2p/`, where appending a second one would make it unparseable.

### Checked and found correct

- **Cleanup completeness.** `dronePeerId` is recorded before `addDrone` because `addDrone` writes the authorization row and then mints the seed, so a failure in the second half leaves the row. Confirmed against `seed-bootstrap.ts` that `removePeer` no-ops on an absent row, so cleaning up a row that was never written is harmless — the implement ticket's reasoning holds.
- **Every error code and status the mapper claims.** Cross-checked `plainMessage` against `DONATION_STATUS` in `error-handler.ts`, the bearer gate in `routes/grants.ts` (401 `unauthorized` / 403 `forbidden`), the origin guard's `forbidden_origin`, and `quota_exceeded` → 429. All present, all mapped, no code handled that the host cannot send and none sent that falls through to a worse message than it should.
- **The connection-gater premise about cadre-core.** `createMembershipConnectionGater` spreads `...base` and overrides only `denyDialPeer` and the inbound/relay hooks, so an embedder's `denyDialMultiaddr` does survive. That half of the reasoning is proven; the libp2p-build half is not (see below).
- **Re-entry, abort plumbing, connection matching.** The ref guard holds against a same-frame second tap, the caller's signal reaches every main-flow fetch while cleanup's `DELETE` deliberately carries its own, and the connection wait matches on the lent node's peer id with `status === 'open'`. Tests already had teeth on all three.

### Filed as a new ticket

- `tickets/blocked/rn-host-node-request-device-run.md` — the feature was written and tested with no phone involved, and the parts Node cannot exercise are the parts most likely to be wrong: whether the permissive dial gater is what actually lets the phone reach a home-network node, whether the forwarded port satisfies the host's origin guard, whether the Windows firewall prompt appears, and whether a dozen user-facing messages read well on a phone screen. `blocked/` rather than `backlog/` because the missing ingredient is a physical Android phone — a dependency outside this repo — following the precedent of the completed `rn-solo-founding-device-run`.

### Recorded as tripwires, not tickets

- **Leaving the Settings screen does not cancel a running request.** Not reachable today: the tab navigator keeps Settings mounted and the hook lives at the app root. `NOTE:` at `handleRequestHostNode` in `app/settings.tsx`, naming the condition (Settings moving behind a stack route that unmounts) and the fix.
- **The connect step reconciles once and then waits 30 s.** cadre-core joins a reconcile pass already in flight rather than restarting it, so the wait must outlast one further timed pass (15 s today). `NOTE:` already at `connectToNode`; verified it still reads correctly and left it.
- **An OS kill mid-request surfaces as a node-call failure rather than as "the node was killed".** `NOTE:` already at the hook's `requestHostNode`; correct as written.

### Considered and declined, with reasons

- **No Maestro flow for the new Settings section.** A flow here would need a live `cadre-host` and a valid grant token on the build machine, which is a different kind of test from the ones in `packages/reference-app-rn/maestro/` — those drive the app alone. The manual session is documented and now has its own ticket; a flow that cannot run unattended would be a maintenance cost with no gate behind it.
- **`HostNodeRequestBudgets` being exported.** The implement handoff asked whether this reads as production configuration surface. It does not: nothing in the app passes `budgets`, the interface's own docs say the defaults are what the app uses, and each field explains where its number comes from. A test seam that is honest about being one.
- **`src/host-node-request.ts` at 613 lines** (measured with `wc -l`). Above average for this package but not a split candidate: roughly 45% of it is comments, every function is short and single-purpose, and the six stages plus their error mapping are one cohesive flow that would only gain indirection by being cut in two. No `debt-` ticket.
- **The seed retry cannot distinguish a permanent rejection from a route that is not up yet.** Both are `502 seed_failed`; a real rejection costs the full 30 s window. The alternative is parsing the host's message text, which `AGENTS.md` rules out ("no half-baked janky parsers"). Deliberate and already stated in `putSeed`'s comment.
- **The donation id is returned and then dropped** — the app cannot list loans or end one. Explicitly out of scope for this ticket, and the doc says where to do it instead.

### Empty categories

No findings on type safety (no `any`, the node surface is declared structurally with a stated reason), on exception handling (nothing is swallowed un-logged; cleanup failures warn and never replace the original error), or on resource cleanup inside the module itself (every timer is cleared on both paths, the abort listener is `{ once: true }`, and the cleanup `AbortController`'s timer is cleared in a `finally`).

## Validation

- `yarn workspace @serfab/reference-app-rn test` — 16 files, **248 passed** (242 before this pass; 6 added).
- `yarn workspace @serfab/reference-app-rn typecheck` — clean.
- `yarn lint` — clean.
- One test run aborted in `global-setup` on the stale-build guard for the linked sibling workspace `../optimystic` (`quereus-plugin-optimystic` dist older than its src). That workspace has uncommitted edits from concurrent work outside this repo; the next run was green. Not a test failure and not caused by this diff, so no `.pre-existing-error.md` was written.
- Not run: the integration-tests package and the cadre-host suite. Nothing outside `packages/reference-app-rn` and `docs/` changed.
