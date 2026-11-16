description: Many comments in the source say the software does something it no longer does, or point the reader to a ticket that cannot be found anywhere. Add an automatic check for the ticket references, and correct the misleading comments once, since nothing can check those automatically.
architecture: docs/contributing/gates.md#documentation
files: scripts/ (a new check beside check-docs.mjs), package.json (`lint` script), tickets/.pruned-tickets.jsonl, docs/contributing/gates.md, ops/docker/libp2p-infra/src/main.ts, ops/docker/relay/env.example, packages/cadre-core/src/relay-server.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-peer-redial.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-rn/src/node-local.ts, packages/quereus-plugin-sereus/scripts/build-browser.mjs, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/src/plugin-browser.ts, schemas/control.qsql, packages/cadre-core/src/control-schema.ts
difficulty: medium
tradeoffs: The comment sweep is a one-time correction that nothing keeps correct afterwards, and the ticket-reference check needs a rule for references to the sibling repositories' boards, which are not present in every checkout; a maintainer may take only the check, or only the sweep.
----

# Source comments that contradict the code or cite tickets that resolve nowhere

Found during the documentation rewrite, when about forty readers compared the docs, the comments and the code. Two classes came up repeatedly. They share one cause: a comment is written when a change lands and nothing re-reads it when a later change, or an upstream release, makes it false.

The two classes get different treatment, and this ticket says so plainly:

- **Class B, ticket references, can be gated.** The deliverable is a check script.
- **Class A, comments that state behaviour, cannot.** No script can tell that a sentence about behaviour is false. The arms below are a one-time sweep. `docs/contributing/gates.md` → "Documentation" already says the same of the docs gate ("a claim that no longer matches the code"); after this ticket it should say it of source comments too.

## Class B: ticket slugs cited in source

`AGENTS.md` tells writers to "name the ticket slug (or the upstream commit) and stop", and `tess/agent-rules/tickets.md` says a finished ticket that has left `tickets/complete/` is found in `tickets/.pruned-tickets.jsonl`. So a slug in a comment is meant to resolve in one of two places: a file on the board, or a record in that ledger. Nothing checks that it does. `scripts/check-docs.mjs` checks Markdown links and skips `tickets/`.

### What was measured

A scratch script (not committed) read every file git tracks or would track outside `tickets/` and `tess/` with a source, config or Markdown extension (1,322 files). It collected tokens of three shapes: a `tickets/<stage>/<name>` path; a token starting `bug-`, `debt-`, `feat-`, `decide-` or `report-`; and any backticked lowercase hyphenated token of three or more parts. Each was looked up among the board's file names (all stages, `complete/` included, sequence prefix stripped) and the ledger's `slug` fields. A slug cited with no backticks and no prefix is invisible to this scan, so the counts are lower bounds.

- 89 distinct slugs resolve to a file on the board.
- 60 resolve to the pruned ledger only (finished tickets).
- 6 resolve only on a sibling repository's board or ledger (`../optimystic`), cited without saying so.
- 30 resolve nowhere: not on this board, not in this ledger, and not on the boards or ledgers of `../optimystic`, `../quereus` or `../Fret`. Each was then read in context to confirm it is cited as a ticket; they are listed under arm B1.

Separately, of 52 path-form citations (`tickets/blocked/x.md`, `backlog/x`), 24 name a path where no file is, because the ticket has since moved stage or been pruned.

### Arm B1: slugs that resolve nowhere

For 28 of the 30, `git log -- 'tickets/*<slug>*'` shows a ticket file once existed in this repository. They were deleted without a ledger record: finished before the ledger started, or split, renamed or withdrawn. A reader without the history cannot find them. The other two are the last two items below.

- Cited as open work, which is the harmful form, because the reader believes a gap is tracked:
  - `strand-network-nat-relay-reachability`, as `backlog/…` in `cadre-node.ts` and as `tickets/backlog/….md` in `push-wake-e2e.integration.ts`.
  - `sapp-schema-signature-gate-bypassable` ("owned by") and `strand-membership-rbac-schema-not-applied` in `rbac-signed-write.integration.ts`.
  - `strand-membership-lifecycle-population` ("owned by") in the plugin's `compose-strand.ts`, `strand-schema.ts` and `strand-schema.e2e.spec.ts`.
  - `control-strand-closed-member-key-constraint` ("the backlog ticket") in `reference-app-web/e2e/distributed/formation-convergence.spec.ts`.
  - `control-write-refused-when-a-rival-write-holds-the-block` and `control-write-retry-does-not-absorb-a-transient-stream-reset` ("owned by") in `control-write-degraded-cohort-member.integration.ts`.
  - `formation-convergence-e2e-wire-and-spec` ("the sibling … ticket") in `reference-app-web/e2e/fixtures/formation-responder.ts`.
- Cited as history: `cadre-host-installer` (as `tickets/implement/6.4.1-…md` in `cadre-host/src/installer/index.ts`), `third-node-join-ddl-init`, `wire-strand-storage-into-bootstrap-transactor`, `cadre-core-digest-variadic-api-migration`, `cadre-invite-redeemable-before-the-row-replicates`, `control-cohort-proactive-dial`, `control-db-network-backed`, `control-network-cohort-discovery`, `control-write-ensure-replicated`, `devicetoken-stamp-writers-and-tests`, `membership-cadrepeer-voucher-persist`, `optimystic-deferred-check-not-enforced-on-delete`, `optimystic-insert-pk-uniqueness-not-enforced`, `removal-must-cut-the-network-not-just-the-row`, `seed-signerkey-trust-policy`, `solo-warm-start-blocks-on-prior-cohort-peers`, `strand-node-never-redials-through-a-relay-at-a-three-second-round-trip`, `strand-seed-from-strand-addr-rpc`, `hibernation-push-wake`, `bug-strand-manager-authority-antireplay`.
- Wrong spelling of a slug that does exist: `feat-rn-kit-native-digest` in `cadre-rn/src/native-digest.ts`; the ledger has `rn-kit-native-digest`.
- An Optimystic slug found on neither Optimystic's board nor its ledger: `bug-first-registration-proof-of-work-freezes-the-node-for-seconds` in `strand-reactivity-wakes-watchers.integration.ts`.

### Arm B2: finished tickets cited as if open

These slugs are in the pruned ledger, so the work landed. The comment still says "tracked by", `backlog/…` or `blocked/…`. This is a smaller problem than B1, since the slug resolves, but the comment misstates the state of the work, and several of these also belong to class A.

- `ns-durable-node-local-stores`: "only NativeScript stays ephemeral, tracked by …" on `bootstrapPeers` in `types.ts`.
- `report-libp2p-websockets-abort-close-code`: `tickets/blocked/….md` in `membership-connection-gater.ts`.
- `fret-maintenance-ping-dial-budget-below-a-relayed-dial`: `blocked/…` in `strand-peer-redial.ts`.
- `control-read-over-fresh-edge-stream-resets`: `tickets/blocked/…` in `control-retry.ts` and `tickets/fix/….md` in `control-write-retry.spec.ts`.
- `debt-read-repair-single-voter-corroboration` and `feat-solo-node-arms-its-own-freshness-window`: `backlog/…` in the plugin's `cluster-size.ts` and in `strand-instance-manager.ts`.
- The three gate scripts cite their own founding tickets at stage paths that no longer hold them: `check-dep-ranges.mjs` (`tickets/fix/0.2-…`), `check-vitest-typecheck-coverage.mjs` (`tickets/plan/16-…`), `check-test-file-typecheck-coverage.mjs` (`tickets/complete/…`).

### The invariant

A check in the style of `scripts/check-*.mjs`, run by `yarn lint` beside `check:docs`, with a companion `.test.mjs`, that fails when a source file or a document outside `tickets/` cites a ticket that is neither on the board nor in `tickets/.pruned-tickets.jsonl`. It retires B1 mechanically. Three points the work has to settle, each of which changes what the check can promise:

- **How a citation is recognised.** The scan above shows why a bare hyphenated word cannot be the rule: 184 backticked hyphenated tokens were not tickets (test ids, package names, scenario file names, error codes). A citation needs a form the check can see. The workflow rules already say to cite by slug, never by file name or stage, so a path-form citation can be an error in its own right, which also retires the 24 dead paths.
- **Sibling boards.** Six slugs belong to Optimystic. `../optimystic`, `../quereus` and `../Fret` are absent from a CI checkout and from `yarn check:published`, so the check cannot require them. A citation of a sibling's ticket needs a marked form (`control-write-retry.ts` already writes `../optimystic/tickets/backlog/…`), checked only when the sibling checkout is present.
- **Open versus finished.** The check can flag a `backlog/…` or `blocked/…` form whose slug is in the ledger. It cannot flag a bare slug in a sentence that says "tracked by". B2 is therefore part sweep.

Test fixtures are out of scope: `packages/cadre-core/test/fixtures/control-schema/v3.qsql` and `v4.qsql` are frozen copies of old schema versions and keep whatever they cited.

## Class A: comments that state behaviour the code does not have

No gate catches these. Each arm is a comment to correct once. "Checked" means this ticket's author read both the comment and the code it describes; the others were reported by one or two readers during the rewrite and are listed so the sweep covers them.

### Relay

- **"Database services refuse a limited connection."** Checked. `ops/docker/libp2p-infra/src/main.ts` (above `RELAY_APPLY_DEFAULT_LIMIT`), the module comment of `packages/cadre-core/src/relay-server.ts`, and `ops/docker/relay/env.example` ("dropped by the receiving handler") give this as the reason the relay runs uncapped. Optimystic 1.27.0 sets `runOnLimitedConnection: true` on both sides (`register-protocol-handler.ts`, `open-protocol-stream.ts` in `../optimystic/packages/db-p2p/src/network`). The reason that still holds is in `docs/network/relay.md`: the cap resets a connection at 128 KiB or 2 minutes, and seed delivery does not opt in.
- **An unannounced strand node is "denied" at a party-run relay.** Checked. `strand-transport-key.ts` ("the relay denies the strand node's reservation and `libp2p.start()` fails"), and in `cadre-node.ts` the comments on `announceDelegateToRelay`, `recordDelegateAnnounces` and `circuitRelayTargets`, with the same sentence in `strand-instance-manager.ts` (`beforeRedrive`) and `relay-reservation.ts`. `membership-connection-gater.ts` admits a peer it cannot place provisionally, and its reservation is admitted while the unauthorized-reservation budget (`MAX_UNAUTHORIZED_RELAY_RESERVATIONS`, 8) has room; `delegate-admission.ts` describes the grant as what spares a strand node from drawing on that budget. The reservation is refused only when the budget is spent.

### Strands

- **`isStrandSealed` in `strand-membership-writer.ts`.** Checked. Its JSDoc says `bootstrapFounderMembership` commits `Header`, `Member` and `Manager` "as three sequential statements". That function issues one `execStrandTransaction`.
- **`strand-peer-redial.ts` module comment.** Checked. It says FRET's maintenance pings open connections themselves (`dial: true`) under a fixed 2,000 ms limit. In FRET 1.3.0 (`../Fret/packages/fret/src/service/fret-service.ts`) the pings pass `dial: 'never'` and a separate `redial` opens connections under `FretConfig.dialTimeoutMs`; only the neighbour-announce fan-out still dials inside the ping budget. Whether the loop is still needed is a separate question this ticket does not answer; the comment's stated reason is no longer the code's.
- **`strand-transport-key.ts` on `MemberPeer`.** Checked. "Production code simply never writes one." `strand-membership-reconciler.ts` calls `registerMemberPeer` and `removeMemberPeer`.
- **`StrandFormationDisclosure.partyId` in `types.ts`.** Checked. Documented as "Initiator's party identifier" and optional. `StrandSolicitationService.formStrand` builds `{ ...disclosure, partyId: memberKey }`, so the caller's value is always replaced by the peer id of a key generated for that formation, and the `disclosure.partyId ?? this.partyId` fallback in `strand-formation-manager.ts` never takes its right-hand side.
- **`MemberPrivateKey` as a "read-gating secret".** Owned by `decide-what-the-closed-strand-read-secret-is-for` (in `tickets/blocked/`), which lists the comments and proposes replacement text. Do not rewrite these in this sweep ahead of that decision. One constraint for whoever does: the comments in `schemas/control.qsql` have a copy in `packages/cadre-core/src/control-schema.ts` that a drift spec compares comments included, so the two are edited identically.

### Node configuration (`packages/cadre-core/src/types.ts`)

- **`bootstrapPeers`.** Checked. "Only NativeScript stays ephemeral." `EdgeNode` opens a `PersistentBootstrapPeerStore` over the platform's node-local store, and `reference-app-ns/src/ns-edge-platform.ts` supplies one backed by SQLite.
- **`StorageConfig` and `CadreNodeConfig.storage`.** Checked. "Storage configuration for storage profile nodes" and "(only for storage profile)". `edge-node/config.ts` passes `storage` for a transaction-profile node, and `CadreNode` reads `config.storage.provider` for the control store on every profile.
- **`ArachnodeConfig`.** Checked. "Stub - will be implemented when arachnode is built." `../optimystic/packages/db-p2p/src/libp2p-node-base.ts` starts ring membership when `enableRingZulu` is true. `arachnode-stub.ts` in cadre-core says the same of itself; whether anything still uses that file belongs to `dead-code-cleanup-and-knip-gate`.

### Platform kits and the plugin

- **`secureStoreSlot` in `packages/cadre-rn/src/node-local.ts`.** Checked. The `NOTE:` and the module comment say a value past about 2,048 bytes "fails this write". `expo-secure-store` 14.2.4 logs a warning ("may not be stored successfully. In a future SDK version, this call may throw") and proceeds.
- **`build-browser.mjs` and `connect-browser.ts` in `packages/quereus-plugin-sereus`.** Checked. Both say the bundle makes no runtime import of `@quereus/quereus`. `dist/plugin-browser.js` contains such imports. `plugin-browser.ts` says to load the bundle through Quoomb Web's plugin URL field, which the package README now says does not work. The defect behind these comments is `bug-plugin-browser-bundle-imports-quereus-by-bare-name`; correct the comments with it.
- **`ops/docker/libp2p-infra/src/stun.ts`.** Checked. "See the relay README." `ops/docker/relay/README.md` no longer exists.

### Reported by one reader, not re-checked here

- `packages/cadre-host/src/bin/host.ts` (`--no-upnp` help) and `nat/external-ip.ts` say "UPnP/NAT-PMP"; only `upnpNat` is used (`feat-cadre-host-nat-pmp-mapping` is the open ticket for NAT-PMP; the `upnpEnabled` comment is covered by `debt-accepted-settings-nothing-reads`).
- `packages/reference-app-ns/src/chat-strand.ts` and `chat-operations.ts` headers say "Ported verbatim" from the React Native app; the two have diverged (see `bug-reference-app-ns-created-strand-is-never-published`).
- `packages/reference-app-rn/maestro/_setup.yaml` says the NativeScript run "stops at Create strand"; a reviewer found it fails earlier, at `btn-first-launch-join`.
- `packages/reference-app-ns/webpack.config.js` attributes a module rewrite to `metro.config.js`.
- `packages/cadre-provider/src/service/billing-service.ts` says storage metering "is blocked on the Arachnode storage ring", the same premise as the `ArachnodeConfig` arm.

Already owned elsewhere and left out: the `EdgeNodeStorage.offlineJournal` comment (`bug-edge-node-offline-mode-refusal-is-not-the-named-error`) and the header of `packages/reference-app-rn/drone.cadre.yaml` (`bug-rn-drone-config-describes-a-flow-that-cannot-work`).

## Expected result

- `yarn lint` fails on a ticket citation that resolves nowhere, with the file and the slug named, and `docs/contributing/gates.md` gains a section for the check that states what it cannot catch.
- The B1 and B2 citations are corrected or removed. Where a B1 comment says a gap is "owned by" a ticket that does not exist, the sweep has to find out whether the gap is still open, and file it if so, before deleting the reference.
- Each class A comment says what the code does, or is deleted.
