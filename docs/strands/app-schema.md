# App schemas: versions, upgrades and change notifications

A strand's members are separate parties that update their apps at different times. This doc says what happens when members run different versions of an sApp's `App` schema, what an app sees when a schema upgrade cannot be applied yet or ever, how `App` tables relate to the built-in `Strand` tables, and how an app is told that another machine changed a table. It is written for app developers first.

Neighbouring docs: [Writing an app schema](../schema-guide.md) · [Writing to a strand: durability and offline mode](writes.md) · [Strands: model and lifecycle](lifecycle.md) · [cadre-core API guide](../api.md)

Three terms recur. An app **claims** a strand when it calls `CadreNode.addStrand` with its sApp config, which is how a node learns the schema to apply. Every "claim" in this doc has that sense. It is not the flow in which an owner takes a node that belongs to nobody ([Claiming a node](../cadre/membership.md#claiming-a-node)). A **storage replica** is a node that runs a strand with no sApp config, so it serves the strand's blocks and applies no `App` schema. The **strand watcher** (`StrandWatcher`) is the cadre-core component that launches the strands the control database lists and retries launches that fail.

## What an app sets, reads and handles

Every name here is exported from `@serfab/cadre-core` unless the row says otherwise.

Options and calls:

| Name | What it does |
| --- | --- |
| `SAppConfig.schemaVersion` | Required whole number of at least 1. The app raises it with every change to its `App` schema. |
| `StrandDatabase.appSchemaState()` | `'applied'`, `'waiting-for-queue'`, `'waiting-for-cohort'` or `'failed'`. Check it before relying on new tables or columns. |
| `StrandInstance.sAppInfo` | Names the sApp version the strand was launched with, including while its schema apply waits. |
| `appSchemaRefusalOf(error)` | Returns the `AppSchemaRefusedError` an error is or wraps, else `undefined`. |
| `CadreNodeConfig.strandReactivity` | `{ enabled: true, strandIds? }`. Turns on change notifications on this node's strands. Off when absent. Also a cadre-cli config key. |
| `"optimystic.network_watch" = true` | Table tag in the app's schema. Marks a table whose watchers are woken by other machines' commits. |
| `StrandDatabase.watchTables(tables, onChange, options)` | Subscribes to changes in named strand tables. |

Events on `CadreNode`:

| Event | Payload | Emitted |
| --- | --- | --- |
| `strand:app-schema-deferred` | `{ strandId, waitingFor, transactionIds }` | When the database is published while its `App` schema apply waits. `waitingFor` is `'queue'` or `'cohort'`. |
| `strand:app-schema-applied` | `{ strandId }` | When a deferred apply lands. |
| `strand:error` | `{ strandId, error }` | Once for a launch refused with `AppSchemaRefusedError`; when a deferred apply fails; and after `strand:stopped` when a running member is superseded. |
| `strand:stopped` | `{ strandId }` | Whenever a strand stops on this machine. In this doc: a running member is stopped because the strand records a higher schema version. |

Errors:

| Error | Seen as | Meaning |
| --- | --- | --- |
| `AppSchemaRefusedError` | rejected `addStrand`, `strand:error` | The schema can never apply to the tables this node holds. `cause` is Quereus's error when it raised one. Not retried until the app calls `addStrand` again. |
| `AppSchemaOutdatedError` (`appSchemaVersion`, `strandSchemaVersion`) | rejected `addStrand`, `strand:error` | Subclass of `AppSchemaRefusedError`. A member has applied a higher schema version. The app must update. |
| `SchemaVerificationError` (`invalid schemaVersion`) | rejected `addStrand` | `schemaVersion` is not a whole number of at least 1. |

## App schema versions across a strand's members

An app declares the version of its `App` schema in `SAppConfig.schemaVersion` and raises the number with every change to the schema. A strand admits only members at the highest version any member has applied. A member on a lower version is refused with `AppSchemaOutdatedError`, and the app tells its user to update.

The rule exists because every connect applies the app's `App` schema as a full declarative diff. A version that lacks something a newer version added would try to drop it. On a two-member strand the newer member refuses that catalog write and the older member cannot open the strand. Where the older version's own machines can approve the drop, the newer version's column and its values are gone for every member.

### Every member on the same schema version

`schemaVersion` is separate from `version`, the app's release string, which may change without a schema change.

- **The number is required,** so a forgotten increment cannot go unnoticed behind a default.
- **The author's signature covers it,** together with the schema text and `version`, because a host must not choose it. A host that gave a signed schema a higher number than its author ever shipped would lock every other member out of the strand.
- **An invalid number is refused wherever the signature is checked,** with `SchemaVerificationError` (`invalid schemaVersion`), whether or not the node requires signed schemas.
- **The founder writes its number to `Strand.Header.sAppSchemaVersion`,** because the stored `sAppSignature` cannot be checked without it.

The strand records the highest version any member has applied in `Strand.AppSchemaVersion`, a one-row table whose value only rises and whose row cannot be deleted (`schemas/strand.qsql`). Every connect that applies an `App` schema reads it first (`applyAppSchema` in `@serfab/quereus-plugin-sereus`), and so does an app's claim on a running storage replica:

- **No version recorded, or a lower one:** the connect records its own, then applies its diff.
- **The same version:** it applies its diff, as it would with no record. A developer who changes the schema without raising the number still gets the full diff.
- **A higher one:** it applies nothing, writes nothing, and fails with `AppSchemaOutdatedError`, which carries the app's number and the strand's.

So during an upgrade, members that have not updated are locked out of the strand's app data until they do, and nothing they apply can remove what a newer version added. A member downgraded on the same machine is refused like any other.

Three design points:

- **The version is recorded before the apply.** `apply schema` commits the catalog in a batch of its own, so the record cannot share its commit. Recorded first, a member that connects between the two writes sees the new number over the old schema and is refused a moment early. Recorded afterwards, it would see the new schema under the old number, pass, and drop what was just added.
- **If the apply then never lands, the strand keeps the new number over the old schema.** Lower members stay locked out until the app ships a version that applies, which members at the new number need too. This failure locks members out; it never loses data.
- **The record is a row, not a catalog tag,** because a running member's catalog is the copy it loaded at connect, and a row is read live. The table is tagged `"optimystic.network_watch" = true`, so a node with [change notifications](#change-notifications) hears another member's record as it lands.

### A running member stops

A member that is already running when another member records a higher version is stopped. `CadreNode` emits `strand:stopped`, then `strand:error` with the `AppSchemaOutdatedError`, so an app tells its user to update when `error instanceof AppSchemaOutdatedError`. The next `addStrand`, which is the updated app's claim, launches the strand again through the version check.

The reason: such a member runs on the catalog it loaded at connect. Its updates rewrite rows without the newer columns and clear their values, with no error on either machine.

- **When the check runs.** Once its `App` schema is applied, a connection reads `Strand.AppSchemaVersion` on every watch wake of that table, 2 s after each peer connect of the strand node, and at least every 30 s (`AppSchemaVersionCheck` in `@serfab/quereus-plugin-sereus`).
- **What the stop keeps.** The strand's storage, saved network state and control rows stay, and the sApp config stays registered. The strand is suppressed in the strand watcher until the next `addStrand`, exactly as [a refused launch](#a-schema-that-can-never-apply-here-is-not-retried) leaves it.
- **A wake whose rebuild is refused stops the strand too.** A hibernating strand has no database and so no check, but its wake rebuilds the database and the version check refuses it. The strand is then stopped, not put back into hibernation for every later wake to be refused again.
- **Stopped, not demoted to a storage replica.** Apps run on phones and in browsers, which do not host strands no app has claimed, so a replica there would be a strand nothing asked for.
- **On a direct connection the host must close the database.** The plugin reports once through `SereusPluginResult.onAppSchemaSuperseded` and does not close the `Database`, which belongs to its host. Quereus has no read-only switch or pre-commit hook to refuse writes with.

### Direction: Quereus lenses

The same-version rule is a stopgap. The intended mechanism is Quereus's schema lenses (Quereus `docs/lens.md`, `docs/migration.md`). The `App` schema becomes a shared basis that only grows, and each app version keeps its own logical schema and lens over it, locally, never replicated. A newer version adds to the basis and maps its new shape through its lens; an older version keeps reading and writing through its own.

A member running a lens over `App` already works on a strand. What is not designed: how a basis change is proposed and agreed among members, how something is retired from the basis, how an app ships its lens, and materialized views kept for rows from other members (ticket `feat-app-schema-migration-through-lenses`).

## An app schema upgrade waits for the queue or the cohort

After an app update, a strand can open on the schema it had before, with the new schema applied later. This happens when the apply is refused for a reason that passes with time. The connect does not fail. An app that needs the new tables or columns checks first:

- **`StrandDatabase.appSchemaState()`** reads `'waiting-for-queue'` or `'waiting-for-cohort'` while the apply waits, `'applied'` once it lands, and `'failed'` if a retry failed for another reason. `StrandInstance.sAppInfo` names the new version throughout.
- **`strand:app-schema-deferred`** is emitted when the database is published, with `waitingFor` and, for the queue, the `transactionIds` that refused the apply (empty for the cohort).
- **`strand:app-schema-applied`** is emitted when a retry lands.
- **`strand:error`** is emitted when a retry fails for another reason, and the state stays `'failed'`. A retry that finds the strand at a higher version stops the strand instead ([A running member stops](#a-running-member-stops)). A retry cancelled by the database closing emits nothing.

The two refusals that pass with time:

| Refusal | Recognised by | Retried |
| --- | --- | --- |
| Queued offline transactions wrote a table whose row storage the apply changes (an index, a column). | `QueuedEntriesBlockSchemaChangeError` | Each time the queue drains, for as long as the queue is what refuses it. |
| The strand's cohort cannot be reached, as on a two-member strand whose other member is offline. | Optimystic's `classifyCommitFailure` says `cohort-unreachable`. | 2 s after the strand node connects to a peer; otherwise after 15 s, 30 s, 60 s, 120 s, then every 5 minutes. |

An apply needs the cohort because an apply that changes anything writes the strand's catalog, which is a strand collection like any table. The cohort case happens with offline mode on or off: the catalog write is not an app transaction, so the offline queue does not take it. A change that alters no row, such as adding a column tag, still writes the catalog.

### What the database runs while it waits

While the apply waits, the database runs the `App` schema it had. Quereus unwinds a refused apply, so a retry plans the whole change again.

- **The events begin at publication.** A retry that lands while the database is still behind the first-sync gate is not announced, because the app never saw the earlier schema. One that fails then is announced at publication.
- **The state names the first refusal.** A retry refused for the other reason keeps the state it had.
- **A waiting state can outlast its cause.** A retry never runs inside a transaction another caller holds open; it waits for that transaction to end. Applied inside it, the schema change would be committed or rolled back with the app's rows, and a rollback would leave a new index holding entries for rows that are gone.
- **`'applied'` can be true on this machine only.** Once a run of failed contacts marks the other member dead, the remaining member commits without it. The change is then in this machine's store, and the other member takes it when it returns.

### The version record waits the same way

The version record that a higher `schemaVersion` writes before its apply is deferred like the apply. While the queue lists transactions it waits for the queue without trying, because `Strand.AppSchemaVersion` is acknowledged by the network and the write would wait behind them while holding the database ([Membership writes are refused while transactions are queued](writes.md#membership-writes-are-refused-while-transactions-are-queued)). A record or a version read that cannot reach the cohort waits for the cohort.

Every retry reads the version again. A retry that finds another member has recorded a higher number fails with `AppSchemaOutdatedError`, and the connection reports the member as superseded.

### An apply that dropped a table or column

Quereus cannot undo a `drop table` or `drop column` step. After such an apply is refused, the database can already hold the new schema while the store holds the old one, and a retry would find no difference and report `applied` with nothing written. So when `diff schema App` is empty after a refusal, the refusal counts as a failure: the connect fails, or a retry settles `failed`. The next connect plans the change from the store. An upgrade that drops something therefore cannot open the strand until the cohort is reachable.

### A claim on a running storage replica is not deferred

`StrandDatabase.attachAppSchema` runs when an app claims a strand that this node already serves as a storage replica. A replica writes no app transactions, so nothing queued can have written an `App` table. A claim made while the cohort is unreachable fails at the claim. The replica's next rebuild applies the schema through the connect path, unless the schema was refused ([A schema that can never apply here is not retried](#a-schema-that-can-never-apply-here-is-not-retried)).

### On a direct connection

A host that calls `connectToStrand` itself reads the same facts from the connection's result (`SereusPluginResult` in `packages/quereus-plugin-sereus/src/types.ts`). `appSchemaWaitingFor` is `'queue'` or `'cohort'`, and `appSchemaDeferredBy` names the transactions the first refusal named. The `appSchema` promise never rejects. It settles `{ state: 'applied' }` at once when the apply succeeded at connect, `{ state: 'applied', deferred: true }` when a retry lands, `{ state: 'failed', error }` when one fails for another reason, or `{ state: 'cancelled' }` when the connection shuts down first.

### Alternatives rejected

- **Waiting before the connect returns** would withhold the strand from the app right after an app update, when a phone is most likely to be offline.
- **Failing the connect** would leave the queue unable to drain, because it drains only while the connection is up, and would leave a member that is alone after an update unable to open the strand at all.

## A schema that can never apply here is not retried

Some refusals do not pass with time. `addStrand` rejects with `AppSchemaRefusedError`, `CadreNode` emits one `strand:error`, and the node does not launch the strand again until the app calls `addStrand` again. `appSchemaRefusalOf(error)` finds the refusal through any wrapping error.

The refusals of this kind:

- **Quereus refuses the schema itself,** for example a syntax error.
- **The plugin refuses it:** a `seed` item, an item the Quereus parser skipped, or an invalid `schemaVersion`.
- **Quereus refuses it against the tables and rows this node holds,** such as a `not null` column with no default added to a table that has rows.
- **The strand records a higher version** (`AppSchemaOutdatedError`).

A deferred retry that ends in one of these settles `failed` with the same error.

### How a refusal is told from a fault

The refusal is typed when every error in the `cause` chain is a `QuereusError` whose code is one Quereus raises for such a refusal. A storage or network fault anywhere in the chain leaves the error untyped, and the launch is retried as any failed launch is. The list is of refusal codes, not fault codes, so a code Quereus adds later keeps being retried. The codes are `SCHEMA_REFUSAL_CODES` in `packages/quereus-plugin-sereus/src/app-schema.ts`.

### What the node does with a refused launch

- **The strand is not relaunched.** Each relaunch would start the strand node and compose the database only to fail at the same statement, which costs seconds of CPU on a phone. `CadreNode` suppresses the strand in the strand watcher (`StrandWatcher.suppressStrand`) and does not put it on the retry schedule.
- **The next `addStrand` lifts the suppression.** A claim is the only way the registered schema changes, so a different schema launches, and the same one makes one more attempt.
- **The refusal is not remembered across restarts.** Rows other members delete can let the schema apply, and a process start costs one attempt.
- **Overlapping calls.** When the app's claim and a watcher launch overlap, the call that started the launch carries the refusal and the other fails with "the launch this one waited on failed". If the waiting call was a claim with a different schema, the strand is not suppressed, because that schema has not been tried.
- **A storage replica keeps running.** Nothing else runs for a suppressed strand on this node, but a replica the claim tried to give the schema keeps running as a replica, and the watcher keeps tracking it so a party-wide removal still stops it.

### A refused claim leaves a storage replica as it was

A claim of a replica this node already runs first checks the schema's text with the plugin's `checkAppSchema`, which declares it on a throwaway Quereus database. A `seed` item, a skipped item, an invalid version or a syntax error therefore fails the claim whether the replica is live or hibernating. A live replica then applies the schema, and a refusal by its tables and rows fails the claim too. A refused claim leaves the replica's retained launch config without the sApp, so later rebuilds run the replica.

A hibernating replica, or a joiner whose database waits for a seed peer, has no database to apply to. Its `addStrand` call succeeds, and its next build is the first to meet a refusal by the rows. That build drops the sApp from the retained config and builds once more as the replica, and `StrandInstance.sAppInfo` goes back to unset. The claim stays registered, so the launch after a restart is refused and suppressed as any refused launch is.

A live apply that fails for a reason that may pass, such as the database closing mid-apply, keeps the sApp retained, and the next claim or build retries it.

## Same-named tables in Strand and App

An sApp may give a table the same name as a built-in strand table (`Member`, `Header`, `Invite` and so on). The two are stored separately and keep their own rows and columns, including across a restart.

Every strand database holds two engine schemas: `Strand`, the built-in membership tables ([`schemas/strand.qsql`](../../schemas/strand.qsql), embedded at runtime as `STRAND_SCHEMA`), and `App`, the sApp's own tables. Optimystic stores a table declared without an explicit `using optimystic('<uri>')` at `tree://default/<schema>/<Table>` and files its catalog record under its schema and name together. `Strand.Member` and `App.Member` are therefore different collections.

Apps address their own tables as `App.<Table>`. Quereus's `schema_path` defaults to `main`, so neither schema's tables resolve unqualified.

An explicit location still shares storage. An app table declared with the URI of a `Strand` table, or two app tables given the same explicit URI, open one collection and decode each other's rows. In a declared table the `using` clause goes before the column list; after it, Quereus skips the clause as an unrecognised item.

## Change notifications

By default a watcher on a strand table (`Database.watch`, or `StrandDatabase.watchTables`) wakes only on commits that this machine's own storage applies. A phone that stores none of a table's blocks is never woken by another machine's commit and has to poll. Optimystic's change notifications close that gap. Two things must both be true for a table:

- **The operator enabled it on the node.** `CadreNodeConfig.strandReactivity` (`strandReactivity` in a cadre-cli config file) is `{ enabled: true, strandIds?: [...] }`, and off when absent. The setting is local to the node: it is never read from the control database, a strand row or a peer.
- **The sApp tagged the table** with `"optimystic.network_watch" = true` in its declared schema. The key is quoted, and the value must be the boolean `true`.

```sql
table Message (
	Id text primary key,
	Body text
) with tags ("optimystic.network_watch" = true)
```

An sApp can ship the tag unconditionally. A tagged table on a node without the option logs one plugin warning and keeps local wakes only.

A strand node built with the option announces every commit whose collection log tail it applied, by originating a signed notification. A watched table on any machine with the option hears those announcements. A notification is a whole-table invalidation: watchers query again. A lost notification is bounded by a read of the collection's log tail at each registration renewal, every 30 s.

In [offline mode](writes.md#offline-mode) a watch also fires on a queued commit, which is a local commit, and on a refused transaction's removal from this machine's view.

### Which strands

- **`strandIds` absent or empty enables every strand this node runs,** storage replicas and joined strands included. Listing ids enables exactly those strands.
- **`strandIds` is independent of `strandFilter`.** `strandFilter` decides whether a strand runs on this node at all; `strandIds` decides which running strands get notifications.
- **Anything but the boolean `true` for `enabled` enables nothing,** and so does a `strandIds` that is not an array. This protects against a mistake in an embedder's configuration.
- **The setting is fixed when the strand's libp2p node is built.** A change takes effect at the next build: a restart, or the strand's next wake from hibernation.
- **The control node never gets it.**

### Enable it on every machine serving the strand

A notification tree is rooted at the machines that store a collection's log tail. A strand node built without the option neither announces commits whose tail it applied nor serves subscriptions as one of those machines. A watcher is therefore told of every commit only when the option is on every machine that serves the strand: the party's always-on storage nodes and the other parties' machines, as well as the phones.

### What a watcher sees

- **A commit is pushed to every registered watcher, including a machine outside the storage group of the table's log tail.** Such a machine exists when a strand has more machines than its cluster size ([Replication cluster size](../cadre/control-replication.md#replication-cluster-size)). It applies no tail, so only a push or the 30 s tail read can tell it.
- **A machine in the tail's storage group is woken by its own storage,** before the push arrives. The notification that follows wakes nothing new.
- **A table watched before its first commit registers at the first renewal tick after that commit,** up to 30 s later, because the watch service registers only once it has read a committed tail. Until then a commit reaches the watcher only through the tail read.
- **The first registration at a root is slower than later ones.** It is a cold start, and if it backs off it retries at the next 30 s tick.
- **Machines that register together are all admitted.** On a new strand every machine's watch opens at launch, so all of them register on the same renewal tick after the first commit.
- **For up to 5 s after a machine registers, a commit can be pushed to nobody.** A registration is held by the one tail-storing machine it lands on and reaches the others in that storage group by gossip every 5 s. A commit announced only by a machine that has not heard of the registration waits for the 30 s tail read.

### What enabling exposes

Enabling registers Optimystic's cohort-topic, reactivity and matchmaking protocol handlers on the strand node. Their protocol ids are Optimystic's fixed ones, not namespaced under `/optimystic/strand-<id>/`. That is harmless because each strand runs its own libp2p node.

- **Open strand:** any peer that can reach the node can open these protocols, as it already can the four database protocols (ticket `decide-public-read-only-strand-access`).
- **Closed strand, removed party:** the per-stream revoked-peer check (`authorizeStream` in `strand-revocation-enforcer.ts`) covers only the four database protocols (`repo`, `cluster`, `sync`, `block-transfer`), not these handlers. A removed party is kept off them by the connection gater, which refuses its connections and dials, and by the enforcer closing the connections it already holds ([Removing members](membership.md#removing-members)). Between a removal reaching this machine and that close, an open connection from a removed party's machine can still open these streams.
- **Closed strand, never a member:** a peer that was never a member is denied by neither layer, exactly as for the database protocols, because the check denies only on positive evidence of removal.

With the option off, both postures are unchanged.

### Known cost

- **Each watched table registers on every node build,** and every hibernation wake registers again. A cold-start registration carries one signature, a self-endorsement made with the strand node's peer key.
- **While idle, each renewal tick reads the log tails of all the strand's watched tables in one read.** A machine that holds those blocks answers it from its own store.
- **Registration renewals cost one request per watched table** whose registration is held by another machine.
- **Every strand node built with the option is a core notification host, whatever its node class.** A `device`-class phone is therefore eligible to forward notifications to other subscribers, and renews at the core interval of 30 s. The `NOTE:` in `strand-reactivity.ts` names the revisit condition.

## Limits and accepted tradeoffs

- **Members on an older schema version are locked out during an upgrade.** This is the cost of the same-version rule, accepted until lenses replace it (ticket `feat-app-schema-migration-through-lenses`).
- **Writes inside the detection window can still erase values.** A member's writes between another member's record and its own next check land on the old catalog. The window is as short as a notification with change notifications enabled, and up to 30 s without.
- **The offline queue is not held for a current version.** A member offline at the lower version keeps queuing, and its queue can drain on reconnect before the check sees the higher number, so a queued update rewrites rows without the newer columns. The check after a peer connect waits only 2 s (ticket `feat-offline-queue-waits-for-a-current-app-schema-version`).
- **A deferred version check opens the database on the catalog it loaded.** In offline mode the version read is served from this machine's own copy while the others are unreachable, so a member that has not seen a higher number opens, and is then subject to the running check.
- **Every member must run a Sereus release whose `Strand` schema declares `AppSchemaVersion`.** A release without it declares the `Strand` schema without the table, and `apply schema` drops a table its declaration lacks, removing the record and `Header.sAppSchemaVersion`.
- **A strand whose store has no version table gets one on its first connect, and that connect needs the cohort.** The `Strand` schema apply that creates the table is not deferred, so the connect fails while the member is alone and the host retries it. Two members inserting the first row before either has read the other's can fork the table's collection.
- **A versioned network name was rejected.** Putting the schema version into the strand's network name would split the strand into one network per version, each committing to the same blocks. A member that upgraded would hold blocks that diverged from the newer network's, and Optimystic cannot merge divergent histories. Refusing at connect keeps one network and one history.
- **An upgrade that drops a table or column cannot open the strand while the cohort is unreachable** ([An apply that dropped a table or column](#an-apply-that-dropped-a-table-or-column)).
- **A refusal first met at a hibernating replica's next build is not reported to the claim.** The app learns of it only from the log and from `sAppInfo` being unset. Failing the claim would mean waking a hibernating replica at claim time, and would still not cover a joiner waiting for a seed peer.
- **Explicit table locations are not checked for collisions.** Optimystic refuses two tables sharing one collection only once the collection holds rows, not at strand bring-up when both are empty. If sApps start declaring explicit locations, Sereus would need to check resolved URIs.
- **Change notifications are off by default and enabled in none of this repo's apps** (ticket `feat-reference-apps-watch-strand-changes`). Nodes started by cadre-host and cadre-provider cannot be given the setting (ticket `feat-cadre-host-and-provider-nodes-carry-strand-reactivity`).
- **Behaviour with the option on only some machines is not established.** What a watcher sees when some of the tail's storage machines lack the option is unverified; the renewal tail read should still bound the delay to 30 s.