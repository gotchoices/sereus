---
description: On phones and in the browser, the small on-device records a machine needs to rejoin its group after being invited are thrown away every time the app closes, so a phone that is invited while the group is briefly unreachable can never get in.
prereq: persist-seed-bootstrap-peers
files: packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/bootstrap-peer-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-ns/src/cadre-phone.ts
difficulty: medium
---

# Durable node-local stores on React Native and in the browser

## The gap

A machine keeps two small records that are deliberately **node-local** — never replicated,
never sourced from shared group state, because shared state can be polluted by any machine
that connects:

- the **trusted-owner anchor** (`trusted-owner-store.ts`) — which owner keys this machine
  established out of band (founding the party, an invite's pinned keys, an operator pin).
  Everything that judges "is this row from a real member of my party" rests on it.
- the **bootstrap-peer store** (`bootstrap-peer-store.ts`, landing in the prerequisite
  ticket) — the addresses to keep dialing so a newly-invited machine that could not reach
  the group on its first try eventually gets in.

Both are cross-platform interfaces with an ephemeral in-memory default and a Node-only
file backend behind a dedicated import path. Only the headless CLI injects the durable
backends. The three reference apps — React Native (`reference-app-rn`), NativeScript
(`reference-app-ns`), and the web app (`reference-app-web`) — inject **neither**, so on
every one of those targets both records vanish when the app process ends.

Consequence on a phone, which is where it matters most: a device invited while the owner
is momentarily unreachable retries only until the app is relaunched, then has nothing left
to dial *and* no anchored owner key with which to trust the group's records if it did get
back in. The user sees an invitation that silently does nothing, forever. Recovery needs a
human to obtain and apply a fresh seed.

## Why this needs design, not just wiring

Each app persists its identity key already, so the seam exists — but *where* these records
should live is a real decision per target, and the anchor's placement is security-relevant
while the addresses' is not:

- The anchor is not secret, but it **is** trust-bearing: something that can silently edit
  it can make this device believe a stranger is an owner. That argues for the most tamper-
  resistant store each platform offers, and for a documented answer to "what happens when
  the file is present but unreadable" (the Node backend deliberately throws rather than
  silently starting empty — that policy should carry over, not get lost).
- The bootstrap addresses are dial hints, and dialing grants no authority, so ordinary
  app-private storage is adequate for them.
- On React Native, `reference-app-rn` already keeps the identity in `expo-secure-store`
  (`SecureStoreKeyStore`). Secure store is a small key/value store meant for secrets —
  whether the anchor belongs there, or in app-private files via `expo-file-system`, is
  the main call to make. `reference-app-ns` needs the equivalent decision for its own
  platform APIs.
- On the web, browser storage is user-clearable and origin-scoped, and a cleared store
  must degrade to "trusts no one until re-invited" rather than to "trusts whatever was
  left behind". Which mechanism (IndexedDB vs `localStorage`) and what a cleared or
  corrupt store means are both open.
- Whatever lands should also settle whether the RN/web apps get a *migration* path, or
  whether an existing install simply cold-starts its anchor once.

## Expected outcome

On every target the reference apps support, a machine that was legitimately invited to a
group is still trying to rejoin — and still knows which owner keys it trusts — after the
app is closed and reopened, with no operator action and no second invitation.

## Notes

- Read `trusted-owner-store-file.ts` first: its load-failure policy (missing / corrupt /
  wrong-party ⇒ empty; present-but-unreadable ⇒ throw) and its atomic snapshot write are
  the behaviour any new backend has to match, and the reasons are written out there.
- The prerequisite ticket (`persist-seed-bootstrap-peers`) defines the bootstrap-peer
  store interface and lands the Node backend; this ticket is only about the remaining
  targets, plus the anchor, which has the same gap and has had it longer.
- The interfaces are deliberately injected from the app, not discovered by the library, so
  no `node:fs` or platform module ever enters a bundle that cannot resolve it. Keep that
  property — a new backend belongs in the app package or behind its own import path.
