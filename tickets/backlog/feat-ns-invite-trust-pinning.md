description: The NativeScript phone app has no way to be told which group leaders it should trust, so it turns down every invitation to join a group and can only ever run alone.
files: packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/app/settings/settings-page.xml, packages/reference-app-rn/app/(tabs)/settings.tsx, docs/reference-app-ns.md
difficulty: medium
---

# NativeScript app can never accept a seed — no way to establish owner trust

## What happens today

Joining a group works by applying a **seed** — a signed bundle of addresses and
group identity handed over by an existing member. Before accepting one, a node
checks that the key which signed it is a key the node already trusts *out of
band*. That set of trusted keys is the node-local **trusted-owner anchor**
(`TrustedOwnerStore` in `@serfab/cadre-core`), and it is deliberately never
filled in from replicated group state — otherwise a stranger could write
themselves in.

Two things normally fill it:

- **Genesis self-trust** — a node started with an owner *private* key anchors
  its own public key (`CadreNode` does this internally when
  `seedBootstrap`/owner key is wired).
- **An invite pin** — the user pastes a `CadreInvite`, whose `ownerKeys` are
  pinned for that apply and persisted into the anchor
  (`CadreNode.trustOwnerKeys(keys, 'invite')`, plus `pinnedKeyTrustPolicy` for
  the apply itself). This is what the React Native app's Settings screen does
  with its optional **Paste enrollment invite (for trust)** field.

`reference-app-ns` does **neither**. `startPhoneNode` wires no owner private key,
and nothing in `packages/reference-app-ns/src` or `app/` calls
`trustOwnerKeys` or supplies `seedTrustPolicy`. The default policy is
`anchoredTrustPolicy()`, which trusts only anchored keys — and the anchor is
always empty. So **Apply Seed always fails** on this app; it can only ever run
solo (`startSolo`, which forms its own group and needs no seed).

This is pre-existing, not a regression: before the anchor became durable
(`ns-durable-node-local-stores`) the in-memory anchor was equally empty. Making
the anchor durable did not make it *reachable* — that is this ticket.

## Expected behavior

- The Settings screen offers an optional invite field alongside the seed field,
  matching the React Native app's flow: paste an invite, then Apply Seed, and the
  seed signed by that invite's owner is accepted.
- The invite's owner keys land in the durable anchor (already wired), so later
  seeds from the same owner need no invite.
- Leaving the field blank keeps today's behavior — the seed is checked against
  whatever the anchor already holds.
- A malformed invite, or an invite whose keys do not cover the seed's signer,
  fails with a message the user can act on; it must not silently widen trust.

## Notes for whoever picks this up

- The React Native equivalent is the reference for both the UI copy and the
  ordering constraint (pin **before** the first `applySeed`, so seed trust sees
  the pins) — see `docs/reference-app-rn.md` → "Cold-start trust".
- Only the app wiring is missing; the cadre-core seams
  (`trustOwnerKeys`, `pinnedKeyTrustPolicy`) and the durable anchor already exist.
- Worth deciding at the same time whether the NS app should also persist its
  party id (see `feat-rn-persist-node-start-options`) — without that, a relaunch
  with a freshly typed party id reads an empty anchor even after a successful pin.
