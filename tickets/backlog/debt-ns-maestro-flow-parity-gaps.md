description: The NativeScript phone app is supposed to be tested by reusing the React Native app's automated UI test scripts unchanged, but the two apps' screens no longer match closely enough for those scripts to run against it.
files: packages/reference-app-ns/app/chat/chat-page.xml, packages/reference-app-ns/app/app-root.xml, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/src/test-ids.ts, packages/reference-app-rn/maestro/_setup.yaml, docs/reference-app-ns.md
---

# Reused RN Maestro flows cannot pass against the NativeScript app

## The arrangement

`packages/reference-app-ns` deliberately owns **no** UI-test flow files. Its
end-to-end runner (`scripts/run-e2e.mjs`) points Maestro at
`packages/reference-app-rn/maestro/`, reusing the React Native app's flows,
shared setup, and helper scripts verbatim — the only intended difference being
the app bundle id. That reuse is only sound while the two apps present the same
screen elements under the same automation ids.

They have drifted. The end-to-end suite is device-only, so nothing in CI or in an
agent run catches it; the drift is visible by reading the flow against the NS
screens.

## What no longer lines up

- **The shared setup's final determinism check has no target on NativeScript.**
  `_setup.yaml` ends by asserting an element identified as `chat-strand-label`,
  whose visible text is the full id of the chat screen's active conversation.
  That check exists to fail loudly when the phone and the test drone are talking
  about *different* conversations — without it, two of the three flows can pass
  while proving nothing. The React Native chat screen renders that element; the
  NativeScript chat screen has no equivalent element at all, so the assertion
  cannot succeed.

- **Which conversation the NativeScript chat screen shows is not deterministic.**
  React Native picks the displayed conversation by a stable rule that does not
  depend on the order conversations happened to arrive, plus an explicit
  selection when the user creates one. NativeScript takes whichever entry comes
  first out of a map, so a conversation synced from the drone can quietly
  displace the one the user just created. Even with the label added, the check
  above would be flaky rather than meaningful.

- **The flows navigate as if the app had tabs; it does not.** The shared setup
  switches screens by tapping the words "Settings" and "Chat". React Native has a
  two-tab bar, so both taps work. NativeScript deliberately abandoned tabs — its
  tab strip did not render for text-only items on Android, leaving Settings
  unreachable — and uses a single screen stack with a "Settings" action in the
  chat screen's title bar and a Back button to return. The forward tap happens to
  match the action's label; the return tap has nothing to match.

- **The seed section grew two elements and the flow never scrolls.** The shared
  setup now types an enrollment invite into a second box before pressing Apply
  Seed. Both apps gained that box, but the NativeScript settings screen is one
  long scrolling column with no tab bar, so the button may sit below the visible
  area on a short emulator screen — and the flow taps it directly rather than
  scrolling to it first. Unproven either way (device-only), but it is the kind of
  thing that reads as a mysterious tap failure. Whoever does the device run should
  check it, and add a scroll-to-element step if it bites.

- **The documentation still describes the abandoned tab layout.**
  `docs/reference-app-ns.md` describes the app shell as a two-tab view in several
  places, contradicting the app's own root file and its explanatory comment.
  Anyone reasoning about the flows from the docs will reach the wrong conclusion.

## What a fix has to decide

The genuine question is whether the two apps stay close enough for verbatim flow
reuse, or whether NativeScript should get its own copy of the flows. Reuse is
worth preserving — it is the whole reason there is no duplicate flow directory —
but it costs the NativeScript app a navigation-shape constraint it has already
found reasons to break. Both directions are defensible, which is why this is a
description of the problem rather than a plan.

Whichever way it goes, the deterministic-conversation-selection gap is real on
its own merits: it is a behavior difference between the two reference apps, not
merely a testing inconvenience.

## Not blocking anything today

The end-to-end suite already needs an emulator, a built APK, Maestro, and adb, so
it is out-of-band work for a human either way. Nothing an agent or CI runs is
affected. Filing this so the next person to attempt a NativeScript device run
does not rediscover it one failed assertion at a time.
