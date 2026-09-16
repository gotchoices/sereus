description: A phone cannot invite anyone into a private chat, because inviting means handing out an address people can reach you at and a phone has none. Give the phone app a forwarding server to route through, so its invitations carry an address a stranger can actually dial.
prereq: relay-can-be-optional-at-startup
files: packages/reference-app-rn/src/relay-config.ts (new), packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/test/phone-node-config.spec.ts, packages/reference-app-rn/test/relay-config.spec.ts (new), packages/reference-app-rn/test/solo-founding.spec.ts, packages/reference-app-rn/src/ice-config.ts (the pattern to mirror), packages/reference-app-web/src/lib/relay-config.ts (the web counterpart), docs/reference-app-rn.md
difficulty: medium
----

# A phone with an address other people can dial

## Terms

- **Relay** (circuit relay) — a public libp2p node that forwards traffic for a node that cannot accept incoming connections. The forwarded-for node holds a **reservation** on it; the `/p2p-circuit` address that reservation produces is the only address a phone ever has.
- **Formation** — the cross-party handshake behind "create a closed strand and invite someone". The **invitee dials the inviter**, first its control node and then its strand nodes.

## Why this is needed

The product's trust model is invitation-only strands: one party creates a closed strand, hands another party an invitation out of band, and the invitee consents and joins ([`docs/reference-app-rn.md`](../../docs/reference-app-rn.md), "Trust model / closed strands"). The everyday case is a person on their phone inviting someone else.

Today the phone node starts with `listenAddrs: []` and no relay (`phone-node-config.ts`), so `resolveListenAddrs` yields no circuit listener and `CadreNode.getMultiaddrs()` is empty. `CadreNode.createOpenInvitation` fills the invitation's bootstrap list from exactly that, and throws `No multiaddrs available for invitation` when it is empty. So "Create Closed Strand + Invite" in the reference app can only fail. (`use-cadre.ts` → `createClosedStrandWithInvite` already refuses *before* founding, so a failed attempt no longer leaves an orphaned strand behind. That half of the original plan ticket has landed; this ticket is the reachability half.)

## The design

**The phone reserves on a relay it is configured with, supplied through `network.relayAddrs`, at the optional posture `relay-can-be-optional-at-startup` adds.**

Three reasons this is the shape:

1. **It is the proven one.** `blind-relay-phone-to-phone-e2e.integration.ts` already runs exactly this node shape end to end: two *different* parties, each a `CadreNode` with `listenAddrs: []` and `relayAddrs: [<relay>]`, sharing one dedicated relay. It asserts the invitation's bootstrap addresses come out as `/p2p-circuit`, that the stranger's formation dial succeeds over the circuit, that the strand mesh forms from the formation-carried seed with no hand-dial, that rows replicate both ways, and that every cross-party connection is classified `relayed`. Nothing about the phone build changes those facts — the phone's node differs only in its transports and storage.
2. **`network.relayAddrs` is the only input that reaches strand nodes.** `CadreNode.reserveRelays()` — the fail-soft route the web reference app takes — reaches the control node and stops there. A strand node gets its bare `/p2p-circuit` listener and its reservation supervisor from `network.relayAddrs` alone (`strand-network-config.ts`, `strand-instance-manager.ts`). Formation needs both: the invitee dials the control node from the invitation, then the strand nodes from the formation result's `strandAddrs` (`strand-formation-cross-party-seed.integration.ts`).
3. **The alternative is blocked on two defects in cadre-core.** See below.

### The alternative that was considered and is not available yet

The appealing alternative is for the phone to relay through **its own cadre's always-on node** — the node a `cadre-host` lends it, which `rn-request-node-from-cadre-host` now makes it possible to ask for from Settings. That node runs the `storage` profile, and a storage-profile node runs the circuit-relay server by default (`cadre-node.ts` → `relayServerEnabled`). It needs no third-party infrastructure and matches the deployment story of "a phone plus a machine at home".

It cannot work today, for two reasons found by reading the code:

- **Every connection such a relay forwards is capped.** `CadreNode` builds its libp2p node with `relay: enableRelay` and never passes `relayServerInit`, so `@libp2p/circuit-relay-v2` applies its default `applyDefaultLimit: true` — 128 KiB and 2 minutes per relayed connection, after which the stream is reset. The dedicated-relay fixture and the shipped relay container both set `applyDefaultLimit: false` precisely to avoid this, and `blind-relay-phone-to-phone-e2e` asserts live that `connection.limits` is absent on every relayed connection. Filed as `backlog/bug-party-run-relay-caps-every-relayed-connection`.
- **A stranger dialling through such a relay is dropped after five seconds.** The invitee is not a member of the phone's cadre, so at the relay its connection is an inbound connection from an unrecognised peer. `admitInboundControlConnection` returns `admit-for-relay` for it (a lent node never calls `initializeStrandSolicitation`, so the outstanding-invitation carve-out is unreachable there), which arms `RELAY_ADMISSION_RESERVE_DEADLINE_MS` — five seconds to get a *reservation* admitted, or the gater aborts the connection. A hop connect is not a reservation and never reaches the hook that disarms the timer. `relay-only-control-addr.integration.ts` already asserts that drop as intended behaviour. Filed as `backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it`.

The capability itself is filed as `backlog/feat-phone-relays-through-its-own-always-on-node`, with those two as prerequisites. This ticket deliberately does not wait for it: the configured-relay route works now, uses the same `network.relayAddrs` field, and the app keeps that field whichever source later fills it.

### Where the address comes from

Mirror `ice-config.ts`, which already solves this problem in this package for STUN/TURN servers, and its web counterpart `reference-app-web/src/lib/relay-config.ts`:

- New `src/relay-config.ts`, framework-free, no cadre-core or native imports: `resolveRelayAddrs(explicit?: string[]): string[]` — an explicit non-empty list wins, otherwise `process.env.EXPO_PUBLIC_RELAY_ADDR` split on commas, trimmed, blanks dropped; `[]` when nothing is configured. Never throws.
- No `localStorage` branch: React Native has none, which is the same omission `ice-config.ts` documents. The per-device override seam is the Settings field below.
- `PhoneNodeOptions` gains `relayAddrs: string[]`, alongside `partyId` and `bootstrapAddrs`. Those are already typed into Settings on every launch (nothing persists start options — `backlog/feat-rn-persist-node-start-options`), so a relay field belongs in the same place and needs no new persistence.
- Settings gets a "Relay" input, prefilled from `resolveRelayAddrs()` so a build with `EXPO_PUBLIC_RELAY_ADDR` set needs no typing, and editable so a device can be pointed elsewhere. Same `autoCapitalize="none"` / `autoCorrect={false}` treatment as the other address fields.

### What `buildPhoneNodeConfig` sets

```ts
network: {
  transports: inputs.transports,
  listenAddrs: [],                      // unchanged — RN cannot listen
  relayAddrs: inputs.relayAddrs,        // new
  requireRelay: false,                  // new — a phone must start with its relay down
  connectionGater: { denyDialMultiaddr: () => false },
}
```

`listenAddrs: []` stays empty: `resolveListenAddrs` keeps an explicitly empty list empty and *adds* the bare `/p2p-circuit` search entry when a relay is named, which is exactly the shape wanted.

### The stale comment to fix

`phone-node-config.ts` currently claims the phone's "dialed circuit reservation + the `/webrtc` upgrade are advertised over the existing identify/cohort flow without a listen addr". Against `relay-addrs.ts` that does not hold: with no `relayAddrs` there is no reservation to advertise at all. Replace it with what is now true.

### Telling the user when they are not reachable

`use-cadre.ts` → `createClosedStrandWithInvite` already refuses when `getMultiaddrs()` is empty. Keep that as the load-bearing check — it is the actual precondition `createOpenInvitation` has — and enrich the message from `CadreNode.getRelayReservationState()`, the way `reference-app-web`'s `createInvitation` does:

- `none` → no relay configured: say so, and name the Settings field.
- `retrying` / `error` → the relay is not answering: include the status and the recorded error.

Expose the posture through `cadre-phone.ts` as a thin pass-through beside `getConnectionPaths`, and surface it in the chat screen's connection banner (`connection-status.ts`) so "you are not reachable" is visible before the user taps Invite, not only after.

## Expected behaviour when done

- A phone with a working relay taps "Create Closed Strand + Invite" and gets an invitation whose bootstrap addresses are `/p2p-circuit` addresses through that relay.
- A second party redeems it with `formStrand`, its nodes join the strand, and a message sent on the phone is readable on the other party's nodes and the reverse. (Proven for this node shape by `blind-relay-phone-to-phone-e2e`; see "What this ticket does not prove".)
- A phone with no relay configured, or whose relay is down, starts normally, works offline, and gets a plain-language refusal naming the reason when it tries to invite — with no strand left behind.
- Requesting a node from a `cadre-host` still works unchanged, and a phone can hold both a lent node and a relay reservation at once.

## Edge cases & interactions

- **The relay is down at start.** The node must still start, still found and read local strands, and still dial its lent node. This is what `requireRelay: false` buys; assert it with an unreachable relay address, which needs no relay server.
- **The relay comes back while the app is running.** The control node's supervisor re-drives on its own backoff. The invite guard reads the posture live, so the button starts working without a restart — and the banner should stop saying "not reachable".
- **Backgrounding and resuming.** The app hibernates strands on background and the OS drops sockets; the control node's supervisor survives (it is stopped only by `stop()` or a later `reserveRelays`) and re-drives on resume, and each strand's supervisors are rebuilt when its runtime is rebuilt. Verify no extra work is needed, and state in the handoff whether an outstanding invitation needs anything beyond that. Watch for the supervisor's 5 s liveness check running while backgrounded — if it is a battery concern, record it as a `NOTE:` tripwire rather than a ticket.
- **Every strand launch waits for its first relay attempt.** `awaitFirstRelayAttempts` blocks the strand going `active` until each supervisor's first attempt settles, and that attempt's default timeout is 10 s. So on a phone whose relay is unreachable, every strand launch takes about ten seconds longer than it does today. It never fails — but it is a visible regression in founding latency that `founding-progress.ts` will surface, so decide deliberately: either accept it and say so in the handoff, or pass a shorter first-attempt timeout for the phone.
- **One relay per phone, and the two ends may differ.** Two people are not guaranteed to have configured the same relay. That path is untested (`backlog/feat-scenario-two-relay-circuit`) and out of scope here; do not claim it works.
- **A malformed relay address typed into Settings.** `relayCircuitAddrs` throws at config resolution whatever the posture, so `startPhoneNode` rejects and the Settings screen shows "Connection failed". Confirm the message is legible rather than a raw multiaddr parse error, and that the field can be corrected and Connect retried without restarting the app.
- **An empty relay field.** Must behave exactly as today: no listener, no supervisor, node starts, invite refused with the "no relay configured" message.
- **Both `EXPO_PUBLIC_RELAY_ADDR` and a typed value.** The typed value wins; a build-time default is only a prefill.
- **A relay that grants the reservation and then refuses to forward.** Out of scope — the posture reports `reserved` and the dial fails later. Do not try to detect it.

## What this ticket does not prove

No test in this package puts the phone's own config on a wire against a real relay. `blind-relay-phone-to-phone-e2e` proves the *behaviour* for a node of this shape, and the specs below prove the phone's config resolves to that shape, but the two are joined by inspection rather than by a test. Say so plainly in the handoff. A phone-config-shaped scenario in `packages/integration-tests` would close it; that is a separate ticket if anyone wants it, not this one.

## Tests

- `test/relay-config.spec.ts` (new), mirroring `ice-config.spec.ts`: explicit list wins; the env var is split, trimmed and blank-filtered; an unset env var yields `[]`; never throws.
- `test/phone-node-config.spec.ts`: `buildPhoneNodeConfig` carries `relayAddrs` through verbatim, sets `requireRelay: false`, and leaves `listenAddrs` as `[]`. Assert on cadre-core's own derivation too, so this is a claim about behaviour and not about a field name: `resolveListenAddrs(config.network)` contains the bare `/p2p-circuit` entry, and `strandNodeAddrs(config.network)` returns one search entry and one `relayAddrs` entry per relay — that second one is the whole reason this ticket uses the config field rather than `reserveRelays`.
- `test/solo-founding.spec.ts` (or a sibling): a node built from `buildPhoneNodeConfig` with an **unreachable** relay address still starts within the existing lifecycle deadline, founds a chat strand, and reports `getRelayReservationState().status === 'retrying'`. This is the fail-soft proof and needs no relay server.
- A hook test for the invite refusal: with no relay configured the message names the Settings field; with a retrying relay it names the status. Assert no strand was founded in either case.
- Existing `react/use-cadre.spec.ts` and the host-node-request tests must keep passing — the new option threads through `start()`.

## TODO

- Add `src/relay-config.ts` with `resolveRelayAddrs`, documented as a mirror of `ice-config.ts` and of the web `relay-config.ts`, naming the three platform differences.
- Add `relayAddrs: string[]` to `PhoneNodeOptions`; set `network.relayAddrs` and `network.requireRelay: false` in `buildPhoneNodeConfig`.
- Replace the inaccurate "advertised over the existing identify/cohort flow without a listen addr" comment in `phone-node-config.ts`.
- Add a relay pass-through for `getRelayReservationState()` in `cadre-phone.ts`; surface the posture on `UseCadreResult` and in the connection banner.
- Enrich `createClosedStrandWithInvite`'s refusal message from the live posture; keep the `getMultiaddrs()` check as the guard.
- Add the Settings "Relay" field (prefilled from `resolveRelayAddrs()`, `autoCapitalize="none"`, `autoCorrect={false}`), a test id in `src/test-ids.ts`, and thread it into `cadre.start(...)`.
- Write the specs listed above.
- `docs/reference-app-rn.md`: a section on configuring a relay (the env var, the Settings field, what a phone can and cannot do without one), and update the trust-model section to say that inviting requires a relay. Note in the handoff that `backlog/debt-docs-relay-support-reads-more-complete-than-it-is` still owns the cross-document matrix, and that its "phone: never used" row is now out of date.
- Run `yarn workspace @serfab/reference-app-rn test`, `yarn workspace @serfab/reference-app-rn typecheck`, `yarn lint`.
