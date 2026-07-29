description: Two connection tests were skipping a required onboarding step, so the joining machine was correctly refused and the tests hung; both now add the joiner to the member list first, like real onboarding does, and the whole integration suite passes.
files: packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, tickets/.pre-existing-known.md, tickets/backlog/integration-test-harness-helper-consolidation.md
----

# Reader node vouched before it dials/seeds the owner

## What landed

Owner node **A** now vouches reader node **B** (`authorizePeer`) before B ever tries to
connect, in both control scenarios that previously omitted it:

- `control-write-while-alone-convergence.integration.ts` — in `bootPair`, right after
  `B.start()`.
- `control-cohort-auto-convergence.integration.ts` — before `A.createSeed()`, so B's
  cold-start seed dial lands with A's authorized set already containing B.

Why it was needed: A's inbound connection gate (`admitInboundControlConnection`,
`packages/cadre-core/src/cadre-node.ts`) admits an unvouched dialer only while A has
**zero** authorized members. Each scenario writes an unrelated third-party membership row
(`A.authorizePeer(X)`), which closes that cold-start carve-out — after which B's connect was
refused and the test hung to timeout. Production onboarding never hits this because every
helper in `seed-bootstrap.ts` (`addDrone` / `acceptPhone` / `addPhoneWithRelay`) vouches the
new node before minting it a seed; the sibling scenario
`control-db-two-node-convergence.integration.ts` already did the same. Both files' header doc
comments now explain the vouch and why it is a control-DB write rather than a dial.

Production code is untouched — this is a test-fidelity correction, not a behavior change.

## Review findings

**Checked:** the implement diff read cold before the handoff summary; the gate code the
scenarios depend on (`admitInboundControlConnection` + `admitControlPeerUnconditionally`)
read in full to confirm the diagnosis rather than take it on trust; both scenarios' stated
claims re-derived against the new code; the sibling scenario for divergence; existing
deny-path coverage; every doc that mentions these two scenarios; lint, typecheck, and the
full integration suite.

**Claim verification (the review focus the handoff asked for) — both claims hold:**

- `control-cohort-auto-convergence`'s "ZERO manual control dials" — `authorizePeer` writes a
  `CadrePeer` row; it opens no connection. The only dial is still `applySeed`'s production
  cold-start plus the in-node `reconcileControlCohort` cadence. Claim intact.
- `control-write-while-alone`'s "A genuinely alone at write time" — the
  `getConnections().length === 0` assertion is unchanged and still passes. It holds because
  the vouch names B by peer id only, so A's copy of B's row carries no multiaddr and A's
  cohort reconcile has nothing to dial. Verified deterministic, not lucky.

**Fixed in this pass (minor):**

- `control-cohort-auto-convergence.integration.ts` — the new vouch had been inserted *between*
  the "Production cold-start" comment and the `createSeed`/`applySeed` code that comment
  describes, leaving the comment eight lines from its subject. Moved the vouch above the
  comment block so each comment sits on its own code.
- `tickets/.pre-existing-known.md` — still listed both of these tests as known failures against
  `bug-control-cohort-no-auto-dial`, a ticket no longer on the board. Both now pass, so the two
  entries were stale and would have masked a future real regression in exactly these tests.
  Removed. The `strand-formation-e2e` and `push-wake-e2e` entries stay — their fix tickets are
  still open and both are intermittent.
- `tickets/backlog/integration-test-harness-helper-consolidation.md` — extended with the two
  scenarios and the now byte-identical `bootPair`, plus a note that this ticket is the concrete
  cost of the duplication (one copy had the vouch, two did not).

**Major (new tickets filed): none.** The one structural problem the diff exposes — three
control scenarios duplicating `wsTransports` / `nodeConfig` / `makeOwnOwner` / `randomPeerId` /
`connectControlNodes` / `bootPair` verbatim — is already tracked by
`backlog/integration-test-harness-helper-consolidation.md`, so it was updated rather than
re-filed as a duplicate.

**Tripwire (recorded, not ticketed):** the "A is alone at write time" assertion silently
depends on the vouch carrying no address for B. Parked as a `NOTE:` comment at the assertion
in `control-write-while-alone-convergence.integration.ts`, since that is where a future author
changing `authorizePeer`'s call site would meet it.

**Coverage:** no new test gap. The negative path these scenarios sidestep — an unvouched peer
being denied once the carve-out closes — is already asserted directly by
`membership-connection-gater.integration.ts` (outsider denied, member admitted, un-enrolled
node admits a stranger) and `control-stream-authz.integration.ts` (per-stream gate). Removing
either vouch now fails its scenario loudly rather than silently passing.

**Docs:** read `docs/architecture.md`'s convergence-status block (the paragraphs that cite both
scenarios by name) and the enrollment sequences. Both remain accurate — the diff changes no
production behavior, and the "zero manual control dials" wording the doc quotes is exactly the
claim re-verified above. No doc edit warranted; this is stated explicitly rather than left
silent.

## Verification

From `packages/integration-tests`:

- `npx eslint` on both changed files — clean.
- `npx tsc --noEmit -p .` — clean.
- `npx vitest run` (full suite) — **28 files / 117 tests, all passed**, 215s. Both previously
  failing control scenarios now pass in ~2.0s and ~0.7s (were 45s and 15s timeouts). The two
  intermittent known failures (`push-wake-e2e` stale-revision, `strand-formation-e2e`
  three-party) also passed this run; their fix tickets remain open and their
  `.pre-existing-known.md` entries were left in place.
- Re-ran lint plus the two scenario files after the review's own edits — still green.
