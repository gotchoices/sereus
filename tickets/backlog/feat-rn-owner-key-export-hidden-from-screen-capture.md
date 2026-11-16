description: The phone app shows an owner key's export (the private key that controls the cadre) as a QR code and text, and that screen can currently be captured by screenshots, screen recording and the app switcher's snapshot; hide it from all three while it is on screen.
architecture: docs/platforms/reference-apps.md#owner-keys
files: packages/reference-app-rn/src/owner-keys-section.tsx, packages/reference-app-rn/src/owner-grant-views.tsx, packages/reference-app-rn/package.json, docs/platforms/reference-apps.md, docs/platforms/react-native.md
tradeoffs: It adds a native module, so every dev client must be rebuilt, and the protection is partial anyway: a second camera or a screen reader still sees the text.
----
Settings → Owner keys shows an export once, after **Export this device's key** (`ExportView` in `owner-keys-section.tsx`), and an owner grant once, after **Add an owner key** or **Make a backup** (`GrantView` in `owner-grant-views.tsx`, whose `NOTE:` points to the export's). Whoever holds that text or QR code is, or can become, an owner of the cadre. Today nothing stops the operating system from keeping a copy of the screen:

- **Android** takes a thumbnail for the recent-apps list and allows screenshots and screen recording unless the window carries `FLAG_SECURE`.
- **iOS** keeps a snapshot of the last screen for the app switcher, and allows screenshots and recording.

`docs/platforms/reference-apps.md` → Owner keys records this as a known exposure, and a `NOTE:` at `ExportView` points here.

## Expected behaviour

While the export is on screen, and only then:

- Android: the window is secure (no screenshot, no recording, a blank recent-apps thumbnail).
- iOS: the app switcher shows a cover instead of the export; screenshots and recording are prevented where the platform allows it.

Leaving the export (Done, the section unmounting, the node stopping) restores normal capture for the rest of the app.

## Notes for the implementer

`expo-screen-capture` (an Expo native module, not yet a dependency of this app) provides `usePreventScreenCapture` / `preventScreenCaptureAsync` (Android `FLAG_SECURE`) and, in recent SDKs, an iOS app-switcher cover. Check what the SDK this app pins (Expo 53) offers before choosing. Adding it is native configuration: note it under "When a native rebuild is needed" in `docs/platforms/react-native.md`.
