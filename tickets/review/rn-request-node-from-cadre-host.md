description: The phone reference app can now ask a self-hosted machine to lend it an always-on node, from a new Settings section that takes the machine's address and a token, shows progress in plain words, and cleans up after itself when something goes wrong.
files: packages/reference-app-rn/src/host-node-request.ts (new), packages/reference-app-rn/test/host-node-request.spec.ts (new), packages/reference-app-rn/test/phone-node-config.spec.ts (new), packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/cadre-phone.ts, docs/reference-app-rn.md
----
# Review: request a node from a cadre-host (React Native app)

Both prereqs had already landed and are archived in `tickets/complete/` (`donated-node-reachable-by-phone`, `owner-keeps-dialing-node-it-added`).

## Terms

- **cadre-host** — the self-hosted manager someone runs on a machine at home; it can lend nodes to other people's cadres.
- **Grant token** — the secret that host's admin issues with `cadre-host grant issue`, presented as `Authorization: Bearer <token>`.
- **Lent node** — the node cadre-host spawns as a child process into the phone's cadre.

## What landed

**`src/host-node-request.ts` (new, ~590 lines including comments).** One exported function, `requestHostNode(hostUrl, grantToken, deps)`, driving six stages against `packages/cadre-host/src/server/routes/grants.ts`: `requesting` → `waiting-for-node` → `authorizing` → `seeding` → `connecting` → `connected`. No native imports; `fetch`, the node surface, the stage callback, an `AbortSignal` and the time budgets all arrive as dependencies.

- `POST /grants` sends `{ partyId, ownerKeys: [<this phone's owner public key>], profile: 'storage' }` and **no `bootstrapNodes`** — the phone has no address to be dialed at.
- `GET /grants/:id/peer` is polled while the host answers `peer_unavailable`, bounded at 90 s. Any other code stops the flow.
- `addDrone` is handed the host's address list unfiltered, each entry with `/p2p/<peerId>` appended.
- `PUT /grants/:id/seed` is retried while the host answers `502 seed_failed`, bounded at 30 s, then surfaces the host's own message.
- `reconcileControlCohort()`, then a 30 s wait for an **open** connection whose remote peer is the lent node's peer id.
- **Cleanup on any failure after the node was provisioned:** `DELETE /grants/:id` (bounded at 10 s, on its own AbortController so a cancelled request still frees the host's node), then `removePeer`. Both best-effort and logged; neither replaces the original error.
- Errors become a `HostNodeRequestError` carrying `stage`, the host's `code`, the host's own wording as `detail`, and the original error as `cause`. The `message` is written for a person: unknown token, expired/revoked grant, node limit reached, host unreachable, node never started, seed rejected, loan ended mid-flight, and the origin-guard 403 → "use adb reverse and a 127.0.0.1 address".

**`use-cadre.ts`.** `requestHostNode(hostUrl, grantToken, onStage?)` on `UseCadreResult`. Guarded like the other actions ("Node not started"). A `useRef<AbortController>` is the re-entry guard *and* the cancel handle: a second call while one runs rejects, and `stop()` aborts an in-flight request **before** tearing the node down, so cleanup still has a live node.

**`app/settings.tsx` + `src/test-ids.ts`.** A "Host Node" section with host URL and grant token inputs, a Request button disabled while a request runs or either field is empty, a plain-language progress line, and the existing modal for the result or failure (message on top, the host's `detail` in the detail line). Four new test ids in the existing style.

**`src/phone-node-config.ts`.** `network.connectionGater = { denyDialMultiaddr: () => false }`. libp2p's connection-gater points its `react-native` package field at the browser build, which refuses to dial insecure `ws://` and private (LAN and loopback) addresses — which is exactly what a lent node on the home network is. cadre-core's membership gater spreads the embedder's gater and adds only `denyDialPeer` plus the inbound/relay hooks, so it never supplies this one. `cadre-phone.ts`'s stale comment ("no `connectionGater` override is added: the phone dials a real relay/drone over `wss`") now points at the config instead.

**`docs/reference-app-rn.md`.** New section "Borrowing a Node From a cadre-host" after the two-node startup sequence, plus the connection-gater paragraph in "Phone (RN app) Configuration".

## Use cases to attack

1. **The flow is correct but the app never connects on a device.** The single behavioural claim with no runtime coverage anywhere is the `connectionGater` change. Node's libp2p uses the *node* build of the gater, so neither the new unit tests nor `cadre-host-donation-phone-requester.integration.ts` can fail if the gater line is deleted — only a device can. `test/phone-node-config.spec.ts` asserts the field exists and returns `false`, which is a presence check, not a proof that it is the thing standing between the phone and the LAN dial. Worth challenging the *reasoning* in the comment rather than the code.
2. **Cleanup leaves something behind.** Two resources: the host's node-quota slot and port set (`DELETE`), and the phone's local authorization row (`removePeer`). `dronePeerId` is recorded **before** `addDrone` is called, because `addDrone` writes the row and *then* mints the seed (`seed-bootstrap.ts`), so a failure in the second half leaves the row. Verified by reading that `SeedBootstrapService.removePeer` no-ops on an absent row (`queryCadrePeerStampId` returns null → log + return), so cleaning up a row that was never written is harmless. Check that reasoning.
3. **Double tap / re-entry.** The guard is a ref in the hook, not the disabled button. The hook spec covers refusal, cancel-on-stop, and that the guard clears after both success and failure.
4. **Cancellation.** The main-flow fetches carry the caller's signal; the cleanup `DELETE` deliberately does not, and has its own 10 s bound. A test asserts the aborted request still issues the `DELETE`.
5. **Which connection counts.** Matching is on the lent node's own peer id and `status === 'open'`. Two tests give it teeth: an unrelated open connection times out, and a closed connection to the right peer times out.
6. **Error wording.** Every mapped code has a test asserting the user-facing message and that `detail` still carries the host's own.

## How to validate

```
yarn workspace @serfab/reference-app-rn test
yarn workspace @serfab/reference-app-rn typecheck
yarn lint
```

Run just the new flow spec: `yarn workspace @serfab/reference-app-rn vitest run --project node test/host-node-request.spec.ts`.

The device session is documented in `docs/reference-app-rn.md` → "Borrowing a Node From a cadre-host".

## Known gaps — read these before trusting the green run

- **The device run was NOT performed.** No Android device or emulator was available. Every step of the documented session — `adb reverse`, the Windows firewall prompt, the origin guard accepting the forwarded `127.0.0.1` Host header, and above all whether the `connectionGater` change actually lets the phone dial the lent node — is unverified. The docs section is written from the code and the prereq tickets, not from a run.
- **No wire coverage from this package.** `test/host-node-request.spec.ts` drives a fake host and a fake node. It proves the phone speaks the protocol in the right order with the right bodies; it proves nothing about a real lent node coming up, accepting a seed, or being reachable. That is `packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts`, which was **not re-run here** — nothing in this diff touches cadre-core, cadre-host or that scenario.
- **No Maestro flow** was added for the new Settings section. The existing device flows live in `packages/reference-app-rn/maestro/`; the ticket did not ask for one, and a flow that needs a live cadre-host on the build machine is a different kind of test from the ones there now. Worth a judgement call.
- **The abort fires on `stop()` only.** If the OS kills the node mid-request, the BackgroundRunner's cold start replaces the singleton and the in-flight request's own node calls fail against the dead one — the right outcome, but the message names the failing node call rather than the kill. A `NOTE:` at the hook's `requestHostNode` says so.
- **Screen unmount does not cancel.** The tab navigator keeps Settings mounted, and the hook lives at the app root, so this is not reachable today — but nothing in the hook aborts on unmount.
- **The seed retry cannot tell a permanent rejection from a not-yet-ready route.** Both are `502 seed_failed`; a real rejection costs the full 30 s window before it surfaces. Deliberate — the alternative is parsing message text — and stated in `putSeed`'s comment.
- **The donation id is returned and then dropped.** The app cannot list loans or end one; that was explicitly out of scope.
- **Budgets are injectable purely for tests.** `HostNodeRequestBudgets` is exported and every test overrides it to milliseconds. If that seam looks like production configuration surface rather than a test seam, say so.

## Tripwires recorded (not tickets)

- `connectToNode` in `src/host-node-request.ts` — one `reconcileControlCohort()` call then a 30 s wait. cadre-core joins a pass already in flight rather than restarting it, so the wait has to outlast one further timed pass (15 s, `DEFAULT_CONTROL_COHORT_RECONCILE_MS`). If that cadence is raised past `connectMs`, this step starts failing nodes that were about to connect.
- `requestHostNode` in `src/use-cadre.ts` — the in-flight request holds the node it started with; an OS kill mid-request surfaces as a node-call failure rather than as "the node was killed".

## Validation run

- `yarn workspace @serfab/reference-app-rn typecheck` — clean.
- `yarn workspace @serfab/reference-app-rn test` — **16 files, 242 passed**. 29 of those are new: 22 in `host-node-request.spec.ts`, 2 in `phone-node-config.spec.ts`, 5 in `test/react/use-cadre.spec.ts`.
- `yarn lint` — clean (exit 0).
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
- Not run: the integration-tests package and the cadre-host suite. This diff touches neither, and nothing outside `packages/reference-app-rn` and `docs/` changed.
