---
description: The phone app makes you retype the group id and the server address in Settings every time you launch it, and it cannot start itself after being woken by a notification because it does not remember them.
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/push-wake-native.ts
---

# The phone app does not remember its start options

The React Native reference app takes its party id (the group identifier) and its bootstrap
addresses (where to reach the group) from fields typed into the Settings screen, and keeps
them nowhere. Every launch starts from blank fields.

Two consequences, both real today:

- **A push wake into a fully OS-killed process cannot start the node.** The wake handler
  has no start options to work from and degrades to a no-op; the periodic check-in wake is
  the only backstop. This is already documented in the comment at the top of
  `push-wake-native.ts`.
- **Anything stored per-party is effectively dead.** The on-device records that let a
  device trust its group and keep retrying its way back in are scoped by party id. With a
  freshly typed (or freshly generated) party id each launch, those records load empty
  every time, so persisting them buys nothing until the party id itself is stable.

The browser reference app does not have this problem — it generates its party id once and
keeps it in local browser storage.

## Expectation

The phone remembers the party id and bootstrap addresses it was last started with, so a
relaunch (and a background/push wake into a cold process) can bring the node up without
the user retyping anything. Settings still edits them; the stored values are simply the
defaults it opens with and what an unattended start uses.

Neither value is secret — the party id is a group identifier and the bootstrap addresses
are public network addresses — so ordinary app-private storage is the right home; there is
no reason to spend a secure-enclave slot on them.
