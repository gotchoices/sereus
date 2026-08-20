---
description: Four copies of the same test-node setup helper live in the integration test suite, so a bug in one has to be found and fixed in all four — which already happened once.
prereq:
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: easy
tradeoffs: The three copies work fine today and consolidating them touches 13 call sites across three long-running network suites, so a maintainer may reasonably decide the churn is not worth it until someone next has to fix the same bug in four places.
---

# One node-config builder for integration scenarios, not four

## What is duplicated

The integration test suite has a shared helper that builds a `CadreNodeConfig` for one test
node — `controlNodeConfig` in `packages/integration-tests/src/harness/node-fixtures.ts`. Three
scenario files nonetheless carry their own private `createTestNodeConfig` doing the same job:

| file | line | call sites | differs from the harness helper by |
|---|---|---|---|
| `rbac-signed-write.integration.ts` | 42 | 3 | nothing — a strict subset |
| `strand-formation-e2e.integration.ts` | 119 | 9 | nothing — byte-identical to the one above |
| `strand-membership-closed-strand-e2e.integration.ts` | 172 | 3 | takes a caller-supplied storage provider |

Measured with `grep -c "createTestNodeConfig(" <file>` on 2026-08-20.

## Why it is worth retiring

This is not a stylistic complaint. The duplication already produced a real defect, in all three
copies at once, and cost four separate edits to close.

Each builder forwards an optional `enableRelay` flag into the node's network config. All four
copies originally wrote it as `...(opts.enableRelay ? { enableRelay: true } : {})` — a
truthiness test, so a caller passing `enableRelay: false` had that `false` silently dropped and
got the profile default instead. For a storage-profile node the default is relay **on**, the
opposite of what the caller asked for. The harness copy was fixed under
`control-db-bring-up-runs-before-first-connection`; the three scenario copies stayed broken and
were fixed separately under `cold-start-redial-assertion-has-no-teeth`. Nothing links the four
sites, so nothing would have caught the next one.

The relay flag is not special. Every option these builders forward has the same exposure, and
the harness helper has since grown options — connection gater, reconcile cadence, relay
addresses, pinned owner keys, hibernation — that the three copies simply do not have, so a
scenario wanting one of them gets a fourth divergent copy rather than a shared improvement.

## The invariant that closes the class

One builder. Delete the three private copies and route their call sites through
`controlNodeConfig`. Then an option-forwarding bug is fixable in exactly one place, and a
scenario that needs a new option extends the one helper everybody already uses.

## What stands in the way today

Exactly one gap: `controlNodeConfig` hard-codes its storage provider (`MemoryRawStorage`, or a
delay-injecting wrapper when `storageOpDelayMs` is given, at `node-fixtures.ts:102-106`) and
offers no way to pass one in. `strand-membership-closed-strand-e2e.integration.ts` needs to
supply its own — each of its nodes gets a per-node storage capture whose factory becomes that
node's provider. So the helper needs an optional caller-supplied storage provider that wins over
the built-in default when present.

The remaining differences are mechanical: the copies are called positionally as
`createTestNodeConfig(partyId, opts)` while the harness helper takes a single options object
with `partyId` inside it.

## Expected outcome

- No `createTestNodeConfig` remains in `packages/integration-tests/src/scenarios/`.
- `controlNodeConfig` accepts a caller-supplied storage provider.
- The three suites (`rbac-signed-write`, `strand-formation-e2e`,
  `strand-membership-closed-strand-e2e`) pass unchanged — 30 tests between them, all green on
  2026-08-20, so any behavior change is a regression, not a discovery.
