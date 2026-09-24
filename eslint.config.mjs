// @ts-check
// Flat ESLint config for the Sereus monorepo (eslint 10 / typescript-eslint 8).
//
// Goal: machine-enforce the style rules in AGENTS.md. The repo previously had no
// eslint config at all, so this started as a *gate*, not a cleanup pass: rules the
// codebase already satisfied (or that auto-fixed cleanly) shipped as `error`, while
// rules with a large pre-existing backlog shipped as `warn` and were burned down
// separately. That cleanup epic is now complete — the mechanical backlog (unused-
// vars, preserve-caught-error, no-empty, no-useless-assignment, no-control-regex,
// prefer-const, consistent-type-imports), `no-explicit-any`, and the svelte rules
// (no-at-html-tags, prefer-svelte-reactivity) are all enforced as `error`. There is
// no remaining `warn` backlog; every rule below is a hard gate. See the review
// handoff for the rationale and the AGENTS.md rules NOT enforceable here.
//
// AGENTS.md rule coverage (see tickets/review handoff for the full table):
//   - "avoid `any`"                  -> @typescript-eslint/no-explicit-any   (error)
//   - "`void` unused promises"       -> @typescript-eslint/no-floating-promises (error, type-aware, src only)
//   - "`_` prefix unused args"       -> @typescript-eslint/no-unused-vars    (error)
//   - "braces around case w/ locals" -> no-case-declarations                 (error, built-in)
//   - "ES modules"                   -> sourceType:module + no-require-imports (error)
//   - "no inline import()"           -> consistent-type-imports (error, partial; runtime inline import NOT enforceable)
//   - "don't eat exceptions"         -> no-empty allowEmptyCatch:false       (error, partial)
//   - "lowercase SQL reserved words" -> NOT machine-enforceable (SQL in template literals) — human review only
//   - "tabs for code"                -> deferred to .editorconfig, not enforced here (avoid formatter war)

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';

// ---- `no-restricted-syntax` selector sets ----
// A flat-config entry that sets `no-restricted-syntax` REPLACES the rule's options for every
// file it matches — entries do not merge — so each scope below spells out its full list, built
// from these shared pieces. Adding a selector set means adding it to every scope that should
// keep it, and to any exemption entry that switches the rule off for a file that should not
// lose it.

// `CadreControl.CadrePeer` writes must go through ControlDatabase. Literal SQL only: a
// statement assembled from variables slips through, as does an unqualified
// `insert into CadrePeer` (every control statement in the tree names the schema). Deliberate —
// this targets the copy-paste mistake, not a determined bypass.
const CADRE_PEER_WRITE_MESSAGE = 'Write CadreControl.CadrePeer through ControlDatabase.insertCadrePeer / reauthorizeCadrePeer / deleteCadrePeer — they wrap mutateCadrePeer, which refreshes the party-membership snapshot the control-traffic gate reads. Direct SQL skips that refresh.';
const CADRE_PEER_WRITE_SQL = 'insert\\s+into\\s+CadreControl\\.CadrePeer|update\\s+CadreControl\\.CadrePeer|delete\\s+from\\s+CadreControl\\.CadrePeer';
const CADRE_PEER_WRITE_GUARD = [
	{
		// Plain-string SQL (the form the specs use).
		selector: `Literal[value=/${CADRE_PEER_WRITE_SQL}/i]`,
		message: CADRE_PEER_WRITE_MESSAGE,
	},
	{
		// Backtick SQL (the form the sources use).
		selector: `TemplateElement[value.raw=/${CADRE_PEER_WRITE_SQL}/i]`,
		message: CADRE_PEER_WRITE_MESSAGE,
	},
];

// Web APIs the phone runtimes lack. Both phone apps (Hermes under React Native, V8 under
// NativeScript) run our first-party source, and the polyfills in reference-app-rn/polyfills/
// hermes.js and reference-app-ns/src/polyfills/ exist for the dependencies (libp2p and friends)
// that call these. Our own code should not add to that dependence: a polyfill is a fallback
// for code we do not control, and it cannot see when a caller is finished with what it made —
// `AbortSignal.any` in particular leaves listeners on its inputs if none of them ever aborts.
// The replacements are plain constructs every runtime has.
//
// `AbortSignal.prototype.throwIfAborted()` is deliberately not banned: libp2p and its
// dependencies require it regardless, both phone apps polyfill it, and banning it here would
// move that requirement into this file without removing it. Optimystic's config draws the
// same line.
//
// Mirrors ../optimystic/eslint.config.js, which closed this class in its own packages.
const PHONE_RUNTIME_GUARD = [
	{
		selector: "CallExpression[callee.object.name='AbortSignal'][callee.property.name='timeout']",
		message: 'AbortSignal.timeout is missing or unreliable on Hermes/React Native and NativeScript. Use an explicit AbortController plus a timer, cleared on every exit path — see startBudget in packages/cadre-core/src/formation-approval.ts.',
	},
	{
		selector: "CallExpression[callee.object.name='AbortSignal'][callee.property.name='any']",
		message: 'AbortSignal.any is missing on Hermes/React Native and NativeScript, and the polyfill cannot release the listeners it attaches to inputs that never abort. Combine signals with an explicit relay whose removeEventListener runs in a finally — see startBudget in packages/cadre-core/src/formation-approval.ts.',
	},
	{
		selector: "CallExpression[callee.object.name='Promise'][callee.property.name='withResolvers']",
		message: 'Promise.withResolvers is ES2024 and Hermes/React Native does not provide it. Build the { promise, resolve, reject } triple by hand instead.',
	},
	{
		selector: "NewExpression[callee.name='DOMException']",
		message: 'DOMException construction is not guaranteed under Hermes/React Native or NativeScript. Throw a plain Error with its `name` set instead.',
	},
];

// `packages/*/src` is the first-party source of every package, including the two browser-only
// apps (reference-app-web, cadre-host/ui) where these APIs exist — accepted deliberately: they
// have no uses there today, and a browser-only need is one `eslint-disable-next-line` with its
// reason. `cadre-host/ui/src` sits one level deeper than the `packages/*/src` glob reaches.
//
// NOTE: `.svelte` component scripts are outside this scope, so a browser-app component could
// use these APIs unflagged. None does today (searched packages/*/src and cadre-host/ui/src,
// 2026-09-24); if one starts to, add the `.svelte` globs here.
const PHONE_RUNTIME_SCOPE = [
	'packages/*/src/**/*.{ts,tsx,mts,cts}',
	'packages/cadre-host/ui/src/**/*.{ts,tsx,mts,cts}',
];

export default tseslint.config(
	// ---- Global ignores (generated / vendored / out-of-scope) ----
	{
		ignores: [
			'**/dist/**',
			'**/node_modules/**',
			'**/build/**',
			'**/coverage/**',
			'**/.expo/**',
			'**/.svelte-kit/**',
			'**/playwright-report/**',
			'**/test-results/**',
			'**/*.d.ts',
			// RN native/build dirs
			'packages/reference-app-rn/android/**',
			'packages/reference-app-rn/ios/**',
			// NativeScript generated native/build output (gitignored, like the RN dirs above):
			// minified Android bundle/vendor/runtime artifacts and build-tools.
			'packages/reference-app-ns/platforms/**',
			'packages/reference-app-ns/hooks/**',
			// Maestro e2e helper scripts run in Maestro's own JS engine with
			// injected globals (http/json/output/env) — not node/browser ES modules.
			'packages/reference-app-rn/maestro/**',
			// repo tooling outside the package set (own tsconfigs / scope)
			'ops/**',
			'tess/**',
			'scripts/**',
			'**/scripts/**',
		],
	},

	// ---- Base recommended (JS + TS, non type-checked) ----
	js.configs.recommended,
	...tseslint.configs.recommended,

	// ---- Environment globals (TS sources may target node and/or browser) ----
	{
		languageOptions: {
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
	},

	// ---- AGENTS.md style rules (TS sources) ----
	// Scoped to TypeScript: the repo's `.js`/`.cjs`/`.mjs` files are all tooling,
	// config, and platform polyfills (metro.config.js, hermes polyfill, svelte
	// configs) where CommonJS `require` is intentional, so the ESM/`require` rule
	// would produce false positives there. App/library source is all TypeScript.
	{
		files: ['**/*.{ts,tsx,mts,cts}'],
		rules: {
			// "Don't be type lazy - avoid `any`" — backlog burned down, enforced as error.
			'@typescript-eslint/no-explicit-any': 'error',
			// "Prefix unused arguments with `_`" — enforced as error; honors the `_` convention.
			'@typescript-eslint/no-unused-vars': ['error', {
				args: 'all',
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				caughtErrors: 'all',
				caughtErrorsIgnorePattern: '^_',
				destructuredArrayIgnorePattern: '^_',
				ignoreRestSiblings: true,
			}],
			// "ES Modules" — flag CommonJS require() in source.
			'@typescript-eslint/no-require-imports': 'error',
			// "Don't use inline `import()` unless dynamically loading" — partial: enforces
			// type-position `import type`; runtime inline import() remains human-review-only.
			'@typescript-eslint/consistent-type-imports': ['error', {
				prefer: 'type-imports',
				disallowTypeAnnotations: false,
			}],
			// "exceptions should be exceptional - not control flow / don't eat exceptions" — partial.
			'no-empty': ['error', { allowEmptyCatch: false }],
			// "Enclose `case` blocks in braces if any consts/variables" (built-in, in js.recommended) — keep explicit.
			'no-case-declarations': 'error',
		},
	},

	// ---- `no-restricted-syntax`: CadrePeer writes everywhere, phone-runtime APIs in package src ----
	// Every write to the party-membership table has to refresh the in-memory snapshot of
	// approved members, or the node starts denying control traffic from the member it just
	// approved. `ControlDatabase.mutateCadrePeer` is what triggers that refresh, and the
	// three public methods named in the message are the only writers that wrap it. A raw
	// `getDatabase().exec('insert into CadreControl.CadrePeer …')` compiles and runs
	// happily while skipping the refresh — a mistake that has been made twice — so flag
	// the SQL itself (CADRE_PEER_WRITE_GUARD, above).
	//
	// First-party package source additionally gets PHONE_RUNTIME_GUARD (above). A later entry
	// replaces an earlier one's options for the files it matches, so the source scope repeats
	// the CadrePeer selectors rather than adding to them.
	{
		files: ['**/*.{ts,tsx,mts,cts}'],
		rules: {
			'no-restricted-syntax': ['error', ...CADRE_PEER_WRITE_GUARD],
		},
	},
	{
		files: PHONE_RUNTIME_SCOPE,
		rules: {
			'no-restricted-syntax': ['error', ...CADRE_PEER_WRITE_GUARD, ...PHONE_RUNTIME_GUARD],
		},
	},
	{
		// The exemptions (flat config: a later entry wins, so these must follow the rules).
		// The destination itself — these ARE the wrapped writers. It is package source, so
		// only the CadrePeer selectors come off; the phone-runtime ones stay.
		files: ['packages/cadre-core/src/control-database.ts'],
		rules: {
			'no-restricted-syntax': ['error', ...PHONE_RUNTIME_GUARD],
		},
	},
	{
		files: [
			// Constraint fixtures: all drive raw SQL at a bare Quereus database on purpose,
			// to test the schema's authorization/revocation CHECKs. No membership snapshot
			// exists in any — there is no ControlDatabase in the picture at all.
			'packages/cadre-core/test/control-authorization-domain-separation.spec.ts',
			'packages/cadre-core/test/control-revocation-replay.spec.ts',
			'packages/cadre-core/test/control-revocation-reap.spec.ts',
			// Plants a CadrePeer row whose stamp is literally the Revocation ledger marker's,
			// which insertCadrePeer cannot do (it mints its own stamp).
			'packages/cadre-core/test/control-revocation-ledger-marker.spec.ts',
		],
		rules: {
			'no-restricted-syntax': 'off',
		},
	},
	// ---- Type-aware rules (node/library src only) ----
	// `no-floating-promises` needs type information. Scope it to package `src/` trees
	// whose tsconfig.json resolves cleanly under NodeNext; the bundler/expo apps
	// (reference-app-web, reference-app-rn, cadre-host/ui) are intentionally excluded
	// to keep the type-aware pass fast and resolvable — see handoff for the deferral.
	{
		files: [
			'packages/cadre-core/src/**/*.ts',
			'packages/cadre-cli/src/**/*.ts',
			'packages/cadre-host/src/**/*.ts',
			'packages/cadre-provider/src/**/*.ts',
			'packages/quereus-plugin-sereus/src/**/*.ts',
			'packages/integration-tests/src/**/*.ts',
		],
		// NOTE: the repo-root `test-harness/` and the packages' `test/` trees are
		// outside this pass — neither is covered by a `tsconfig.json` the project
		// service can find (the packages' include only `src`, and test-harness has
		// no tsconfig at all; `tsconfig.typecheck.json` is not what the service
		// picks up). Nothing there is async today, so `no-floating-promises` has
		// nothing to bite on. If test infrastructure ever grows promises, give
		// test-harness its own `tsconfig.json` and add both globs here.
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
		},
	},

	// ---- Svelte UIs (reference-app-web, cadre-host/ui) ----
	...svelte.configs.recommended,
	{
		// `.svelte` components plus svelte 5 rune modules (`.svelte.ts`/`.svelte.js`):
		// hand the svelte parser the TS parser so `<script lang="ts">` and typed rune
		// modules parse (no type-aware info — keeps the svelte pass fast).
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
			},
		},
		rules: {
			// {@html ...} XSS guard — enforced. The sole deliberate use (QrCode.svelte,
			// rendering a locally-generated QR SVG) carries a scoped eslint-disable + rationale.
			'svelte/no-at-html-tags': 'error',
			// Plain Set/Date/Map inside .svelte.ts rune modules — a svelte-5 reactivity
			// correctness lint. Enforced; the existing sites were all transient/replace-only
			// false positives (local dedup sets, transient Dates serialized to strings) and
			// carry scoped eslint-disable + rationale. Genuine in-place-mutation state must
			// use SvelteSet/SvelteDate/SvelteMap from svelte/reactivity.
			'svelte/prefer-svelte-reactivity': 'error',
		},
	},

	// ---- JS/CJS/MJS tooling (configs, polyfills, sidecar) ----
	// typescript-eslint's recommended rules apply to all files, not just TS; on the
	// repo's CommonJS tooling that misfires. Turn off the ESM/require rule there and
	// honor the `_`-prefix convention for unused vars.
	{
		files: ['**/*.{js,cjs,mjs}'],
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/no-unused-vars': ['error', {
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				caughtErrorsIgnorePattern: '^_',
			}],
		},
	},

	// ---- eslint-10 recommended additions ----
	// These are NOT AGENTS.md rules; they ship as `error` in eslint 10's recommended
	// set. Their pre-existing backlog has been burned down (lint-cleanup-mechanical),
	// so they are enforced as `error`.
	{
		rules: {
			'preserve-caught-error': 'error',  // throw new Error(...) must forward { cause }
			'no-useless-assignment': 'error',
			// Enforced; the one deliberate control-char guard (npm spawn-arg validation
			// in update/apply.ts) carries a scoped eslint-disable with a rationale.
			'no-control-regex': 'error',
			// Can false-positive on `let x!; beforeEach(() => x = …)` test lifecycles —
			// none exist today; if one appears, use a scoped disable rather than `const`.
			'prefer-const': 'error',
		},
	},

	// ---- Playwright e2e fixtures use empty destructuring (`async ({}, info) => …`) ----
	{
		files: ['**/e2e/**/*.ts', '**/*.spec.ts', '**/*.test.ts'],
		rules: {
			'no-empty-pattern': 'off',
		},
	},
);
