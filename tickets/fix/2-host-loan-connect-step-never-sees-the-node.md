description: Borrowing a node from a cadre-host always fails at the last step — "the lent node was set up but this phone could not reach it within 30 seconds" — even though the phone can dial that exact node by hand in under two seconds and the connection then shows as open. The loan waits on cohort reconciliation to do the dialling, and that never produces the connection.
files:
  - packages/reference-app-rn/src/host-node-request.ts (`connectToNode` ~377-402: `reconcileControlCohort()` then poll `isConnectedTo`)
  - packages/cadre-core/src/cadre-node.ts (`reconcileControlCohort`, `addDrone` — where the lent node's addresses are stored and dialled)
repro: verified
----

# A borrowed node is never connected, though the phone can dial it by hand

## Symptom (device, 2026-09-16)

Galaxy Note 9, debug `reference-app-rn`, cadre-host running on the PC in donor mode, its management
port forwarded (`adb reverse tcp:8765`) and the lent node's ports forwarded too. Settings → Host Node
→ Request Node. The stages advance:

```
[2s]  Waiting for the node to start…
[8s]  Telling the node who its owner is…
[12s] Connecting to the node…
[64s] modal: "Host node request failed"
      "The lent node was set up but this phone could not reach it within 30 seconds.
       Check that the phone and the host are on the same Wi-Fi network."
```

The host side is healthy: the donation reaches `seeded`, the child node logs "Connected to control
network", and `GET /grants/<id>/peer` lists a loopback WebSocket address among its multiaddrs.

**Immediately afterwards, the same phone dialled that same node by hand** — Settings → Dial Peer with
`/ip4/127.0.0.1/tcp/<ws>/ws/p2p/<peerId>` — and it connected in **1.6 s**; a probe of the live node
showed the connection in `getControlNode().getConnections()` with status `open`. So the phone could
reach the node throughout; only the loan's own wait failed.

Verified after `fix/phone-cannot-dial-websocket-peers` landed in the app's polyfills — that bug broke
*all* dialling and had to be fixed first. This one survives it.

## Where to look

`connectToNode` does not dial. It calls `node.reconcileControlCohort()` and then polls
`isConnectedTo(node, dronePeerId)` for 30 s. So either the reconciliation does not dial the
just-added drone at all, or it dials addresses that cannot work and gives up, or the resulting
connection is not on the control node where `isConnectedTo` looks.

Worth checking in that order:

1. Does `reconcileControlCohort()` include a peer added moments earlier by `addDrone`, or does it
   work from a membership/cohort snapshot that has not refreshed yet?
2. Which addresses does it dial? The host returns TCP *and* WebSocket, loopback *and* LAN. A phone
   has no TCP transport; if reconciliation tries TCP first and treats the failure as final, it would
   look exactly like this.
3. Does a successful dial land on the control libp2p node (what `isConnectedTo` inspects)?

## Suggested direction

Have the loan dial explicitly rather than hoping reconciliation does it: the flow already knows the
peer id and the address list it was given, and `dialPeer` demonstrably works. Keep the reconcile call
(it is what makes the connection durable across restarts), but do not depend on it for the first
connection. If reconciliation is supposed to be the mechanism, fix it there and add a test that adds
a drone and asserts a connection appears without any other dial.

## Related

- `complete/donated-node-reachable-by-phone` — made lent nodes listen on WebSocket and let the phone dial in.
- `complete/owner-keeps-dialing-node-it-added` — the phone side of retaining dial targets.
- Environment note, not a bug: on this machine the Wi-Fi network is classed **Public** by Windows and
  node.exe has inbound Block rules for Public, so the phone cannot reach the lent node over the LAN at
  all. The runs above used `adb reverse` for the node's ports, which is why loopback addresses were
  dialable. The modal's "check you are on the same Wi-Fi" wording is good advice but was not the cause
  here.
