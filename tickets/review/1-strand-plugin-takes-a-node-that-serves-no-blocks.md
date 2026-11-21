description: The piece that connects a shared workspace to its database now also accepts a machine that stores nothing and reads and writes through other machines, instead of insisting on one that holds the workspace's data.
architecture: docs/strands/lifecycle.md#one-transactor-per-strand
files: packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/README.md
----

# What landed

`composeStrand`'s injected-node arm used to refuse any node that came without a `coordinatedRepo` (the handle a machine coordinates writes to its own blocks through). Optimystic 1.28.0 added a **client node** — built with `NodeOptions.servesBlocks: false`, it stores no blocks and therefore carries no `coordinatedRepo` at all — so that refusal blocked injecting one. It is now three arms:

- injected node with `servesBlocks === false` and no `coordinatedRepo` → registered with the factory with no repo; the transactor Optimystic then builds has no local store and sends every read and write to a remote coordinator.
- injected node with `servesBlocks !== false` and no `coordinatedRepo` → still refused, with the message reworded to say "block-serving". Deliberately not delegated to the factory's own `node.coordinatedRepo` default: a serving node that arrives without its repo was built wrong, and composing a remote-only transactor over it would read and write correctly while storing nothing.
- `coordinatedRepo` supplied **with** a client node → refused. It can only be another machine's repo, and writing through it would land the strand's blocks on a machine the strand does not think holds any.

The client test is `servesBlocks === false` explicitly, with a comment saying why: a node built by something other than `createLibp2pNode` declares neither field, and `!node.servesBlocks` would read it as a client.

Types widened to match:

- `Libp2pNodeWithRepo` (`src/types.ts`) — `coordinatedRepo?: IRepo` plus `servesBlocks?: boolean`, with a doc comment giving both reasons they are optional (a client carries neither; a foreign node carries nothing).
- The narrow `CollectionFactory` interface the composition declares — `registerLibp2pNode(networkName, node, coordinatedRepo?)`, which is what upstream already accepts.
- `StrandConnectionBaseOptions.coordinatedRepo`'s doc comment, which still said "Required when libp2pNode is provided".

The node-**creating** arm is unchanged: it always builds a serving node and still throws if the created node has no repo.

README's options table: the combined `libp2pNode`, `coordinatedRepo` row became two rows (the combined cell exceeded `check:docs`'s 50-word table-cell limit), and the `coordinatedRepo` row states the required/refused rule.

## Tests

**None added**, as the implement ticket specified. Both new arms are a two-line guard, and the surface is exercised end to end by the next ticket's integration scenario (`strand-node-that-holds-no-blocks`: a client node reaching `connectToStrand` through `StrandDatabase`). A unit test here would pin the guard's wording, not a behaviour.

## Validation run

- `yarn build` — clean (only the pre-existing dynamic/static import chunking warnings from the sibling `dist`s).
- `yarn typecheck` — clean.
- `yarn lint` — clean (after the README table-cell split above).
- `yarn workspace @serfab/quereus-plugin-sereus test` — 14 files, 167 passed, 1 todo.

No sibling repo was built, installed into, or edited. `../optimystic`'s `dist` already carries `servesBlocks`; the stale-build guard did not complain.

## What a reviewer should look at

- **No caller in this repo yet injects a client node.** The client arm is therefore unexercised at run time until `strand-node-that-holds-no-blocks` lands. The reviewer's judgement call is whether the three arms are the right division, not whether they are covered.
- **The refusal messages are new strings.** The existing spec `'should throw when libp2pNode is provided without coordinatedRepo'` (`test/plugin.spec.ts`) asserts the prefix `coordinatedRepo is required`, which the reworded serving-node message still contains, so it passes unchanged — its mock node declares no `servesBlocks` and so takes the serving arm, which is exactly the foreign-node case. Nothing else in the repo matches on either message. A host that wants to distinguish the two refusals programmatically would need typed errors, which this ticket did not add.
- **`releaseOptimysticPlugin`'s teardown comment** ("a node created but not yet registered (a missing `coordinatedRepo`)") describes the created-node arm only and was left as-is; that arm's refusal is unchanged.
