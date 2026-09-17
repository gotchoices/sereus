description: A record written by one machine before any other machine joined could not be read by the others, failing a push-wake test about four times in ten. The upstream database library fixed it; this ticket verified the fix and closed the tracking.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (scenario 4), packages/cadre-core/src/control-read-retry.ts, tickets/.pre-existing-known.md
repro: verified
----
# Closed: a block held by only one machine is readable again

## What was wrong

The owner machine writes its first control-database rows (for example the `OwnerKey` collection header) while it is alone, so it is the only machine holding those blocks. When another machine later coordinated a read of such a block, `@optimystic/db-p2p` read repair found exactly one peer claiming it (`cluster-fetch:no-quorum { responders: 1, required: 2 }`), refused to accept a single unconfirmed claim, and the read failed with `Block <id> is unavailable (claimed-elsewhere)`. Whether a run failed depended on which machine was nearest the block id, which is why it looked intermittent.

## What fixed it

Upstream, not in this repo, shipped in `@optimystic/db-p2p` 0.28.0:

- `1-mint-solo-cohort-commit-proof` (`1675b375`): a machine committing on a one-machine cohort signs a proof for the block.
- `single-signer-proof-outweighs-corroboration` (`64c65452`): a reader accepts that signed proof in place of a second holder.

The sereus peer-join catch-up (`control-network-peer-join-block-catch-up`, `50c39aa`) also narrows the window by pushing blocks to a newly joined member.

## Verification (2026-09-17)

- Whole-file `yarn workspace @serfab/integration-tests test src/scenarios/push-wake-e2e.integration.ts`: **15 of 15 green**, all four cases each run (the ticket's gate was five). One further run aborted at the stale-build guard while `../optimystic` was mid-rebuild and one was interrupted; neither ran the scenario.
- Three isolated `DEBUG='optimystic:db-p2p:*'` runs of scenario 4: all green, and each logs `cluster-fetch:certified-selected { blockId: 'default/cadrecontrol/OwnerKey', rev: 1, claimants: 1 }` followed by `certified-claims accept-unanchored … signers=1`. So the read now takes the single-signer proof path rather than winning a timing race. No `claimed-elsewhere` appeared.

## Board and code updates

- Removed the Open entry for this test from `tickets/.pre-existing-known.md`; added a Resolved entry.
- `control-read-retry.ts` (and its spec comment) still does not retry `claimed-elsewhere` — correct, since a repeat read cannot help — but the comment now says the measured cause is fixed, so a new occurrence is a new defect.
- `backlog/debt-revocation-ledger-marker-live-network-scenario` path reference updated to `complete/`.
- `fix/control-peer-row-refresh-invisible-to-third-node` named the same upstream site; it was not re-measured here.

## Review findings

- No code change was needed; verification only. The unsigned (`accept-unanchored`, `reason=no-recompute-capability`) acceptance is the upstream design choice for a lone signer and was not re-examined here.
