description: The SQL plugin ships a ready-made single file meant to be loaded into a browser tool by web address, but that file still refers to the SQL engine by package name, which a browser cannot resolve, so loading it by address fails before the plugin starts. The build script says the file contains no such reference, and the tests that guard the file cannot see it.
architecture: packages/quereus-plugin-sereus/README.md#loading-in-quoomb-web
files: packages/quereus-plugin-sereus/scripts/build-browser.mjs, packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/app-schema-version.ts, packages/quereus-plugin-sereus/src/app-schema-waits.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/src/plugin-browser.ts, packages/quereus-plugin-sereus/test/browser-bundle.spec.ts, packages/quereus-plugin-sereus/test/browser-shape.spec.ts, packages/quereus-plugin-sereus/vitest.config.ts, docs/contributing/gates.md
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The package README now states this as a limit, an app that bundles the plugin itself is unaffected, and the right fix depends on how Quoomb decides a plugin loaded by address should reach the host's engine, which is an open ticket in another repository; a maintainer may wait for that.
----

# The prebuilt browser bundle cannot be loaded by URL

## What the bundle is for

`packages/quereus-plugin-sereus/scripts/build-browser.mjs` builds `dist/plugin-browser.js` with esbuild. Its header says the file is "a single ESM artifact … consumable by Quereus plugin-loader via `dynamicLoadModule(url, ...)`". `src/plugin-browser.ts` says to "load via Quoomb-web's plugin URL field or `plugins[].source` in `quoomb.config.json`". `docs/contributing/gates.md` → "Browser bundle checks" describes it as a bundle "that a browser host fetches and loads in a worker". Quoomb is the SQL tool that ships with Quereus, the SQL engine; Quoomb Web loads a plugin by handing its URL to the browser's `import()`.

## The defect

The build marks `@quereus/quereus` as external, with this comment:

> Hosts (Quoomb-web's worker) already have their own `@quereus/quereus` instance. We do not import it at runtime — see `connect-browser.ts` — but mark it external defensively in case a transitive import path reaches it. The worker will not see this import because the resolved module graph never references it.

`src/connect-browser.ts` repeats the claim ("no runtime `@quereus/quereus` import").

The built file contradicts it. `dist/plugin-browser.js` (version 1.23.0, built 2026-11-14) contains five `from"@quereus/quereus"` import statements. They bring in `Database`, `QuereusError`, `StatusCode`, `TransactionActiveError`, `FunctionFlags`, `TEXT_TYPE`, `BOOLEAN_TYPE` and `INTEGER_TYPE`.

Three come from this package's own sources, which import values, not only types:

- `src/app-schema.ts`: `Database`, `QuereusError`, `StatusCode`;
- `src/app-schema-version.ts`: `QuereusError`, `StatusCode`;
- `src/app-schema-waits.ts`: `TransactionActiveError`.

The function-flag and type-constant import matches `plugin.ts` in `@optimystic/quereus-plugin-optimystic` and `@optimystic/quereus-plugin-crypto`, which are bundled in.

A browser resolves a package name in a module fetched by URL only through an import map. Quoomb Web supplies none (`../quereus/packages/quoomb-web/index.html`), and its worker passes the URL straight to `import()`. So the import fails while the module is linked, before `register` runs. This is inferred from the file's contents and from how browsers resolve module specifiers; the bundle was not loaded in a browser. Serving `dist/plugin-browser.js` over https and importing it from a worker would confirm it.

## Why the tests do not see it

- `test/browser-bundle.spec.ts` reads the file as text and rejects a fixed list of imports (`FORBIDDEN_BARE_IMPORTS`: `@libp2p/tcp` and eight `node:` modules). `@quereus/quereus` is not on it, and no rule says "no bare import at all".
- `test/browser-shape.spec.ts` imports the bundle under Node (`vitest.config.ts` marks it `server.deps.external`, so Node loads it directly). Node resolves `@quereus/quereus` from `node_modules`, so the import succeeds there.

`gates.md` already says the checks cannot tell "whether the bundle works in a real browser worker". This is a narrower gap than that: whether the file is self-contained can be checked from its text.

## Who is and is not affected

- **Affected:** loading the published file by URL, in Quoomb Web or any host that uses the Quereus plugin loader in a browser. The package README → "Loading in Quoomb Web" now says this does not work.
- **Not affected:** an app whose bundler includes the plugin. `package.json` maps the `browser` condition of the package root to this same file, and the bundler resolves the name to the app's own Quereus.

## Expected behaviour

The package says one thing about the prebuilt file and the file matches it. Either the file can be loaded by URL in the host it names, or the build script, `plugin-browser.ts`, `connect-browser.ts` and `gates.md` stop saying it can and describe it as a bundler input.

Whichever is chosen, a check on the built text fails when the file's imports differ from what the package promises: no bare imports if it is meant to stand alone, exactly `@quereus/quereus` if the host is meant to supply it.

## What this depends on

How a plugin loaded by URL is supposed to reach the host's engine is not settled on the Quereus side: `../quereus/tickets/backlog/bug-plugin-loaded-by-url-in-a-browser-cannot-import-the-engine` (filed with this ticket). Bundling a private copy of Quereus would make the file load, and would give the plugin a second engine: `app-schema.ts` constructs a `Database`, and the three source files above recognise errors with `instanceof QuereusError` and `instanceof TransactionActiveError`, tests that an error thrown by the host's copy of the engine would fail against the plugin's copy. Whether that is acceptable is the same question that ticket asks.

Two neighbouring findings from the same reading are on the Quereus board, not here, because they are Quoomb's behaviour: its Plugins window registers a plugin with empty settings, which this plugin refuses because `strand_id` is required (`bug-quoomb-web-cannot-install-a-plugin-that-needs-a-setting`), and its loader refuses `http://localhost` (`feat-plugin-loader-accepts-a-local-dev-server-url`).
