----
description: The integration test suite has four copies of the same helper for setting up a test machine, and a bug in one has to be found and fixed in all four — which already happened once. Collapse them into the one shared copy.
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts
difficulty: medium
----

# One node-config builder for integration scenarios, not four

Absorbs the backlog ticket `debt-scenario-node-config-builders-duplicated` (filed 2026-08-20,
deleted into this one on 2026-09-07), plus a fourth copy that ticket did not know about. It is
promoted now because it is the prerequisite for the topology builder that the strand-scale
scenarios need — see `harness-topology-builder`.

## What is duplicated

The suite has a shared helper that builds a `CadreNodeConfig` for one test node —
`controlNodeConfig` in `packages/integration-tests/src/harness/node-fixtures.ts:121`. Four
scenario files nonetheless carry their own private builder doing the same job:

| file | line | call sites | differs from the harness helper by |
|---|---|---|---|
| `rbac-signed-write.integration.ts` | 42 | 3 | nothing — a strict subset |
| `strand-formation-e2e.integration.ts` | 119 | 8-9 | nothing — byte-identical to the one above |
| `strand-membership-closed-strand-e2e.integration.ts` | 190 | 3 | takes a caller-supplied storage provider |
| `multi-party-workflows.integration.ts` | (local `createNodeConfig`) | 6 | not listed in the original ticket; found 2026-09-07 |

The first three rows were measured with `grep -c "createTestNodeConfig(" <file>` on 2026-08-20;
the fourth was found on 2026-09-07 with call sites at `:178`, `:182`, `:279`, `:331`, `:403`,
`:467`. That file also carries its own `createMockProvisioner` (`:62`) and
`createMockUsageRecorder` (`:70`), which are worth the same treatment if they are duplicated
elsewhere — check before moving them.

## Why it is worth retiring

Not a stylistic complaint. The duplication already produced a real defect, in all four copies at
once, and cost four separate edits to close.

Each builder forwards an optional `enableRelay` flag into the node's network config. All four
copies originally wrote it as `...(opts.enableRelay ? { enableRelay: true } : {})` — a truthiness
test, so a caller passing `enableRelay: false` had that `false` silently dropped and got the
profile default instead. For a storage-profile node the default is relay **on**, the opposite of
what the caller asked for. The harness copy was fixed under
`control-db-bring-up-runs-before-first-connection`; the three scenario copies stayed broken and
were fixed separately under `cold-start-redial-assertion-has-no-teeth`. Nothing links the four
sites, so nothing would have caught the next one.

The relay flag is not special. Every option these builders forward has the same exposure, and the
harness helper has since grown options — connection gater, reconcile cadence, relay addresses,
pinned owner keys, hibernation, enrolled machines, strand filter — that the copies simply do not
have, so a scenario wanting one of them gets a fifth divergent copy rather than a shared
improvement.

## What stands in the way

Exactly one gap: `controlNodeConfig` hard-codes its storage provider (`MemoryRawStorage`, or a
delay-injecting wrapper when `storageOpDelayMs` is given, `node-fixtures.ts:126-130`) and offers
no way to pass one in. `strand-membership-closed-strand-e2e.integration.ts` needs to supply its
own — each of its nodes gets a per-node storage capture whose factory becomes that node's
provider. So the helper needs an optional caller-supplied storage provider that wins over the
built-in default when present.

The remaining differences are mechanical: the copies are called positionally as
`createTestNodeConfig(partyId, opts)` while the harness helper takes one options object with
`partyId` inside it.

## The second arm: node construction, not just node config

`bootPair` (`node-fixtures.ts:252`) and `bootConnectedPair` (`:319`) duplicate roughly eight
lines of node construction between them, and the site carries an explicit tripwire at
`node-fixtures.ts:304-309`: *"If a THIRD pair fixture lands, extract a shared node-construction
helper that takes the ordering as its argument."*

That condition has now tripped — `harness-topology-builder` is the third fixture. Do the
extraction here, in this ticket, while the change is small and the two existing callers are the
only ones to keep green. The ordering must become a parameter rather than being baked in, because
it changes what a resulting topology can prove: `bootPair` leaves the nodes unconnected so a
scenario can write while alone, `bootConnectedPair` connects first so a write broadcasts. The
distinction is spelled out at `node-fixtures.ts:291-300` and is load-bearing for the
write-while-alone convergence scenarios.

While in here, `stopStartedNodes` (`node-fixtures.ts:368`) is module-private and does the
reverse-order teardown any multi-node fixture needs. Export it.

## Edge cases & interactions

- **The storage-provider override must not change the default path.** Every existing caller that
  passes nothing must get byte-identical config to what it gets today, including the
  `storageOpDelayMs` wrapper branch.
- **Positional-to-object call conversion is where a silent behavior change hides.** A dropped or
  renamed option produces a node that boots fine and behaves differently. Convert one file at a
  time and run that file's suite before moving on.
- **Ordering as a parameter must not collapse the two orderings.** A fixture that connects before
  the caller can write would silently invalidate the write-while-alone scenarios, which would
  still pass — they would just no longer be testing what they claim.

## Expected outcome

- No private node-config builder remains in `packages/integration-tests/src/scenarios/`.
- `controlNodeConfig` accepts a caller-supplied storage provider.
- One node-construction helper behind both pair fixtures, with the ordering as an argument.
- `stopStartedNodes` exported.
- The four suites pass unchanged — 30 tests across the first three, all green on 2026-08-20, so
  any behavior change is a regression, not a discovery.
