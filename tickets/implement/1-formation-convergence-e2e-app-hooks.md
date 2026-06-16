description: Make the browser reference app's invitation-formed chat strands actually replicate, and add the test-only hooks an end-to-end test needs to connect two parties and read/write their shared messages.
prereq:
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/cadre-core/src/types.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts
difficulty: medium
----

# Browser app hooks for live formation → convergence

This is the **app-side enabler** for the live two-party formation→convergence e2e
(see the sibling `formation-convergence-e2e-responder-fixture` and
`formation-convergence-e2e-wire-and-spec` tickets). Two cadre-web changes are
needed before any cross-party test can pass, both grounded in how the cadre-core
strand cohort actually converges:

1. **Formed (closed) strands must run in `networked` mode.** `CadreNode.addStrand`
   takes `StrandConfig { strandRow, sAppConfig, mode?: StrandMode }`
   (`packages/cadre-core/src/types.ts` ~`:413`). When `mode` is omitted it is
   inferred from the control network's `CadrePeer` cohort, which is empty here, so
   it resolves to **`bootstrap`** — a `local` transactor that **never replicates**
   (this is the silent failure mode the integration test header at
   `strand-formation-e2e.integration.ts:389-393` warns about). The two formed-strand
   `addStrand` calls in `cadre-web.ts` (`createClosedChatStrand` ~`:475` and
   `joinViaInvitation` ~`:567`) currently pass no `mode`. They must pass
   `mode: 'networked'`. **Leave the solo chat strand (`addChatStrand` ~`:693`)
   untouched — it is intentionally `bootstrap`** (solo, no peers).

2. **Test hooks for strand-level connectivity + formed-strand DML.** Formation
   exchanges peer addrs but does **not** persist them as `CadrePeer` rows, so the
   strand cohort seed stays empty and the two strand instances never auto-connect
   (the "strand peer discovery via control network is TODO" the integration test
   flags at `:408-417`, where it instead reaches into `StrandInstance.libp2pNode`
   and manually `.dial()`s). The browser test must do the same, and must be able to
   read/write the **formed** strand (a responder-minted UUID strand, distinct from
   the solo `CHAT_STRAND_ID` the Messages UI renders). Expose these on the existing
   read-only `__cadre` debug hook (`exposeDebugHook` ~`:730`), backed by exported
   functions so they are unit-reachable:

   - `getStrandMultiaddrs(strandId): string[]` — `node.getStrand(strandId)?.libp2pNode?.getMultiaddrs().map(String)` (the strand-level node, **not** the control node).
   - `dialStrandPeer(strandId, addr): Promise<void>` — dial a strand-cohort peer's multiaddr from this strand's libp2p node (`multiaddr(addr)` → `instance.libp2pNode.dial(...)`).
   - `getStrandConnectionCount(strandId): number` — `instance.libp2pNode.getConnections().length`, so the test can poll until the cohort link is live before expecting convergence.
   - `writeChatMessage(strandId, { memberName, content }): Promise<string>` — upsert the author `Member` row then insert an `App.Message` row into the **formed** strand's database; return the new message id. Must target `node.getStrand(strandId)` (the formed strand), not the solo strand.
   - `readChatMessages(strandId): Promise<Array<{ id: string; memberId: string; content: string }>>` — query `App.Message` from the formed strand's database.

   Reuse the existing solo chat read/write path for the exact DML/Quereus handle
   pattern (find where the Messages UI inserts/reads `App.Message` — the same store
   that drives `messages-roundtrip.spec.ts`) and generalize it to take a
   `strandId` / `StrandInstance` instead of assuming `activeStrandId`. The chat
   schema (`Member`, `Message`, FK `Message.MemberId → Member.Id`) is in
   `chat-strand.ts`; a message insert needs its `Member` row to exist first.

## Why these are the right seams

`StrandInstance.libp2pNode` is a public field (`types.ts` ~`:319`) and `getStrand`
is already public, so no cadre-core change is required — only `cadre-web.ts`. The
hooks are additive to the existing `__cadre` surface and guarded by the same
`typeof window === 'undefined'` check, so they no-op outside the browser.

## Edge cases & interactions

- **Solo strand stays bootstrap.** Do not force `networked` on `addChatStrand`; only the two formed-strand calls change. Regression to watch: `messages-roundtrip.spec.ts` and `boot.spec.ts` must still pass (solo path unchanged).
- **Strand not yet active / `libp2pNode` undefined.** Every hook must guard `getStrand(strandId)` and `.libp2pNode` being undefined (strand still launching, or in `bootstrap` mode where there may be no libp2p node) and throw a clear, surfaced error rather than a bare `undefined` deref.
- **Dial idempotency.** `dialStrandPeer` called when already connected, or with an unreachable addr, must not wedge — surface the libp2p error.
- **Member FK on write.** `writeChatMessage` into a fresh formed strand must create the `Member` row before the `Message` row or the FK check rejects it.
- **Unknown / wrong strandId.** Read/write hooks against a strandId this tab never formed must error clearly (helps the test fail loudly rather than silently read an empty solo strand).
- **`networked` with no peers yet.** A formed strand started `networked` before the cohort peer connects must still launch (the strand comes up; convergence waits on the dial). Confirm `addStrand({mode:'networked'})` does not block on a peer at launch.

## TODO

- [ ] Add `mode: 'networked'` to the `addStrand` calls in `createClosedChatStrand` and `joinViaInvitation` in `cadre-web.ts`. Confirm the solo `addChatStrand` is unchanged.
- [ ] Locate the existing solo chat message read/write (the store behind the Messages UI) and factor it so it can target an arbitrary `StrandInstance`/`strandId`.
- [ ] Add exported `getStrandMultiaddrs`, `dialStrandPeer`, `getStrandConnectionCount`, `writeChatMessage`, `readChatMessages` to `cadre-web.ts`, each guarding strand/`libp2pNode` presence.
- [ ] Surface all five on the `__cadre` debug hook in `exposeDebugHook`.
- [ ] `yarn workspace @serfab/reference-app-web build` (typecheck) and `yarn lint` on the changed file — both green.
- [ ] Run the existing solo e2e (`messages-roundtrip`, `boot`, `formation-rbac`) to confirm no regression: `yarn workspace @serfab/reference-app-web test:e2e -g "solo"` (stream output with `2>&1 | tee`). If the full e2e is not agent-runnable in the window, typecheck + lint + a targeted solo spec is acceptable; document the deferral.
