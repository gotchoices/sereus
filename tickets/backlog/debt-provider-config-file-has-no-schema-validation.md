description: The multi-tenant provider service reads its own configuration file without checking it, so a misspelled setting is silently ignored — and a stray field in its push-credential block is passed straight through to every tenant's node, which (once the node config is strictly checked) makes those nodes refuse to start long after the provider itself started fine.
files: packages/cadre-provider/src/config/loader.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/service/container-service.ts
tradeoffs: The provider is operated by the people who wrote it and its config is small, so silent typos there are less likely than in operator-edited node configs; strictness also turns a stray key into a provider that refuses to start.
----

# cadre-provider config is cast, not validated

`cadre-provider`'s `loadConfig` (`src/config/loader.ts`) deep-merges defaults, the config file, environment variables and overrides, then checks only the auth block (`validateAuthConfig`) and push completeness (`validatePushConfig`). Unknown keys and wrong types elsewhere pass silently — the same defect `cli-config-strict-validation` fixes for cadre-cli.

It has one cross-package consequence. The provider resolves each tenant's push credentials from its own config (`resolveTenantPush` in `container-service.ts`) and forwards the object verbatim as `CADRE_PUSH=${JSON.stringify(request.push)}` (`container-env.ts`). cadre-cli now rejects unknown keys inside `push`, so an extra key in the provider's push block surfaces as each tenant node failing to start — at provision time, per tenant, instead of once at provider start.

Expected behaviour:

- The provider's config file is checked with the same strictness as cadre-cli's (maintainer decision 2026-09-28: unknown key or ill-typed value fails start, naming the key and the file).
- At minimum, the push block (default and per-tenant) is checked for unknown keys at provider start, or the provider builds `CADRE_PUSH` field by field from known fields (as cadre-host's `resolvePushCredentials` does) so it cannot forward what the node will reject.
