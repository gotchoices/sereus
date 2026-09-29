# @serfab/config-check

Strict checking of a parsed config file, shared by Sereus's own packages (`@serfab/cadre-cli` today). It has no runtime dependencies and no Node-specific imports, so a package can use it without taking on the node's networking stack.

It is not a general-purpose schema library. It exists so that every Sereus program that reads a config file rejects unknown keys, wrong types and missing required keys the same way, reports every problem in one error, and names the source of each one: the config file, or the environment variable that wrote the offending value.

## How it is used

A config level is a *field table*: one checker per key, typed against the TypeScript type it validates, so a key added to the type without a checker fails to compile. `objectOf` turns a table into a checker; `validateTree` runs the root checker and throws one `Error` listing every problem.

```ts
import { applyEnvOverrides, booleanValue, nonEmptyString, objectOf, parseBooleanEnv, validateTree } from '@serfab/config-check';

interface Config { name: string; verbose?: boolean }

const root = objectOf<Config>({ name: nonEmptyString, verbose: booleanValue }, { required: ['name'] });

const { tree, provenance } = applyEnvOverrides(parsedFile, process.env, {
	APP_VERBOSE: { path: 'verbose', parse: parseBooleanEnv },
});
const config = validateTree(tree, root, { configPath: '/etc/app.yaml', provenance });
// Config /etc/app.yaml: unknown key nmae (did you mean 'name'?)
// Environment variable APP_VERBOSE: ...
```

## Public functions

- `validateTree(tree, root, { configPath, provenance?, suppliersOf? })` — check a whole tree; empty file = empty mapping.
- `applyEnvOverrides(raw, env, overrides, onApply?)` — write set variables over a tree without modifying it; returns the merged tree and which variable wrote which path. Empty and whitespace-only values count as unset (`specifiedEnv`).
- Checkers: `stringValue`, `nonEmptyString`, `secretString` (never echoes the value), `booleanValue`, `finiteNumber`, `positiveNumber`, `nonNegativeNumber`, `nonNegativeInteger`, `numberWhere`, `oneOf`, `arrayOf`, `objectOf` (with `required` and `retired` keys), `refine` (rules spanning several keys).
- Environment text parsers: `parseBooleanEnv`, `parseNumberEnv`, `parseListEnv`.
- Helpers: `ValidationContext` (for hand-written checkers), `describeValue`, `kindOf`, `isPlainObject`, `nearestKey` (the "did you mean" suggestion).
