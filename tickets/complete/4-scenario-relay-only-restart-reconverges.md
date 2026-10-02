description: The reporter's "two phones stop syncing after a restart" reproduction is now an integration test. It passes with the new address book, and an opt-in variant proves it fails without one; another opt-in variant repeats the restart with each party in its own OS process.
architecture: docs/testing.md#topology-coverage-map
files: packages/integration-tests/src/scenarios/strand-relay-only-restart-reconverges.integration.ts, packages/integration-tests/src/harness/strand-restart-party.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/package.json, yarn.lock, knip.ts, docs/testing.md, docs/strands.md, docs/architecture.md, .release-notes.pending.md, packages/reference-app-web/src/lib/cadre-web.ts
----

## What was built

Maintainer decision (2026-09-27), items 5 and 6: the gotchoices/sereus#18 reproduction as a scenario, and the docs and release note for the four tickets before it.

**Scenario** `strand-relay-only-restart-reconverges.integration.ts`, on the blind-relay topology (one dedicated loopback relay, two parties, each one relay-only `CadreNode`). A founds a closed strand and publishes a bound invitation, B forms and attaches from the carried seed. Phase 1 (B reads A's row), then a control write before any restart. Then B's node stops, then A's, and two new nodes are built over the same identity key, raw stores (`captureRawStorage`), peer-book backing and joined-strand key store. Each claims its strand from `strand:discovered` (subscribe, then drain `getDiscoveredStrands()`): A's comes from its control `Strand` row, B's from the remembered join. Then phase 2: A writes and B reads, then B writes and A reads. Finally it asserts that each book holds the other side's signed entry with `issuedAt` at or after the restart (so the swap ran between the new nodes), and that every A↔B strand connection classifies `relayed`. Timings print on `[RESTART …]` lines.

Three arms, one file:

- **Default**: persistent books (`PersistentStrandPeerBookStore` over an in-memory `DurableSlot` held outside the node, reopened per incarnation), `joinedStrands.store` = `KeyStoreJoinedStrandStore` over an `InMemoryKeyStore` held outside the node, `privateKey` identity.
- **`RESTART_NEGATIVE_CONTROL=1`**: same, with the book left at the in-memory default. Passes only if B never reads the post-restart row within the 180 s budget and the strand nodes never reconnect.
- **`RESTART_TWO_PROCESS=1`**: each party is a `node` child (`harness/fixtures/strand-restart-party.mjs`) driven over IPC by `harness/strand-restart-party.ts` (`startStrandRestartParty`, typed request map `StrandRestartOps`). On-disk state under a temp dir: `FileKeyStore` (identity and, as the node's default over its `keyStore`, the joined-strand records), `FileStrandPeerBookStore`, `FileRawStorage` per scope (cadre-cli's layout). After the control step both children stop their node and exit, then new processes are spawned over the same directories. The temp dir is removed in `finally` (it holds no `node_modules` junctions).

The in-process arm injects `privateKey` + `joinedStrands.store`, and the two-process arm injects `keyStore`, so both documented injection routes run.

**Harness**: `controlNodeConfig` gains `strandPeerBook` and `joinedStrandStore` (pass-through to `strandPeers.store` / `joinedStrands.store`, same shape as `bootstrapPeerStore`). `strand-restart-party.ts` is exported from the harness barrel.

**Dependency**: the child imports `@optimystic/db-p2p-storage-fs`, which integration-tests did not declare (it resolved only through hoisting). It is now declared, with the one-line `yarn.lock` addition. I checked it with `yarn install --mode=update-lockfile` (no link step, no further lockfile change). `knip.ts` declares `src/harness/fixtures/*.mjs` as integration-tests entries; without that, `yarn knip` exited 1 on the new dependency as unused. It now exits 0, and the entry also clears the old unused-file warning on `idle-child.mjs`. `docs/testing.md` → "Dependency-check coverage" gains a bullet saying why.

**Docs**:
- `docs/testing.md` topology map: a new line for the restart shape, naming both opt-in arms.
- `docs/strands.md`: the "How a restarted machine re-finds its strand's peers" paragraph now ends with this scenario as the proof. The joined-strand section's closing paragraph said the other party's addresses were "still held in memory only"; that is now stale, and it is rewritten to say the record needs the durable book beside it.
- `docs/architecture.md` → Relay Integration: an "And the same pair restarting" paragraph after the blind-relay one.

**Release note**: the four #18 bullets are gathered under one heading addressed to the reporter: what a restarted node does, what an embedder must inject, the relay warning, and the remaining gap.

## Measured

- **Default arm**: 8 runs, all passed (5 isolated in a row, 1 inside the full-suite run, 2 while developing). From the rebuild: strand nodes reconnected at 1.25–1.39 s, B read A's post-restart row at 1.41–2.46 s, and A read B's row about 0.1 s later. Test wall time was 4.8–6.0 s. In 1 of those runs B came up `'syncing'` (its kept store lacked a collection; this is the bimodal re-attach recorded at `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`) and became writable at 1.46 s, once connected.
- **Negative control**: 2 runs; both never converged, in the two different shapes. Run 2, on the final code, matches the reporter exactly: `both strands launched at 400 ms (A active, B active)` … `strand nodes never connected` … `negative control: phase 2 did not converge in 180000 ms; B strand active`, test passed in 184 s. Run 1 was on an earlier draft that required both strands `active`: B stayed `'syncing'` and `whenStrandWritable` rejected with `StrandAwaitingFirstSyncError` after 180 s. The arm now accepts either shape: B is never able to read the row.
- **Two-process arm**: 2 runs, both passed. Respawned at about 3.1 s, both strands active at 4.4 s, phase 2 both ways by 4.8 s, about 12 s per test. No temp dir was left behind.
- **Full integration run**: `yarn vitest run` in 4 chunks (the whole suite runs past the tool's 10-minute cap). 314 passed, 15 skipped (opt-in arms), 0 failed. The ticket's "6-way parallel" concern does not apply: `vitest.config.ts` has `fileParallelism: false`, so files run one at a time.
- **Relay-reservation edge case**: the strand dial lands about a second after the rebuild in every run, so there is no late-reservation finding.
- `yarn workspace @serfab/integration-tests typecheck`, eslint on every touched file, `yarn check:dep-ranges`, and integration-tests' own `test/` specs (48 passed): all clean.

Logs are in `tickets/.logs/scenario-relay-only-restart-reconverges.*.log`.

## Deviations, kept

- **The two-process arm stops the children gracefully rather than killing them.** Each child runs `node.stop()` and then exits; `SIGKILL` is used only if a child has not exited 60 s after it was asked to stop. What the arm has to prove is that no module state survives, and a process exit proves it. A hard kill during a write could tear a `FileRawStorage` and fail for reasons unrelated to #18. A hard-kill variant would be a different claim (crash durability of the book) and is not covered.
- **The negative control accepts two failure shapes** (see Measured). Both are the split the reporter saw; which one appears depends on what B's kept store holds.
- **Both opt-in arms stay opt-in**, as the ticket asked, though the two-process arm costs only about 12 s. The in-process arm is what gates the behaviour.

## Known gaps

- **The web reference app still loses a strand joined from another party when it restarts.** It passes `privateKey`, keeps `formedStrands` in memory, and has no `strand:discovered` handler. The plan chose to leave it (`cadre-core-remembers-joined-strands`: "leave it, but note it in the handoff"). The release note previously said "every reference app already inject both", which was wrong; it now names the web app. No ticket filed. The NativeScript app never joins another party's strand, and cadre-cli and cadre-host never call `formStrand`.
- **Third-party forwarding over a live network is still unproven**: this scenario has two parties. The swap ticket hoped this one might add it.
- **The negative control ran twice and the two-process arm twice.** Their rates are not characterised.
- **The post-restart relayed check is weaker than the blind-relay one**: it checks `kind === 'relayed'` only, not `transport` or unlimited connections. The relay reservation count is not re-asserted after the restart.

## Tests added

- `strand-relay-only-restart-reconverges` default arm: pins #18. Two relay-only parties restarting over kept storage re-mesh with no app-side list and no fresh invitation, a post-restart write crosses both ways, the swap re-runs between the rebuilt nodes, and every path stays relayed.
- Negative-control arm (opt-in): proves the default arm depends on the book persisting, not on some other path.
- Two-process arm (opt-in): proves the same across real process exits over on-disk stores, with no shared in-memory objects or module state.

## Review findings

Read the implement diff (55ad48ad) before the handoff. Ran: `yarn workspace @serfab/integration-tests typecheck` (clean), eslint on every touched source file plus `cadre-web.ts` (clean), `yarn knip` (exit 0), and `RESTART_TWO_PROCESS=1 … vitest run strand-relay-only-restart-reconverges` (default arm and two-process arm both passed: strand nodes reconnected at 1.35 s, B read A's post-restart row at 2.42 s; two-process arm 11.8 s, post-restart convergence at 4.8 s from respawn). The negative control (180 s) was not re-run; the implementer's two runs stand.

- **Correctness of the assertions** — checked. The "re-signed after the restart" check filters on `sig !== undefined`, so the unsigned entries that connections write cannot satisfy it; the peer-id equality check confirms the strand transport key derivation that makes a remembered entry dialable; the negative control matches on `waitUntil`'s own timeout message (`Timeout waiting for phase 2…`), so an unrelated throw fails the arm rather than passing it. No defect.
- **Harness process handling (`strand-restart-party.ts`, the `.mjs` child)** — checked the request/exit paths: pending requests are rejected on child exit and on IPC send errors, `exit()` is idempotent and kills after 60 s, the child stops its node when the parent disconnects, and the temp dir is removed only after both children exit (it holds no `node_modules` junctions). No defect.
- **Resource cleanup** — on a failure before `await connected`, the in-process arm's background "strand nodes connected" poll keeps running against stopped nodes until its 180 s budget ends; it only logs, and only on an already-failing run. Left as is, no note.
- **DRY** — `readDataRows`, the discovered-strand claim and the node config are repeated between the TypeScript scenario and the plain `.mjs` child; the child cannot import TypeScript source, and the child's header says it mirrors `controlNodeConfig`. Accepted. `withTimeout` is local to the scenario; the harness has no equivalent (only polling `waitUntil`).
- **Realism of the restart** — the rebuilt nodes do not re-run `makeOwnOwner` / `initializeSeedBootstrap` / `initializeStrandSolicitation`. That does not weaken the claim (the strand plane re-meshes without them) and matches what the scenario isolates. No change.
- **Docs** — read `docs/testing.md`, `docs/strands.md`, `docs/architecture.md` and the release note against the code and the run output. **Fixed:** `docs/testing.md` said the two-process arm "takes about 25 s"; that is the whole vitest file duration including import. The arm itself runs in about 12 s (both runs), so the line now says 12 s. The rest matches: the web app's durable peer book is real (`cadre-web.ts` opens a `PersistentStrandPeerBookStore`), and the stale "held in memory only" paragraph in `strands.md` is correctly rewritten.
- **Known gap: the web reference app loses a joined strand on reload** — the plan for `cadre-core-remembers-joined-strands` chose to leave it, but nothing at the code site recorded that decision. **Added** an accepted-tradeoff `NOTE:` above `formedStrands` in `packages/reference-app-web/src/lib/cadre-web.ts`, naming the revisit condition (the web app expected to survive a reload as a joiner). No ticket filed.
- **Tests** — the three arms each pin a distinct claim (the fix, that the fix depends on the book persisting, and that it holds across real process exits); none restates the implementation or mocks a repository module. None cut, none added.
- **Type safety** — the typed `StrandRestartOps` request map covers the IPC boundary on the parent side; the `.mjs` child is untyped by nature. No `any` added.
- **Other remaining gaps** — third-party forwarding over a live network and the weaker post-restart relayed check (kind only, no transport or reservation count) are as the implementer described. They are coverage limits, not defects, and are recorded in the handoff above. No tickets filed.
