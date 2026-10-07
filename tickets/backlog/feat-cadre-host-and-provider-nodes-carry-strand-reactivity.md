description: Let the always-on nodes that cadre-host and cadre-provider start for a party turn on strand change notifications too, because push wakes only work when every machine storing a strand has the setting on.
prereq: strand-reactivity-scenario
architecture: docs/strands.md
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts (buildChildConfig), packages/cadre-provider/src/, packages/cadre-cli/src/config/env.ts (ENV_MAPPINGS), docs/cadre-host.md
tradeoffs: No app turns strand reactivity on yet, and a cadre-host node's party is chosen by a claim or an invitation that carries no node options today, so this may wait until an app actually depends on push wakes.
----
# cadre-host and cadre-provider nodes carry strand reactivity

`strand-reactivity-node-option` adds `CadreNodeConfig.strandReactivity` and the cadre-cli config key `strandReactivity`. A collection's change notifications are announced and served by the machines that store its log tail, so a strand gets push wakes only when every machine serving it has the option on (docs/strands.md, change-notification section). A party's always-on machines are usually cadre-host or cadre-provider nodes, and neither can turn it on today:

- **cadre-host hosted nodes**: `buildChildConfig` builds them from the host's join request, which the host's admin makes before any party is known; the party arrives later, with the claim or the invitation. Whether a hosted node announces its party's strands is that party's choice, so the setting has to reach the node from the party, not from the host's admin.
- **cadre-provider containers**: configured through `CADRE_*` environment variables; the CLI has no variable for `strandReactivity` (`ENV_MAPPINGS` in `cadre-cli/src/config/env.ts`). Add one (`kind: 'json'`, like `CADRE_PUSH`) and the provider's request path that sets it.

Expected behaviour: the party a cadre-host node or a provider container serves can enable strand reactivity on it for all or named strands, with the same fail-closed filter as cadre-core; absent, nothing changes.
