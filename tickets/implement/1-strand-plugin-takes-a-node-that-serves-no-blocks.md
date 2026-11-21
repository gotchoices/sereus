description: The piece that connects a shared workspace to its database currently insists on being handed a machine that stores the workspace's data. Let it also take a machine that stores nothing and reads and writes through other machines instead.
architecture: docs/strands/lifecycle.md#one-transactor-per-strand
files: packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/README.md
difficulty: easy
----

# The strand composition takes a client node

`connectToStrand` is the one place a strand's libp2p node is handed to Optimystic's collection factory. It is given the node and the node's `coordinatedRepo` — the handle through which a machine coordinates writes to the blocks it holds. Optimystic 1.28.0 added a node that holds no blocks (a **client node**, `NodeOptions.servesBlocks: false`), and such a node has no `coordinatedRepo` at all. `connectToStrand` refuses it today:

```ts
if (!options.coordinatedRepo) {
  throw new Error('coordinatedRepo is required when libp2pNode is provided');
}
```

Upstream already accepts the shape: `CollectionFactory.registerLibp2pNode(networkName, node, coordinatedRepo?)` takes the repo as optional and defaults it from the node, and the transactor it then builds has no `localPeerId`, no local change notifier and no local store — every read and write goes to a remote coordinator. The refusal above is the only thing standing in the way, and it is what the next ticket (`strand-node-that-holds-no-blocks`) needs lifted before a cadre node can build such a node for a strand.

`StrandConnectionOptions.coordinatedRepo` is already optional in `packages/quereus-plugin-sereus/src/types.ts`, so this is a change to the composition's own check, not to the type.

## What the check should be

An injected node that **declares itself a client** needs no repo; an injected node that does not needs one, as before. The declaration is `servesBlocks: false` on the node, which is the field Optimystic's two attachment shapes are told apart by (`OptimysticNodeAttachments` / `OptimysticClientNodeAttachments` in `@optimystic/db-p2p`). So:

- `options.libp2pNode` with `servesBlocks === false` and no `coordinatedRepo`: register the node with no repo and carry on.
- `options.libp2pNode` with `servesBlocks !== false` and no `coordinatedRepo`: refuse, as now. Keep the refusal rather than letting the factory's `node.coordinatedRepo` default cover it — a serving node that reaches here without its repo was built wrong, and silently composing a remote-only transactor over it would read and write correctly while storing nothing, which is the bug this check was written to catch.
- A `coordinatedRepo` supplied **with** a client node: refuse. It can only be another node's repo, and a write through it would land blocks on a machine the strand does not think holds any.

The node type the composition carries (`Libp2pNodeWithRepo` in `packages/quereus-plugin-sereus/src/types.ts`) declares `coordinatedRepo: IRepo` as required. Widen it to optional alongside a `servesBlocks?: boolean`, so reading either faces the possibility that this node does not have it — the same reasoning the upstream `FactoryNode` type records. Keep the node-CREATING arm (`platform.createNode`, the plugin's own connect/e2e route) demanding a repo: that path always builds a serving node.

The narrow interface the composition declares for the factory must widen to match:

```ts
registerLibp2pNode(networkName: string, node: Libp2p, coordinatedRepo?: IRepo): void;
```

## Edge cases & interactions

- **The `resolvedTransactor !== 'test'` guard around the whole block.** A client node is a real node, so it takes the same arm; nothing about the unit-test fake changes. *By inspection.*
- **`peers = node`** (the `PeerConnectEvents` a deferred app-schema apply wakes on) is the libp2p node itself, which a client is. *By inspection.*
- **`options.cohortReachability`** is registered separately and is unaffected: a client node carries a reachability gate like any other. *By inspection.*
- **The browser connect (`connectToStrandBrowser`) and the SQL plugin config path (`parse-config.ts`)** inject no node and so never reach this check. *By inspection.*
- **A node that was built by something other than `createLibp2pNode`** carries neither `servesBlocks` nor `coordinatedRepo`. It must keep failing the serving arm's refusal, not fall into the client arm — so test `servesBlocks === false` explicitly, never `!node.servesBlocks`. *Pinned by the type (`servesBlocks?: boolean`) and by the explicit comparison; worth one line of comment at the site.*
- **Stop-on-failure.** The `createdNode` teardown comment ("Stopped again for a node created but not yet registered (a missing `coordinatedRepo`)") describes the created-node arm only, which is unchanged. An INJECTED node is the caller's to stop either way. *By inspection; fix the comment if the refusal's wording moves.*

## Tests

**None.** Both arms are a two-line guard over a surface the next ticket's integration scenario exercises end to end (a client node reaching `connectToStrand` through `StrandDatabase`), and the shape of what may be injected is carried by the widened type. A unit test here would pin the guard's wording, not a behaviour.

## TODO

- Widen `Libp2pNodeWithRepo` in `packages/quereus-plugin-sereus/src/types.ts`: `coordinatedRepo?: IRepo` plus `servesBlocks?: boolean`, with a doc comment saying why both are optional (a client carries neither, and a node not built by the factory carries nothing).
- Widen the factory interface the composition declares: `registerLibp2pNode(networkName, node, coordinatedRepo?)`.
- Replace the injected-node check in `compose-strand.ts` with the three arms above, each with its reason in a comment.
- Note the client arm in `packages/quereus-plugin-sereus/README.md` where the injected-node options are described: what a caller must pass for a node that serves no blocks.
- `yarn build`, `yarn typecheck`, `yarn lint`, and the `@serfab/quereus-plugin-sereus` unit suite.
- Do NOT build, install into or edit `../optimystic` (`tickets/rules/sibling-repos.md`). Its `dist` already carries `servesBlocks`; if the stale-build guard says otherwise, stop and record it.
