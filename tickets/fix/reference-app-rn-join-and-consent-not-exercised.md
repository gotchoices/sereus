----
description: RN reference multi-phone auto-join is non-functional and no consent/invitation/RBAC is exercised
files: packages/cadre-core/src/cadre-node.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/README.md
----

## Problem

The RN reference app is supposed to demonstrate two phones converging on a
shared chat strand, with data "distributed across participants' devices."
In practice two phones cannot converge on a shared chat strand, and the
reference only exercises open strands keyed by a shared Party ID — so the
trust/permission model is never demonstrated.

### Discovered-strand auto-join is non-functional

The RN README claims Phone B "sees the strand via control network sync and
auto-joins." That is not what happens. `CadreNode.handleStrandAdded()`
(`packages/cadre-core/src/cadre-node.ts:370-380`) only auto-starts a
control-discovered strand if an `sAppConfig` is *already* registered for
that exact strand `Id`; otherwise it logs
`No sAppConfig registered for strand <id> - skipping auto-start` and
returns:

```ts
const sAppConfig = this.sAppConfigs.get(strand.Id);
if (!sAppConfig) {
  log('No sAppConfig registered for strand %s - skipping auto-start', strand.Id);
  return;
}
```

The RN app only registers an sApp config for strands it *creates itself*
(`createStrand` → `createChatStrand(cadreNode, uuid())` in
`packages/reference-app-rn/src/use-cadre.ts:139-145` and
`packages/reference-app-rn/src/chat-strand.ts:52-66`). The helper for the
discovered-strand case, `joinChatStrand()`
(`packages/reference-app-rn/src/chat-strand.ts:75-83`), exists but is never
called. `useCadreInternal` subscribes to `strand:started` / `strand:stopped`
/ `strand:error` (`use-cadre.ts:76-95`) but has no handler that reacts to a
strand appearing in the control network by registering the chat sApp config
and joining it.

Net effect: Phone B never registers the config for Phone A's strand, so
`handleStrandAdded` skips it, and the two phones cannot converge on a shared
chat strand — directly contradicting the README and the "data distributed
across participants' devices" goal.

### No consent / invitation / role model is exercised

The RN reference creates only *open* strands: `createChatStrand` hardcodes
`Type: 'o'` and `MemberPrivateKey: null`
(`packages/reference-app-rn/src/chat-strand.ts:56-66`), and the README
instructs every user to connect to the *same* Party ID
(`reference-chat-party`). This conflates a single party's private control
network with a multi-party shared space. No FormationInvite, formation,
schema-gated join, or role assignment is exercised. So even the "real"
reference app does not demonstrate Sereus's trust/permission model — the
invitation and consent flow that is central to the architecture goes
entirely unshown.

### Latent message primary-key collision

`insertMessage` computes the next primary key as `max(Id) + 1` read from the
*local* database
(`packages/reference-app-rn/src/chat-operations.ts:89-96`):

```ts
const maxRow = await db.get('select max(Id) as MaxId from App.Message');
const nextId = ((maxRow?.MaxId as number | null) ?? 0) + 1;
```

This is a correctness bug that is currently masked only because convergence
is broken. Once two peers genuinely share a strand and insert concurrently,
they will independently compute the same `max(Id)+1` and collide on the
`Message.Id` integer primary key (declared in the embedded `CHAT_SCHEMA`,
`chat-strand.ts:20-26`). A collision-free key is required — e.g. a
UUID/text primary key, or a composite `(MemberId, seq)` key — so that
concurrent inserts from distinct members never conflict.

## Expected behavior

- **Working discovered-strand join.** Phone B, on seeing a chat strand
  appear via control-network sync, registers the chat sApp config and joins
  it (wire `joinChatStrand` into a discovery handler so
  `handleStrandAdded` no longer skips with "No sAppConfig registered"). Two
  phones connected to the same control network converge on the shared chat
  strand and see each other's messages.

- **Exercise the trust/permission model.** The reference demonstrates the
  invitation / consent / role model on at least one *closed* strand:
  FormationInvite issuance, the invitee's consent, schema-gated join, and
  role assignment — rather than relying solely on an open strand keyed by a
  shared Party ID.

- **Collision-free message primary key.** Message inserts use a key that
  cannot collide across concurrent peers (UUID/text PK or composite
  `(MemberId, seq)`), removing the `max(Id)+1` local-read assumption.

## Use cases

- Two phones on the same control network: one creates a chat strand, the
  other discovers it and auto-joins; both can post and read messages that
  converge across devices.
- A closed strand where a host issues an invitation, an invitee consents and
  joins through the schema gate, and a role is assigned — demonstrating the
  permission model end-to-end.
- Concurrent posting from two members never collides on the message primary
  key.

## References

- `packages/cadre-core/src/cadre-node.ts:370-399` — `handleStrandAdded`
  skip-on-missing-config behavior.
- `packages/reference-app-rn/src/chat-strand.ts` — `createChatStrand`
  (open, `Type 'o'`, null key), unused `joinChatStrand`, embedded
  `CHAT_SCHEMA` with integer `Message.Id` PK.
- `packages/reference-app-rn/src/chat-operations.ts:80-104` —
  `insertMessage` `max(Id)+1` PK computation.
- `packages/reference-app-rn/src/use-cadre.ts:76-145` — strand event
  subscriptions and `createStrand`; no discovery-join handler.
- `packages/reference-app-rn/README.md` — "auto-joins" claim and shared
  Party ID instructions.
- Related tickets: `bootstrap-dht-discovery-and-strand-cohort-wiring`
  (cadre-layer cohort bootstrap seed + mode selection on the discovery path)
  and `reference-app-rn-strand-selection` (deterministic strand selection in
  the e2e UI). This ticket is distinct: it covers the RN reference's missing
  discovered-strand join wiring, the absence of any consent/invitation/RBAC
  exercise, and the message PK collision bug.
- Docs: `docs/architecture.md`, `docs/strands.md`.
