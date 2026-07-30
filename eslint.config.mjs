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
			// deprecated package
			'packages/strand-proto/**',
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
