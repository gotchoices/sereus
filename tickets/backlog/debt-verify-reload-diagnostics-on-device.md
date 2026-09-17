description: The tools added to explain unexpected app reloads during phone test runs have only been checked by reading source code and by runs without a phone. Someone with the phone attached needs to confirm they report what the docs say, so the next unexplained reload can actually be diagnosed.
files: packages/reference-app-rn/polyfills/reload-reason.js, packages/reference-app-rn/scripts/metro-hmr-observe.mjs, packages/reference-app-rn/package.json, docs/reference-app-rn.md
tradeoffs: Needs a phone with a development build and about half an hour of someone at the phone, and may never pay off if no more mid-run reloads happen.
----

`docs/reference-app-rn.md` § Device test runs describes three tools for explaining a reload of the reference app on a connected phone: the `[reload]` logcat warning (`polyfills/reload-reason.js`), the frozen dev server (`yarn workspace @serfab/reference-app-rn start:frozen`), and the HMR (hot module replacement) observer (`yarn workspace @serfab/reference-app-rn metro:observe`). None has been run against a phone. Expected behavior to confirm on the Android development build:

- On `yarn start`, change a module imported outside React components (for example `polyfills/event.js`, or a linked optimystic `dist` file). Logcat shows `W ReactNativeJS: [reload] (no reason given) caller:` with a stack that names `performFullRefresh`, then the app restarts. `metro:observe` prints that module just before. If the Hermes stack doesn't name the caller readably, reword the doc's reason table.
- On `start:frozen`, the dev client connects (from its recent-servers list, or after `adb reverse tcp:8081 tcp:8081`), and the same change causes no reload.
- Writing a `tickets/*.md` file under either mode causes no reload, and the observer prints nothing.
- Dev menu → Reload prints no `[reload]` line.
- Stopping and restarting Metro, then reaching a lazily loaded module (a dynamic `import()` such as optimystic's `import('p2p-fret')`), logs `[reload] Bundle Splitting – Metro disconnected`.
- Find which logcat line reliably marks a real JavaScript reload. The docs assume `Running "main"`. Don't use `I ReactNativeJS: log level = info`: it also appears every 15 minutes from a different process (probably the background task).
- Attaching `metro:observe` while the app runs has no visible effect on the phone.

Correct the docs wherever the device disagrees.
