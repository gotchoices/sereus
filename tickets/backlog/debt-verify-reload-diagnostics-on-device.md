description: Most of the tools that explain unexpected app reloads during phone test runs have now been checked on a phone, but two checks remain: the reload message logged after the app loses its development server, and whether watching the server's updates from the PC has any visible effect on the phone.
files: packages/reference-app-rn/polyfills/reload-reason.js, packages/reference-app-rn/scripts/metro-hmr-observe.mjs, docs/reference-app-rn.md
tradeoffs: Needs a phone with a development build and someone at the phone, and may never pay off if no more mid-run reloads happen.
----

`docs/reference-app-rn.md` § Device test runs describes three tools for explaining a reload of the reference app on a connected phone: the `[reload]` logcat warning (`polyfills/reload-reason.js`), the frozen dev server (`yarn workspace @serfab/reference-app-rn start:frozen`), and the HMR (hot module replacement) observer (`yarn workspace @serfab/reference-app-rn metro:observe`). The device run of 2026-09-16 (`tickets/complete/rn-device-audit-and-reload-run.md`, ticket `rn-device-audit-and-reload-run`) confirmed the rest, and the doc was updated to match. Still unchecked, on the Android development build:

- Stop and restart Metro, then reach a lazily bundled module (a dynamic `import()` such as optimystic's `import('p2p-fret')`). Confirm logcat shows `[reload] Bundle Splitting – Metro disconnected`, and record the exact line shape in the doc's "Why it reloaded" block (the two-argument no-reason line is quoted and comma-separated by logcat; this one has a single argument and its shape there is inferred).
- Watch the phone while attaching `metro:observe` to a running app, and confirm nothing visible happens (attaching sends the phone's update group one initial update, normally empty). The doc currently says only that attaching does not change what the phone receives.

Correct the docs wherever the device disagrees. For a cold Metro, see the doc's "First launch on a cold Metro" paragraph before launching.
