---
description: Relay-default flip in optimystic reference-peer + browser circuit-relay reservation wiring + e2e fixture cleanup. Lifts Tier 2 from 10/16 → 13/16; the three data-convergence specs that still fail are downstream of a cluster-supermajority issue uncovered after the dial fix, not the dial path itself. Spawns two follow-up fix tickets (cluster supermajority + reference-peer --cluster-size CLI) to capture the remaining gap.
files: ../optimystic/packages/reference-peer/src/cli.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/vite.config.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/README.md
---

## Summary

The implement stage flipped optimystic `reference-peer`'s `--relay` flag
to a default-on `--no-relay` opt-out (resolved via the new
`resolveEffectiveRelay()` helper), wired the browser's libp2p config to
listen on `/p2p-circuit` in distributed mode, deduped
`@multiformats/multiaddr` in `vite.config.ts` to fix a v12/v13 API drift
that was throwing out of the registrar's `_onPeerIdentify` and silently
killing the circuit-relay HOP topology, and corrected the e2e fixture's
network name + dropped the now-removed `--relay` arg. A read-only
`window.__optimystic` debug hook was added so Playwright can poll for
the `/p2p-circuit/p2p/<self>` multiaddr instead of guessing at timing.

Net outcome: Tier 2 e2e went from 10/16 → 13/16 (mode-flip ×2 and
bootstrap-persistence now pass); the three data-convergence specs
remain red, but on a different layer (cluster-coordinator
supermajority) than the original dial-availability failure.

## Review findings

### What was checked

- **Implementation diff** (commit `ea4f144`) — read all five changed
  files end-to-end, plus the uncommitted optimystic-side change in
  `../optimystic/packages/reference-peer/src/cli.ts`.
- **`resolveEffectiveRelay()` semantics** — confirmed that with
  commander's `.option('--no-relay', ...)`, `options.relay` defaults
  to `true` and becomes `false` only on explicit opt-out, so the
  `options.relay === false` guard correctly captures the opt-out
  intent. The inbound-listen heuristic (`tcp !== false` OR
  `wsPort` set) matches the documented "no inbound listen → off"
  rule.
- **Browser `listenAddrs: ['/p2p-circuit']` gating** — only set when
  `isDistributed` is true, so solo mode stays a no-op listener. The
  comment correctly identifies the AddressManager → transport-listen
  → `reserveRelay()` chain that this entry kicks off.
- **`vite.config.ts` dedupe** — confirmed the workaround is targeted
  (one package), reversible (drop the dedupe line), and the inline
  comment names the root cause precisely (gossipsub@14.x calling
  `tuples()` on a v13 multiaddr). It is the kind of change that
  should disappear when gossipsub catches up; left a note in the
  follow-ups about removing it then.
- **Downstream `--relay` callers** — searched the sereus repo and
  the optimystic repo for shell-out callers that pass `--relay` to
  `reference-peer`. None found in active code; only old completed
  tickets reference the old flag (purely historical). The breaking
  change is contained.
- **`__optimystic` debug hook surface** — exposes `getMultiaddrs`,
  `getPeerId`, `getConnectionCount`. All three are already visible on
  the `/diag` page, so the hook does not enlarge the attack surface.
  Left unconditional per implementer's reasoning (support
  debugging in production).
- **Lint / tests** — `yarn workspace @serfab/reference-app-web build`
  (which runs `tsc --noEmit && vite build`) succeeds end-to-end.
  `yarn workspace @optimystic/reference-peer test` → 4 passing.
  `yarn workspace @optimystic/db-p2p test` → 436 passing / 1 failing,
  but the failing test
  (`fresh-node-ddl-multi.spec.ts:116` — "Scenario B — 5-node cold-start
  with one peer down at boot") **also fails on un-stashed `main` HEAD
  of optimystic** without the implement-stage change applied. It's a
  pre-existing flake on optimystic main, not a regression introduced
  by this work.

### Findings — minor (no action this pass)

- The `logDebug('resolved relay default', { explicit: options.relay, ... })`
  log in `cli.ts` calls the value `explicit`, but with commander's
  `--no-relay` style `options.relay` is always a defined boolean,
  never undefined. The label is mildly misleading but the value is
  still useful for traces. **Not worth a churn.**
- The `window` typing in `optimystic.ts` uses
  `(window as unknown as { __optimystic?: unknown })` four times. A
  one-liner module-augmented interface would tighten this, but the
  three uses are all internal and inverted-control through a single
  hook surface, so the cost/benefit is negative. **Skipped.**
- `cluster-size`/`super-majority` mismatch in the browser
  (`clusterSize: 3`) vs service peers (`clusterSize: 10` default
  in `libp2p-node-base.js`) — **major**, see follow-ups.

### Findings — major (follow-up tickets filed)

- **Cluster-size CLI knob missing on reference-peer.** The
  e2e fixture cannot make the spawned service peers honour the
  browser's `clusterSize: 3` because `reference-peer` exposes no
  `--cluster-size` flag. Browser builds at 3; services default to 10.
  → spawned `tickets/fix/reference-peer-cluster-size-cli.md`.
- **Cluster-coordinator supermajority failure** in a 3-peer cluster
  with `0.67` threshold (`ceil(3 × 0.67) = 3`, no slack). Even with
  the cluster-size knob in place, a strict 3-of-3 supermajority is
  the wrong default for a 3-peer cluster. There is also a possible
  approval-counting bug in the merge step
  (`cluster-coordinator.js:206`) where all three promise-responses
  arrive but the merge reports `supermajority-failed` — worth a
  deeper dive. → spawned
  `tickets/fix/web-e2e-tier2-cluster-supermajority.md`.

### Findings — process / coordination (called out, not a ticket)

- **The optimystic-side CLI change is uncommitted in
  `../optimystic`.** The sereus implement commit (`ea4f144`) only
  ships sereus files; the actual `resolveEffectiveRelay()` logic
  lives in optimystic's working tree, has been built into
  `packages/reference-peer/dist/src/cli.js` locally (so the e2e
  fixture picks it up), but has **no** commit on optimystic `main`.
  Anyone cloning fresh, or CI without the link:-resolved sibling
  workspace pre-built, gets the old `--relay` behaviour and the
  e2e fixture's spawn-args will be rejected by the old CLI.
  → must be committed in optimystic before this work is reachable
  outside the implementer's working tree. The optimystic README
  (`../optimystic/packages/reference-peer/README.md`, lines 72/92/189)
  also still documents `-r, --relay` and must be updated in the same
  optimystic commit.

  The existing `tickets/complete/optimystic-uncommitted-connectivity-changes.md`
  is the same pattern (sereus tess ships a sereus commit while
  optimystic source sits dirty). Worth tracking in a single
  follow-up if a recurring pattern is forming, but not blocking
  here.

## Follow-up tickets created

- `tickets/fix/web-e2e-tier2-cluster-supermajority.md`
- `tickets/fix/reference-peer-cluster-size-cli.md`

## Tier 2 status going forward

- 10 Tier 1 passing.
- 13 / 16 Tier 2 passing (mode-flip ×2, bootstrap-persistence
  added by this ticket).
- 3 / 16 Tier 2 failing on cluster-coordinator supermajority, not
  on the dial path. Tracked in the two follow-up fix tickets above.
- `tickets/review/web-e2e-tier2-data-convergence.md` (the sibling
  review ticket that named this one as a prereq) is now unblocked
  and can be picked up by the runner next.

## End
