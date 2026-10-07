description: The phone app adds a home machine's node to its cadre by scanning the QR code the machine shows, replacing the Settings screen that asks for a host address and a grant token.
prereq: cadre-host-hosted-nodes-join-by-qr
files: packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/app/settings.tsx, packages/cadre-rn/src/phone-node/config.ts, docs/reference-app-rn.md
difficulty: medium
----

# Phone app: add your home node by scanning its QR

## What to build

- Replace `host-node-request.ts` (the grants HTTP client) with: scan or paste a `sereus-join:` payload → dial the node (public addresses first, then LAN) → `claimNode` from cadre-core → the node appears among the cadre's peers.
- Settings → "Add an always-on node", with a camera scan and a paste fallback. Keep the plain-language progress lines and rewrite the failure messages for the new failures (unreachable, already claimed, wrong secret).
- Scanning **inside** the app's cadre screen is the main path. A system-camera link that opens a Sereus app is a convenience: Android's chooser lists every app registering it (the ticket-9 shared action), while on iOS a shared custom scheme opens an unpredictable app, so iOS relies on the in-app scanner.
- The approval prompt names the cadre the node will join (cadre label, owner fingerprint), because an app that is still in its own one-node cadre would otherwise add the node there.
- Keep the permissive dial gater for private / `ws://` addresses (`allowPrivateDial`).
- Update docs/reference-app-rn.md → "Borrowing a Node From a cadre-host".

## Edge cases & interactions

- Phone on cellular when the host has only LAN addresses: say the node is not reachable from outside yet.
- The node is already claimed by another cadre: show a definite message.
- The app closes mid-claim: rescanning is safe (the claim is idempotent for the same owner key).

## TODO

- Implement.
- Replace `tickets/blocked/rn-host-node-request-device-run.md` (it tests the grants flow) with a device-run ticket for the scan flow.
