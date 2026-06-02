// @ts-check
// Flat ESLint config for the Sereus monorepo (eslint 10 / typescript-eslint 8).
//
// Goal: machine-enforce the style rules in AGENTS.md. The repo previously had no
// eslint config at all, so this is a *gate*, not a cleanup pass. Rules that the
// codebase already satisfies (or that auto-fix cleanly) are `error`; rules with a
// large pre-existing backlog are `warn` so the gate stays green while the backlog
// is burned down separately. See the review handoff for the error/warn rationale
// and the list of AGENTS.md rules that are NOT enforceable here.
//
// AGENTS.md rule coverage (see tickets/review handoff for the full table):
//   - "avoid `any`"                  -> @typescript-eslint/no-explicit-any   (warn: backlog)
//   - "`void` unused promises"       -> @typescript-eslint/no-floating-promises (error, type-aware, src only)
//   - "`_` prefix unused args"       -> @typescript-eslint/no-unused-vars    (warn: backlog)
//   - "braces around case w/ locals" -> no-case-declarations                 (error, built-in)
//   - "ES modules"                   -> sourceType:module + no-require-imports (error)
//   - "no inline import()"           -> consistent-type-imports (partial; runtime inline import NOT enforceable)
//   - "don't eat exceptions"         -> no-empty allowEmptyCatch:false       (warn, partial)
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
			// "Don't be type lazy - avoid `any`" — large pre-existing backlog -> warn.
			'@typescript-eslint/no-explicit-any': 'warn',
			// "Prefix unused arguments with `_`" — backlog -> warn, but honor the `_` convention.
			'@typescript-eslint/no-unused-vars': ['warn', {
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
			// "Don't use inline `import()` unless dynamically loading" — partial: discourages
			// type-position import(); auto-fixable so kept as warn.
			'@typescript-eslint/consistent-type-imports': ['warn', {
				prefer: 'type-imports',
				disallowTypeAnnotations: false,
			}],
			// "exceptions should be exceptional - not control flow / don't eat exceptions" — partial.
			'no-empty': ['warn', { allowEmptyCatch: false }],
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
			// {@html ...} is used deliberately in the diagnostics UIs; flag for review, don't block.
			'svelte/no-at-html-tags': 'warn',
			// Plain Set/Date inside .svelte.ts rune modules — a svelte-5 reactivity
			// correctness lint with a real backlog. Surface it, don't block the gate.
			'svelte/prefer-svelte-reactivity': 'warn',
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
			'@typescript-eslint/no-unused-vars': ['warn', {
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				caughtErrorsIgnorePattern: '^_',
			}],
		},
	},

	// ---- Downgrade eslint-10 recommended additions with a pre-existing backlog ----
	// These are NOT AGENTS.md rules; they ship as `error` in eslint 10's recommended
	// set. Keep them visible as `warn` (gate stays green) and burn the backlog down
	// in a follow-up — see the review handoff.
	{
		rules: {
			'preserve-caught-error': 'warn',  // throw new Error(...) without { cause } — backlog
			'no-useless-assignment': 'warn',
			'no-control-regex': 'warn',
			// Flags `let` assigned once; false-positives on test `let x; beforeEach(() => x = …)` lifecycles.
			'prefer-const': 'warn',
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
