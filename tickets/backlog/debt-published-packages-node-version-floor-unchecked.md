description: The published packages either state no minimum Node.js version or state one lower than their own dependencies require, so the package manager's version warning names a dependency instead of the package the person installed, and nothing checks the stated minimum against the dependencies.
architecture: docs/contributing/gates.md#declared-dependency-ranges
files: packages/cadre-host/package.json, packages/cadre-provider/package.json, packages/cadre-cli/package.json, packages/cadre-core/package.json, packages/quereus-plugin-sereus/package.json, packages/cadre-rn/package.json, packages/config-check/package.json, scripts/check-dep-ranges.mjs, packages/cadre-cli/README.md, packages/cadre-host/README.md, packages/cadre-provider/README.md
tradeoffs: npm only warns on a version mismatch unless the user opted into strict checking, every README already says Node.js 20 or later, and Node.js 18 is past its end of life, so few people will meet the wrong declaration.
----

# Published packages' declared Node.js floor disagrees with their dependencies

## What is true today

Measured by reading the `engines.node` field of each published package under `packages/` and of each of its direct `dependencies` as installed in this checkout (a script that walks `node_modules`; transitive dependencies were not swept).

| Package | Declares | Highest floor among its direct dependencies |
| --- | --- | --- |
| `@serfab/cadre-host` | `>=18` | `>=20` (`commander` 14.0.2) |
| `@serfab/cadre-provider` | `>=18` | `>=20` (`commander` 14.0.2) |
| `@serfab/cadre-cli` | nothing | `>=20` (`commander` 14.0.2) |
| `@serfab/cadre-core` | nothing | `>= 20.19.0` (`@noble/ciphers`, `@noble/curves`, `@noble/hashes`, all 2.x) |
| `@serfab/quereus-plugin-sereus` | nothing | `>=20.6.0` (`@optimystic/quereus-plugin-optimystic` 1.27.0) |
| `@serfab/cadre-rn` | nothing | `>= 20.19.0` (`@noble/hashes` 2.x) |
| `@serfab/config-check` | nothing | no dependencies |

Two things follow.

- **cadre-host and cadre-provider declare a floor their own dependency refuses.** Both say `>=18` and both depend directly on a library that says `>=20`.
- **The real floor is higher than any README says.** cadre-cli and cadre-host depend on cadre-core, whose direct dependencies say `>= 20.19.0`. The three runtime READMEs say "Node.js 20 or later". Whether the packages run on Node.js 20.0 through 20.18 was not tested; the claim here is only that the declarations disagree.

The root `package.json` declares no `engines`, and the repository has no `.nvmrc` or `.node-version`, so nothing states the version the suites are run on either.

## Why it matters

npm compares `engines` at install time. When the installed package's own declaration is wrong or missing, the warning names a dependency several levels down, and the person installing `@serfab/cadre-host` on an old Node.js is not told that cadre-host needs a newer one.

## What this ticket delivers

- Each published package declares `engines.node`, and the declaration is not lower than the floor of any direct dependency.
- A check that fails when that stops being true. `scripts/check-dep-ranges.mjs` already reads every `packages/*/package.json` and compares its declared ranges with the manifests of the linked sibling packages, and runs under `yarn dep-check`; it is the natural home, or a sibling script beside it.
- The READMEs' stated minimum matches the declaration. cadre-rn runs on a phone, so its declaration covers only the Metro and Expo config code that runs on the developer's machine; say so there.

## Not decided here

Whether the check should follow transitive dependencies. Direct dependencies are enough to catch both instances above, since cadre-core's floor reaches cadre-cli and cadre-host through the workspace dependency once cadre-core declares it.
