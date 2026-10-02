# @serfab/config-check

Strict checking of a parsed config file, shared by Sereus's own packages (`@serfab/cadre-cli` and `@serfab/cadre-provider` today). It has no runtime dependencies and no Node-specific imports, so a package can use it without taking on the node's networking stack.

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
```

For a file holding only `nmae: demo`, `validateTree` throws:

```
Config /etc/app.yaml: unknown key nmae (did you mean 'name'?)
Config /etc/app.yaml: name is required
```

With `APP_VERBOSE=yes` set, `applyEnvOverrides` throws first, from the parser: `Invalid APP_VERBOSE "yes": expected true, false, 1 or 0`. A problem is attributed to `Environment variable X` when a variable's parser accepts text that the checker then rejects, for example a plain string written where `oneOf` expects one of a closed set.

## Public functions

- `validateTree(tree, root, { configPath, provenance?, suppliersOf?, concealUnder? })` — check a whole tree; empty file = empty mapping. `concealUnder` lists key paths whose whole subtree holds hand-written secrets (cadre-provider's `push` and `billing`): a rejected value at or under one is described by kind only (`a string`, `a mapping`), never echoed.
- `applyEnvOverrides(raw, env, overrides, onApply?)` — write set variables over a tree without modifying it; returns the merged tree and which variable wrote which path. Empty and whitespace-only values count as unset (`specifiedEnv`).
- Checkers: `stringValue`, `nonEmptyString`, `secretString` (never echoes the value), `booleanValue`, `finiteNumber`, `positiveNumber`, `nonNegativeNumber`, `nonNegativeInteger`, `numberWhere`, `oneOf`, `arrayOf`, `objectOf` (with `required` and `retired` keys), `recordOf` (a mapping under caller-chosen keys such as tenant ids; a `null` value is reported, not treated as absent), `refine` (rules spanning several keys).
- Environment text parsers: `parseBooleanEnv`, `parseNumberEnv`, `parseListEnv`.
- Helpers: `ValidationContext` (for hand-written checkers — describe a rejected value through `ctx.describe(keyPath, value)` so `concealUnder` applies), `describeValue`, `kindOf`, `isPlainObject`, `isPathPrefix`, `nearestKey` (the "did you mean" suggestion).
