description: In development builds of the React Native reference app, cadre-core's debug log lines print their placeholders (`%d`, `%s`) unfilled, with the values tacked on at the end, because React Native's console does not fill them in the way a browser console does. The information is all there, but the lines are hard to read and to search.
files: packages/reference-app-rn/polyfills/hermes.js (where DEBUG is already enabled before any `debug` copy loads), packages/reference-app-rn/index.js (polyfill order), packages/cadre-core/src/strand-instance-manager.ts and packages/cadre-core/src/cadre-node.ts (placeholder-style `timing(...)` calls; `timedStep` in cadre-node.ts already works around it), node_modules/debug/src/browser.js (`formatArgs`, `exports.log`)
repro: verified
severity: cosmetic
likelihood: normal-use
tradeoffs: Every value already appears in the line, just out of place, and the clean fix wraps `console.debug` for the whole app, so every library's debug output would pass through app code.
----

# React Native prints `debug` placeholders unfilled

## Observed

2026-09-15, Galaxy Note 9 (SM-N960U) debug build of `reference-app-rn`, JS from Metro, `adb logcat`:

```
D/ReactNativeJS(20664): 'sereus:cadre:timing [start] createControlNode: %dms +0ms', 368
D/ReactNativeJS(20664): 'sereus:cadre:timing [controlDb] hydrate: %dms (tables=%d, indexes=%d) +575ms', 575, 9, 0
```

In Node the same calls print `sereus:cadre:timing [start] createControlNode: 368ms +0ms`.

## Why

Metro bundles `debug`'s browser build. That build applies only its own formatters (`%o`, `%O`, `%j`) and leaves `%s`, `%d`, `%i` and `%f` in the text, relying on the browser console to substitute them. It writes through `console.debug`, which each copy captures once when it loads (`exports.log = console.debug || console.log || …`). React Native's console (`@react-native/js-polyfills/console.js`, through `nativeLoggingHook`) does no substitution: it prints every argument and quotes the strings when there is more than one. Every `debug` call in cadre-core uses placeholders, and a 2026-09-15 export bundled seven copies of `debug`.

The problem stayed invisible until `rn-create-strand-progress-and-founding-trace` enabled `DEBUG=sereus:cadre:timing` in development builds. That ticket's new founding-step lines build their text before calling `debug` (`timedStep` in `cadre-node.ts`), so they read correctly on the device; the older timing lines do not.

## Expected

Development-build log lines read on the device as they do in Node, for every namespace, including lines written later with placeholders.

## Constraints known so far

- The class fix has one site: give `console.debug` browser-style substitution of format specifiers (the WHATWG Console Standard's Formatter: `%s %d %i %f %o %O %c %%`) before any `debug` copy loads, which is the top of `polyfills/hermes.js`, where `DEBUG` is set. Each copy then captures the substituting function, so no call site changes. Rewriting each call to build its own text instead is many sites, and the next placeholder-style call regresses.
- The NativeScript reference app may have the same gap. Not checked.
