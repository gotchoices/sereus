description: During a QR claim, the claiming owner's connection to the unclaimed node's placeholder control node may be counted as a connection to its own party's control network, which would end its "writing while alone" state early and could drop the claimed node's row from the queue of writes it re-sends once a sibling is reachable.
architecture: docs/architecture.md#writes-made-while-alone
files: packages/cadre-core/src/cadre-node.ts (control-connection counting ~4521 and ~7970; first-connection drain ~4599/~4626/~4761; `vouchPeer` ~8741), packages/cadre-core/src/seed-bootstrap.ts
repro: static
severity: lost-write
likelihood: unusual
tradeoffs: Inferred from reading the code during a message-cost survey, not observed; the claimed node usually receives the owner's whole store by backfill after it restarts, which may carry the row anyway, so the visible effect may be nil.
----
# The seed connection may count as a control connection

Found while tracing the QR claim path for `message-cost-accounting` (static, 2026-10-19). Not reproduced.

## What the code suggests

A claim has the owner A dial the unclaimed node B to deliver a seed (`/sereus/seed/1.0.0`). B at that moment runs a placeholder control node under a placeholder party. A's check for "do I have a control connection" (`cadre-node.ts` ~4521, ~7970) appears to count any connection on its control libp2p node, which would include this one. If so:

- A leaves its "writes made while alone" state as soon as the seed connection opens, and runs its first-connection drain.
- The drain's re-sends go to a cohort whose only other peer is a node on a different network that cannot take them.
- The vouch for B written during the claim could be dropped from the re-send queue as if delivered.

## To confirm

Run the node-claim scenario with `DEBUG='sereus:cadre:*'` and look for the first-connection drain starting while only the seed connection is open; or write a cadre-node spec that opens a connection from a different network's control node and asserts the alone state is unchanged.

## Fix direction

Count a connection as a control connection only when the remote is an authorized member of this party's control network (the per-stream gate's authorized set already answers that). `claimed-node-rejoins-without-waiting` edits the same lines; fix it there if it is promoted first.
