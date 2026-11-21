description: When a machine that stores none of a shared workspace's data opens that workspace with no other machine reachable, the attempt fails outright and is only retried minutes later. It should stay up and keep trying, the way a machine joining a workspace already waits for the members it needs.
prereq: strand-node-that-holds-no-blocks
architecture: docs/strands/lifecycle.md#retries
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/strand-database.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, docs/strands/lifecycle.md, docs/strands/writes.md
difficulty: medium
----

# A client strand launch waits for a serving machine instead of failing

A node that holds no strand blocks (`roles.strandCohortMember: false`, built by `strand-node-that-holds-no-blocks`) cannot bring a strand's database up with no serving machine reachable. `connectToStrand`'s schema apply writes the schema catalog, and on a client that write needs a remote coordinator; the founder bootstrap's membership writes need one too. With none reachable, `StrandDatabase.initialize()` throws.

`StrandInstanceManager.buildStrandDatabase` already has the right answer for this situation — it is the one a joining machine whose seed has not answered gets:

```ts
if (!isCohortUnreachableRead(error)) { throw error; }
await this.discardDatabaseAttempt(strandId, gate);
// …the runtime stays up, status 'syncing', and the database phase alone is retried
```

That arm does not catch a client's failure. A serving joiner with an unreachable seed gets a `BlockUnavailableError` with reason `cohort-unreachable`, which `isCohortUnreachableRead` matches. A client gets something else: its `findCluster` returns an **empty** cohort, so the block falls to `findCoordinator`, which waits out its bounded retry window and throws `FindCoordinatorError` (`NO_NETWORK_COORDINATOR` when the only peers it saw were unconfirmed or foreign, `NO_COORDINATOR_AVAILABLE` otherwise) — a plain `Error` from `@optimystic/db-p2p`, not a `BlockUnavailableError`.

So today the whole launch fails. The strand's record is discarded and `StrandWatcher` rebuilds from scratch on a doubling delay capped at five minutes, where the existing path would have kept the node up and retried the database phase alone every `UNREACHABLE_JOIN_RETRY_MS`. For a phone that opened the app on a train, five minutes of nothing versus a strand that comes up the moment the network returns.

## What to change

One predicate and one catch arm.

**The predicate.** `control-read-retry.ts` is where this repository's deliberately narrow `isCohortUnreachableRead` lives, with a module comment explaining that it is matched by TYPE (the typed error survives upstream's rewraps), walks the `cause` chain, and fails closed. Add a sibling beside it — a predicate for "no coordinator could be resolved for this block at all" — matching `FindCoordinatorError` by type over the same `causeChain`, with the same fail-closed residual recorded: a non-`Error`, a text-only copy, and an error built by a second loaded copy of `@optimystic/db-p2p` all answer false, and the caller throws as it did before.

Do **not** widen `isCohortUnreachableRead` itself. Its comment names the exact reasons it admits and warns against swapping it for upstream's wider same-named function; it has one other reader (`ControlDatabase.queryRevokedStamps`) that reads an unmatched block as "no revocations known", and admitting a new class there would change a security-relevant default.

The cause chain matters: `initialize()` runs the failure through Quereus's `db.exec`, which may wrap it. Walk the chain, as the existing predicate does.

**The catch arm.** In `buildStrandDatabase`, the two predicates together decide the `'awaiting-seed'` return. Everything downstream — `discardDatabaseAttempt`, the runtime staying up `'syncing'`, `deferUnreachableJoin`'s retry ladder, `retryUnreachableJoin` building a fresh `StrandDatabase` per attempt — is unchanged and already does the right thing. The log line there says "no seed peer has answered yet, so this joiner cannot build its database"; it needs to also fit a client with no serving machine reachable, and a founder (below).

## Founding on a client: it waits, it is not refused

A client that founds a strand must write `Strand.Header` through a coordinator, so founding needs a serving machine reachable. The alternative considered was refusing it outright, the way `StrandDatabase` refuses to found a storage replica. Waiting wins:

- It is **already what a founder gets** when its cohort is unreachable. `bootstrapFounder()` runs inside `initialize()`, so a founder's membership writes failing `cohort-unreachable` land in the same catch arm and retry. Routing a client's no-coordinator failure there makes a client founder behave like every other founder instead of inventing a second rule.
- Founding is **safe to repeat** (`docs/strands/lifecycle.md` → "Founding is safe to repeat"), which is what makes the retry sound: each attempt builds a fresh `StrandDatabase` and re-runs the bootstrap, which skips the rows already written.
- Refusing would be a **per-machine** rule that a party works around by founding from a different machine — which is the right deployment anyway (the organiser's always-on node founds the vote strand; the phones join as clients). Nothing is lost by letting the phone wait instead of throwing, and a party whose only machine is a client would be told "waiting" rather than "never", which is the truth: a serving machine appearing fixes it.

A founding that can never succeed — a party with no serving machine, ever — retries forever on the same ladder a joiner whose seed never answers does. State that in the docs; it is the existing shape, not a new one.

## What the app sees

- `addStrand` on a strand whose database could not be built waits (its `instance.database` is unset, so `isAwaitingFirstSync` is true) and rejects with the retryable `StrandAwaitingFirstSyncError` after `strandFirstSync.timeoutMs`. Nothing is torn down and the same call, made again once a serving machine is reachable, completes the attach. That is the existing contract for a gated joiner and it now covers a client too.
- The instance reports `'syncing'` until the database is built.
- In offline mode, a client that is up queues writes and they wait: the node's own reachability gate reads the empty cohort as `no-cohort` and answers closed, so nothing commits alone. A client whose database never came up has no queue to write into at all — the queue lives on the connection.

## Edge cases & interactions

- **Both `FindCoordinatorError` codes** route the same way; neither means "the block does not exist". *By inspection of the predicate.*
- **A serving node can also raise it** in principle, and routing it to the retry rather than to a failed launch is correct there too: a serving node's own `findCluster` always names itself, so this is unreachable for one in practice, and the retry is the safe direction if it ever is not. *By inspection.*
- **A failure that is NOT about reachability must still fail the launch.** A bad schema, a signature refusal, an `AppSchemaOutdatedError` — the predicate must not swallow any of them, which is what matching one error class by type buys. *By inspection; the fail-closed residual is written at the predicate.*
- **The retry must not leak a database or a gate.** `discardDatabaseAttempt` closes the attempt's database through its gate, and each retry registers a new one. Unchanged by this ticket, but the client path reaches it for the first time. *Covered by the scenario: the strand comes up after several failed attempts and the process exits clean.*
- **A stop or a quiesce during the retry ladder** is already handled — `deferUnreachableJoin` is armed only after the build settles and `releaseRuntime` clears it. *By inspection.*
- **The first-sync gate is not involved.** A client is treated as already synced (`strand-node-that-holds-no-blocks`), so the gate neither probes nor withholds; this ticket is only about the database phase failing to build at all. *By inspection.*

## Tests

**One test, added to the scenario the prerequisite creates** (`strand-client-node-holds-no-blocks.integration.ts`): start the client's strand with no serving machine reachable, assert the instance is up and `'syncing'` with no database, then start a serving machine and assert the strand becomes writable without the watcher's full rebuild and that a write then commits. That is the reproduction of this ticket's defect at the lowest layer that reproduces it — the behaviour is a branch in `buildStrandDatabase` over an error class, and a unit test over a hand-built `FindCoordinatorError` would pin the predicate's `instanceof` rather than the launch behaviour it exists to produce.

## TODO

- Add the no-coordinator predicate beside `isCohortUnreachableRead` in `packages/cadre-core/src/control-read-retry.ts`, matched by type over the `cause` chain, with its fail-closed residual and a line saying why `isCohortUnreachableRead` was not widened.
- Use it alongside `isCohortUnreachableRead` in `buildStrandDatabase`'s catch, and reword the log line to fit a client and a founder as well as a joiner.
- Check whether the `'awaiting-seed'` wording (the return value, `deferUnreachableJoin`, `retryUnreachableJoin`) still reads true for a client with no serving machine; rename or re-comment if it does not, but do not rename for its own sake.
- Extend the scenario with the launch-while-offline case above.
- `docs/strands/lifecycle.md` → "Retries": that a client whose serving machines are unreachable keeps its runtime up and retries the database phase, founding included, and that a party with no serving machine retries forever.
- `docs/strands/writes.md` → "Offline mode": that a client with no database built has no queue yet.
- `yarn build`, `yarn typecheck`, `yarn lint`, the `@serfab/cadre-core` unit suite, and the scenario.
- Do NOT build, install into or edit `../optimystic`, `../quereus` or `../Fret` (`tickets/rules/sibling-repos.md`).
