description: The piece that connects a shared workspace to its database now also accepts a machine that stores nothing and reads and writes through other machines, instead of insisting on one that holds the workspace's data.
architecture: docs/strands/lifecycle.md#one-transactor-per-strand
files: packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/README.md
----

# What landed

`composeStrand`'s injected-node arm used to refuse any node that came without a `coordinatedRepo` (the handle a machine coordinates writes to its own blocks through). Optimystic 1.28.0 added a **client node** — built with `NodeOptions.servesBlocks: false`, it stores no blocks and therefore carries no `coordinatedRepo` at all — so that refusal blocked injecting one. It is now three arms, named by two small functions beside the composition (`isClientNode`, `injectedNodeRepo`):

- injected node that declares `servesBlocks: false` and no `coordinatedRepo` → registered with the factory with no repo; the transactor Optimystic then builds has no local store and sends every read and write to a remote coordinator.
- injected node that does not declare `servesBlocks: false`, with no `coordinatedRepo` → still refused, with the message reworded to say "block-serving". Deliberately not delegated to the factory's own `node.coordinatedRepo` default: a serving node that arrives without its repo was built wrong, and composing a remote-only transactor over it would read and write correctly while storing nothing.
- `coordinatedRepo` supplied **with** a client node → refused. It can only be another machine's repo, and writing through it would land the strand's blocks on a machine the strand does not think holds any.

The client test is `servesBlocks === false` explicitly: a node built by something other than `createLibp2pNode` declares neither attachment, and `!node.servesBlocks` would read it as a client.

Types widened to match: `Libp2pNodeWithRepo` (`src/types.ts`) carries `coordinatedRepo?: IRepo` plus `servesBlocks?: boolean`; the narrow `CollectionFactory` interface the composition declares takes `registerLibp2pNode(networkName, node, coordinatedRepo?)`, which is what upstream already accepts; `StrandConnectionBaseOptions.coordinatedRepo`'s doc comment no longer says "Required when libp2pNode is provided".

The node-**creating** arm is unchanged: it always builds a serving node and still throws if the created node has no repo.

README's options table splits the former combined `libp2pNode`, `coordinatedRepo` row into two, and the `coordinatedRepo` row states the required/refused rule.

Implemented by `ticket(implement): strand-plugin-takes-a-node-that-serves-no-blocks`; the review's own change is the decomposition noted below.

## Review findings

### Checked and found sound

- **The client test works at run time.** This was the one finding that would have made the whole ticket a no-op, so it was verified against upstream source rather than taken from the handoff: `libp2p-node-base.ts` builds its attachment object as `served ? { …, servesBlocks: true, coordinatedRepo, … } : { …, servesBlocks: false }` and `Object.assign`s it onto the node, and the built `dist` carries the same. A client node really does arrive declaring `servesBlocks: false`, so it takes the client arm rather than the serving arm's refusal.
- **The factory shim is not lying about upstream.** `pluginResult` is cast through `unknown`, so the narrow `CollectionFactory` interface is a claim the compiler cannot check against the real package — a widened signature there could have compiled while the installed build still required the repo. The shipped build is `registerLibp2pNode(networkName, node, coordinatedRepo = node.coordinatedRepo)`, so passing `undefined` falls through to the node's own (also `undefined` on a client). Correct.
- **Failure teardown.** Both new refusals throw inside the step-3 `try`, whose `catch` deletes the offline controller, releases the plugin and releases the storage-cache claim. `createdNode` is `null` on the injected path, so the factory is disposed and the caller's node is left running, which is what an injected node's contract says. `releaseOptimysticPlugin`'s comment about "a node created but not yet registered (a missing `coordinatedRepo`)" still describes the created arm, which is unchanged, so it was left alone.
- **No other site in the composition assumes the node holds blocks.** `peers = node` (a libp2p node either way), `options.cohortReachability` (registered separately, carried by a client like any node) and `options.storage` (reaches the plugin only on the `local` transactor) are all unaffected.
- **No regression in the existing specs.** `'should throw when libp2pNode is provided without coordinatedRepo'` asserts the prefix `coordinatedRepo is required`, which the reworded serving-node message still contains, and its mock node declares no `servesBlocks` — the foreign-node case, which must keep failing. It passes unchanged.

### Fixed in this pass

- **The guard was a cast plus two inline conditions inside an already-long function.** `composeStrand` is a numbered procedure of eight steps; adding twenty lines of branch and reasoning to step 3 put the rule nowhere a reader can find it by name, and `(node as Libp2pNodeWithRepo).servesBlocks === false` appeared as a bare cast at the one site that must never weaken it. Extracted to `isClientNode(node)` and `injectedNodeRepo(node, coordinatedRepo)` beside the composition: the "read it `=== false`, never `!servesBlocks`" reasoning now has one home, the log line reuses the predicate instead of re-deriving it, and the call site is two lines. Behaviour and both messages are unchanged.

### Routed elsewhere

- **The doc section this ticket names as its anchor carries a claim that a client node makes false.** `docs/strands/lifecycle.md` → "One transactor per strand" says a machine that is alone needs no second mode, because the cluster for every block on a machine that knows of no other member is the machine itself, so reads, writes, schema apply and the founder bootstrap commit with no network round trip. That holds only for a machine that holds blocks. Not corrected here, because no Sereus caller can build a client node yet and the docs describe the system as it is; appended as an arm to `implement/strand-node-that-holds-no-blocks`, whose doc TODO already owns that file but named only "What a launch does" and the limits section.

### No tickets filed, and why

No finding reached the filing bar. The two refusals are the only new behaviour, and both are misuse guards at one site that is already named in the next two tickets' `files:` — nothing class-level and nothing that serves a current-release anchor beyond what those tickets already carry. No tripwire was left either: the one conditional concern considered (a client node injected with `transactor: 'local'`, which would store locally the blocks it claims not to hold) is not a new class — injecting any node with the `local` transactor is the same nonsense today — so a `NOTE:` there would be noise.

### Tests

**None added, and none cut.** The client arm's end-to-end contract is owned by the next ticket's scenario (`strand-client-node-holds-no-blocks`: a client node reaching `connectToStrand` through `StrandDatabase`), which is the lowest layer that observes it; a unit test here would assert that a mock node with a field set reaches a mocked factory, which pins wiring.

The third arm (a repo supplied with a client node) will stay unverified by any test, which was weighed rather than overlooked. Making it unrepresentable in the type was considered and rejected: a node's class is a run-time attachment, and the caller that decides it — cadre-core, from a role — does not know statically which it built, so a discriminated `StrandConnectionOptions` could not be satisfied at the one call site that matters. A run-time refusal is the right shape, and a test over it would pin its wording.

## Validation run

- `yarn build` — clean (only the pre-existing dynamic/static import chunking warnings from the sibling `dist`s and the reference-app chunk-size warning).
- `yarn typecheck` — clean, including the three coverage guards and the stale-build-guard wiring check.
- `yarn lint` — clean, `check:docs` 66 files OK (re-run after the ticket edit).
- `yarn workspace @serfab/quereus-plugin-sereus test` — 14 files, 167 passed, 1 todo.
- `yarn workspace @serfab/cadre-core test` — 200 files, 2695 passed, 1 skipped. Run because cadre-core compiles and runs against the widened plugin surface; it always supplies a repo, so it takes the serving arm unchanged.

No pre-existing failures surfaced. No sibling repo was built, installed into or edited; `../optimystic`'s `dist` already carried `servesBlocks` and the stale-build guard did not complain.
