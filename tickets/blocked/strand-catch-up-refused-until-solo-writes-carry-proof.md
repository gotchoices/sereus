----
description: When someone starts a shared workspace on one device and a second device joins, the second device is refused every piece of data the first one wrote — the shared database library now requires a signed receipt on transferred data, and data written while only one device existed never gets one. The fix has to land in that library, not here.
files: packages/cadre-core/src/strand-backfill.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime — the strand node's createLibp2pNode options), ../optimystic/packages/db-p2p/src/cluster/block-transfer-service.ts (handlePush, requirePushCertificate), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (commit), ../optimystic/tickets/fix/1-solo-cohort-commits-mint-no-proof.md
repro: verified
----

**Blocked category (b): a dependency outside this repo.** What unblocks it: an `@optimystic/db-p2p`
release in which a commit made against a cohort of one retains a commit proof — tracked upstream as
`fix/1-solo-cohort-commits-mint-no-proof` in `../optimystic`, direction already decided (mint a real
one-peer proof; do not weaken the receiver). Bump the dependency, re-run the scenario below, and
close this.

# Peer-join catch-up delivers nothing a founder wrote alone

## What a user sees

Two devices, one strand. The founder creates it and writes the founding membership rows. The second
device joins and connects. It receives **none** of the founder's blocks — not slowly, not partially:
every one is refused. Offline reads on the joiner then fail too, because it never held the data.

## Why

`@optimystic/db-p2p`'s block-transfer receiver now requires a cohort commit proof on every pushed
block (`requirePushCertificate`, default `true`). Proofs are minted only when a write goes through
cluster consensus. A founder writing alone has a cohort of one, so its writes bypass consensus and
retain no proof — and no later step can manufacture one, because the signatures never existed.

`StrandBackfill` (`packages/cadre-core/src/strand-backfill.ts`) is correct as written: it reads the
proof for exactly the revision it pushes and ships what it finds. There is nothing for it to find.

## Measured, 2026-09-01

A two-node probe (real `CadreNode`s, real libp2p) inspecting `getBlockProof` for every block:

| stage | blocks holding a retained proof |
| --- | --- |
| founder after strand bootstrap (solo) | **0 of 18** |
| founder after the joiner attached and a further write landed | **0 of 21** |

In `strand-membership-closed-strand-e2e`, the founder offers 15–21 blocks per peer and the joiner
accepts 3; all 74 observed rejections logged `push:reject-uncertified … reason=no-proof`.

Two tests in that scenario fail deterministically as a result:

- "replicates the founder's blocks PHYSICALLY into the joiner's own block store"
- "serves the strand's founding membership from the joiner alone after the founder stops"

Both are also listed in `tickets/.pre-existing-known.md` against the older, intermittent
`strand-unique-index-sync-stale-revision` fingerprint. **That is a different defect at the same
tests** — the failure recorded there is a `PartialCommitError` / stale-revision sync fault; this one
is a deterministic transfer refusal with a distinct log line. Do not fold them together.

## What NOT to do here

Setting `blockTransfer.requirePushCertificate: false` on strand nodes would make the tests pass and
open a hole. Strand nodes today pass **no** `authorizeInboundStream` and **no** membership
connection gater (`buildStrandRuntime` threads only a caller-supplied gater into
`createLibp2pNode`), so the push certificate is currently the only thing preventing an arbitrary
dialer that knows the strand's protocol prefix from writing blocks into a member's store. If that
flag is ever wanted as a stopgap, strand-node inbound stream authorization has to land in the same
change — not after it.

## Verification once the dependency lands

```
cd packages/integration-tests
yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts
```

Expect the two tests above to pass. If they still fail, check the log line: `reason=no-proof` means
the upstream fix did not reach the solo path; any other `reason=` means the proof is arriving but
not verifying, which is a new question.
