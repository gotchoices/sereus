---
description: Both phone apps make you retype the group id and the server address in Settings every time you launch them, and the React Native one cannot start itself after being woken by a notification because it does not remember them.
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/push-wake-native.ts, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/src/cadre-phone.ts
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

## The NativeScript app has the same defect

The slug names React Native for historical reasons; the ticket covers both phone apps.
`packages/reference-app-ns` reads the same two values out of the same two Settings fields
and keeps them nowhere either — `SettingsViewModel.onConnect` generates a fresh party id
whenever the field is blank. It already has an app-private SQLite database open for the
node's whole life (the one holding the device identity and the on-device records), so it
has an obvious home for the values and needs no new storage dependency.

The second consequence above bites it harder than React Native. As of
`feat-ns-invite-trust-pinning`, pasting a group leader's invitation writes that leader's key
into the app's on-device trust record — but that record is filed under the party id. Relaunch
with a freshly generated id and the app reads an empty record and refuses the next join
bundle, so the user has to paste the invitation again every launch. The storage works; it is
simply never read back. (The first consequence — waking from a notification into a killed
process — does not apply: the NativeScript app has no push-wake path.)
