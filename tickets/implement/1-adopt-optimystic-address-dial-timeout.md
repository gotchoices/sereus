description: Require Optimystic 1.9.0, and have every sereus node give it connection time limits sized for the slowest relayed connection plus the time the relay and the called machine take to decide whether to admit it, so relayed connections on the slowest supported link stop timing out after 6 seconds (gotchoices/sereus#13).
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files:
  - package.json (root; `resolutions` stay `link:`), packages/{cadre-cli,cadre-core,cadre-rn,integration-tests,quereus-plugin-sereus,reference-app-ns,reference-app-rn,reference-app-web}/package.json (`@optimystic/*` ranges ^1.8.1 → ^1.9.0), yarn.lock
  - packages/cadre-core/src/link-budget.ts (new helper; module doc's "Optimystic's deadlines" table and the NOTE under it)
  - packages/cadre-core/src/cadre-node.ts (~1951-1957, control node options; ~3600 doc comment on `addressDialTimeout`)
  - packages/cadre-core/src/strand-instance-manager.ts (~758-814, strand node options)
  - packages/cadre-core/src/index.ts (~484, link-budget exports)
  - packages/cadre-core/src/types.ts (~495-501, `linkRoundTripMs` doc: `MAX_LINK_ROUND_TRIP_MS` figure)
  - packages/cadre-core/src/peer-dial.ts (module doc ~7), packages/cadre-core/src/strand-formation-protocol.ts (NOTE at `openFormationStream`, ~795), packages/cadre-core/src/control-write-retry.ts (~82, ~99 figures)
  - packages/cadre-core/test/link-budget.spec.ts (existing listener-limit containment test, ~68)
  - packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (~210-275 `LINK_DEADLINES` and derived bounds; per-`it` timeouts)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (~150-165 `armOf`, cadre arm; module doc table ~63)
  - docs/cadre-consistency.md ("Deadlines Over Optimystic's Reads and Commits"), docs/architecture.md (~103 silent-member figures, ~298 dial limits)
  - .release-notes.pending.md
  - ../optimystic/packages/db-p2p/src/rpc-deadline.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (~470-562 `connectionManager` / `rpcDeadlines` docs), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (~347-369) — read only
----
# Adopt Optimystic 1.9.0's dial limits, with sereus's admission decisions on top

## Background

kjeib measured on #13 that a relayed connection at 1 500 ms one-way delay is cut off 6.0 s into the dial: libp2p's fixed per-address limit (`connectionManager.addressDialTimeout`, 6 000 ms). Optimystic 1.9.0 (released 2026-10-01 and on npm for every `@optimystic/*` package) now derives that limit from `NodeOptions.linkRoundTripMs` and lets a host override it, and adds `NodeOptions.rpcDeadlines` for its own RPC dial deadline. Sereus's libp2p family is already on the 3.3 line (`typecheck-fails-on-libp2p-interface-3-1-against-linked-optimystic-3-3`), and the tests already run against the linked 1.9.0 source; only the declared floors are behind, which is why `yarn check:published` fails at master (npm 1.8.1 lacks `inboundUpgradeTimeoutMs`, used at `cadre-core/test/link-budget.spec.ts:75` and `relayed-dial-cost-by-latency.integration.ts:158`).

## What Optimystic 1.9.0 derives (r = `linkRoundTripMs`)

From `resolveLinkDeadlines` in `db-p2p/src/rpc-deadline.ts` (all exported from `@optimystic/db-p2p`):

- libp2p `addressDialTimeout`: max(6 000, 10 r). Ten round trips cover a relayed dial that must first open its connection to the relay (about 8.6 r over WebSocket, 9.6 r over `wss`) with a margin. It contains **no time for admission decisions**.
- libp2p `dialTimeout`: max(10 000, 10 r).
- libp2p `inboundUpgradeTimeout`: max(10 000, 5 r).
- RPC dial (`dialTimeoutMs`): max(3 000, 11 r), the connection open plus one round trip of stream negotiation.
- RPC response: max(10 000, 3 r).
- From the RPC dial, after any `rpcDeadlines` override: transfer max(30 000, dial); transaction budget max(30 000, 4 × dial). The Quereus plugin (`collection-factory.ts`) reads `node.linkDeadlines` and also sets the cancel budget `abortOrCancelTimeoutMs` = max(5 000, dial).

## Decision: cadre states three limits explicitly

Agreed with Optimystic on 2026-10-01: Optimystic's limits are link time only. Sereus adds the time its own connection gates take, which runs on the dialer's clock: up to `ADMISSION_DECISION_TIMEOUT_MS` (2 000 ms) at a party-run relay (`denyInboundEncryptedConnection` on the dialer's connection to it) and again at the called machine. So cadre passes, on the control node and every strand node:

| option | value | at the default r = 3 500 | before (1.8.1) |
| --- | --- | --- | --- |
| `connectionManager.addressDialTimeout` | Optimystic's `addressDialTimeoutMs` + 2 decisions | 39 000 ms | 6 000 ms (libp2p) |
| `connectionManager.dialTimeout` | Optimystic's `libp2pDialTimeoutMs` + 2 decisions | 39 000 ms | 17 500 ms |
| `rpcDeadlines.dialTimeoutMs` | Optimystic's `dialTimeoutMs` + 2 decisions | 42 500 ms | 21 000 ms |

`inboundUpgradeTimeout` stays Optimystic's derivation (17 500 ms at the default). The listener's timer covers only its own upgrade and its own decision, never a relay connection the dialer opened first, and `link-budget.spec.ts` already pins it at or above `relayedDialBudgetMs` at every declaration. The RPC response deadline also stays derived.

The helper builds on Optimystic's own `resolveLinkDeadlines`, so a later change to Optimystic's round-trip counts flows through without a restated constant:

```ts
// link-budget.ts
import { resolveLinkDeadlines, type Libp2pConnectionTimeouts, type RpcDeadlineDefaults } from '@optimystic/db-p2p';

/** Admission decisions a cold relayed dial may wait on: the relay's, then the called machine's. */
export const DIAL_ADMISSION_DECISIONS = 2;

export interface OptimysticDialLimits {
	connectionManager: Required<Pick<Libp2pConnectionTimeouts, 'addressDialTimeout' | 'dialTimeout'>>;
	rpcDeadlines: Pick<RpcDeadlineDefaults, 'dialTimeoutMs'>;
}

export function optimysticDialLimits(linkRoundTripMs?: number): OptimysticDialLimits {
	const derived = resolveLinkDeadlines(resolveLinkRoundTripMs(linkRoundTripMs));
	const decisionsMs = DIAL_ADMISSION_DECISIONS * ADMISSION_DECISION_TIMEOUT_MS;
	return {
		connectionManager: {
			addressDialTimeout: derived.addressDialTimeoutMs + decisionsMs,
			dialTimeout: derived.libp2pDialTimeoutMs + decisionsMs
		},
		rpcDeadlines: { dialTimeoutMs: derived.dialTimeoutMs + decisionsMs }
	};
}
```

Spread `...optimysticDialLimits(network?.linkRoundTripMs)` next to the existing `linkRoundTripMs:` line in both node builders (`cadre-node.ts` ~1957, `strand-instance-manager.ts` ~814), and export the helper and constant from `index.ts`'s link-budget block (the integration scenario needs them). Check that `link-budget.ts` importing `@optimystic/db-p2p` adds no import cycle and nothing to a bundle that did not already carry `db-p2p` (every importer of `link-budget.ts` is already inside cadre-core, which imports `db-p2p`).

### Consequences, accepted

- **A failing control write now holds the control write lock for about 84 s, not 63 s.** The cancel budget becomes 42 500 ms, above two 21 000 ms response rounds, so the cancel discharge runs three rounds: one pend round + three cancel rounds = 4 × 21 s. A write queued behind one failing write settles after about 168 s. The transaction budget becomes 170 000 ms. These are the price of an RPC dial that contains a cold relayed open through two gates; a shorter dial would fail good dials at the supported link instead. Record the new figures; do not tune around the 42 s threshold.
- **A dial to a machine that is gone waits longer**: up to 39 s per address inside libp2p and 42.5 s per Optimystic request, where 1.8.1 gave 6 s and 21 s. At a small declared round trip the floors still get the 4 s: r = 100 gives 10 000 ms per address and a 7 000 ms RPC dial.
- **The largest accepted `linkRoundTripMs` falls to about 10.8 h.** Optimystic refuses a round trip above `MAX_LINK_ROUND_TRIP_MS` (about 13.3 h in 1.9.0; it was about 1.66 days) and an RPC dial above `MAX_RPC_DIAL_TIMEOUT_MS` (about 4.97 days). Cadre's stated dial (11 r + 4 000) reaches the second first, at about 39 044 000 ms, and Optimystic's error then names `rpcDeadlines.dialTimeoutMs`. Accepted without a cadre-side check: no real link is near it. Say so in the `types.ts` doc.

### Strand-formation dial: keep `dialMs`, update the NOTE

`openFormationStream` passes one machine's whole address list to one `dialProtocol` under `formationDeadlines().dialMs` (5 r + 2 000, 19 500 ms at the default). libp2p tries the addresses one at a time, and its per-address limit (now 10 r + 4 000) is longer than `dialMs` at every declaration, so an address that never answers uses the whole formation dial and the join moves on to the party's next machine (`dialFormationByMachine`). An address that is refused fails fast and still hands over. This was already the case against linked 1.9.0 (35 s per address). Do not change `dialMs`: a budget per address would overrun the session or shrink the await-response budget, as the existing NOTE says. Rewrite the NOTE to state the new relationship (the per-address limit no longer cuts a hung address off inside the formation dial) and keep its revisit condition: if joins through a hung first address are seen, give each address a sub-budget or dial them in parallel. Correct the matching sentence in `.release-notes.pending.md` ("Joining a strand tries every address in the invitation"), which still says "whichever comes first".

### Out of scope here

- Cadre's own dial budgets (`relayedDialBudgetMs` = 4 r + one decision, `peer-dial.ts` per-address 16 s, formation `dialMs`) do not count opening the relay connection or the relay's decision. Owned by `fix/bug-relayed-dial-budget-omits-opening-the-relay-connection`, which waits on this ticket. The limits stated here are larger than those budgets, so cadre's own signals still govern those dials.
- Nodes built outside cadre-core (`quereus-plugin-sereus`'s `connect.ts` / `connect-browser.ts`, the harness's `test-party.ts`) state no link and get none of this. Appended as an arm to `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults`. Relays need nothing: a relay serves a circuit over the target's existing reservation connection and does not dial.

## Edge cases & interactions

- **Both node builders get the same values** (control and strand), from the same declaration. Verify by inspection; both sites already share `resolveLinkRoundTripMs(network?.linkRoundTripMs)`.
- **An invalid declaration still fails at start, with cadre's message.** `optimysticDialLimits` calls `resolveLinkRoundTripMs` before `resolveLinkDeadlines`, so a zero or `NaN` throws cadre's `network.linkRoundTripMs must be…` error, not Optimystic's. A value above `MAX_LINK_ROUND_TRIP_MS` throws from `resolveLinkDeadlines` inside the helper, which runs during node option assembly, the same start that failed before. Verify by inspection.
- **`dialTimeout` ≥ `addressDialTimeout`** (Optimystic's doc: otherwise the first cuts off what the second allows). Holds by construction (same addition to 10 r with floors 10 000 ≥ 6 000). Inspection.
- **The listener limit still contains cadre's relayed dial.** The existing `link-budget.spec.ts` test ("gets a listener limit from Optimystic that outlasts cadre's relayed dial") stays as is; it must still pass.
- **Degraded-cohort scenario derives from the dial nodes really use.** Its `LINK_DEADLINES` must become `resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS, optimysticDialLimits().rpcDeadlines)`, as its own NOTE asks. Then `STALLED_CANCEL_ROUNDS` = 3, failure 84 s, settle 168 s, ceiling 189 s, hang deadline 210 s. Re-sum each stalled `it`'s labelled deadlines against its fixed timeout (240 000 / 300 000 / 120 000 …) and raise any timeout the sum now exceeds, so a hang still reports its labelled error. Update the figures in its comments (63, 126, 154, 38.5). The `MAX_CANCEL_ROUNDS` NOTE (binds above a 126 s dial) is still not reached. Verified by running the scenario.
- **The latency instrument's cadre arm** (`relayed-dial-cost-by-latency.integration.ts`) claims to read exactly what a node gets. Give the `cadre-core declared` arm the helper's `connectionManager` values (adding `addressDialTimeout`) and its RPC dial, and leave the `db-p2p fallback` arm on `resolveLinkDeadlines()`. Opt-in, so verified by typecheck only; update its doc table row (~63).
- **Lint guard** (`LINK_DEADLINE_GUARD`): the helper's values are derivations, not literals, so it needs no directive. `yarn lint` verifies.
- **Lockfile**: `yarn upgrade:optimystic` (runs `ncu`, `yarn install`, `check:dep-ranges`) or the manual equivalent. `resolutions` stay `link:`. Never build or install inside `../optimystic`.

## Docs and comments to correct (numbers at the default declaration)

- `link-budget.ts` module doc, "Optimystic's deadlines, from the same declaration": rewrite the table for 1.9.0 plus cadre's three stated values (per-address 39 000, libp2p dial 39 000, inbound 17 500, request dial 42 500, response 10 500, transfer 42 500), say why cadre states three of them (the admission decisions), and update the "longer deadlines are paid against a machine that is gone" NOTE (21 000 → 42 500, and the 63 s → 84 s write). The paragraph about libp2p's two limits should now cover only the listener's `inboundUpgradeTimeout`.
- `docs/cadre-consistency.md` → "Deadlines Over Optimystic's Reads and Commits": transaction 170 000, cancel 42 500, three cancel rounds, about 84 s per failing write, about 168 s queued; the "Every dial into a gated node" bullet now names the three stated limits and the two decisions.
- `docs/architecture.md` ~103 (63 s, "two cancel rounds") and ~298 (Optimystic "sizes it for a cold relayed open" → cadre states it, cold open plus two decisions, 39 s).
- `control-write-retry.ts` ~82 and ~99, `peer-dial.ts` module doc ~7, `cadre-node.ts` ~3604: same figures and wording. Grep `addressDialTimeout`, `38.5`, `38 500`, `63 s`, `154` in `packages/*/src`, `packages/integration-tests/src` and `docs/` for any other site.
- `types.ts` ~501: the ceiling paragraph above.

## Tests

No new test. The helper is three additions on top of Optimystic's derivation, and its relationships hold by construction. The existing listener-containment spec and the degraded-cohort scenario cover what can break.

## TODO

- Raise every `@optimystic/*` range from `^1.8.1` to `^1.9.0` (eight `packages/*/package.json`), update `yarn.lock`, run `yarn check:dep-ranges`.
- Add `DIAL_ADMISSION_DECISIONS` and `optimysticDialLimits` to `link-budget.ts`; export both from `index.ts`.
- Spread the helper's values into the control node options (`cadre-node.ts`) and the strand node options (`strand-instance-manager.ts`).
- Point the degraded-cohort scenario's `LINK_DEADLINES` at the stated RPC dial, re-sum its per-`it` timeouts, and update its figures; update the latency instrument's cadre arm.
- Rewrite the `openFormationStream` NOTE and fix the pending release note's "whichever comes first" sentence.
- Correct the docs and comments listed above, including `types.ts`'s ceiling.
- Add a release-note section to `.release-notes.pending.md`: `@optimystic/*` 1.9.0 is the minimum; the three stated limits and what they were; a failing control write now holds the write lock about 84 s; `linkRoundTripMs` now accepted up to about 10.8 h.
- Validate: `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn lint`, `yarn workspace @serfab/cadre-core test`, then the degraded-cohort scenario on its own (`yarn workspace @serfab/integration-tests exec vitest run control-write-degraded-cohort-member`; expect stalled failure about 84 s, settle about 168 s). Run `yarn check:published --skip-gates`. The full `yarn check:published` is not runnable inside a ticket (docs/testing.md); say in the handoff that it should now pass against npm 1.9.0 and is the maintainer's to run before release.
- Draft the #13 follow-up as `tickets/blocked/report-issue-13-address-dial-timeout-rerun.md` (form of `complete/report-issue-13-ping-timeout-reply.md`): ask kjeib to re-run at 1 500 ms one-way without their `node_modules` patch, on master after this lands or on the next published release, stating the new per-address limit (39 s at the default) and that #13 closes on a pass. Posting is the maintainer's call.
