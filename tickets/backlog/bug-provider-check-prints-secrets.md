description: The provider's "check my configuration" command prints the whole loaded configuration to the terminal, including push-notification private keys and payment-service secret keys, so running it in a shared terminal or a CI job leaks them into the output.
files: packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/src/config/validate.ts
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: The operator running `check` usually owns the secrets already, so the leak only matters when that output is captured somewhere shared (CI logs, a pasted support request).
----

`cadre-provider check -c <file>` (`packages/cadre-provider/src/bin/provider.ts`, the `check` command) calls `loadConfig` and then `console.log(JSON.stringify(config, null, 2))`. That object holds `push.default` / `push.tenants.*` `fcm.privateKey` and `apns.privateKey` (PEM private keys) and `billing.stripeSecretKey` / `billing.stripeWebhookSecret` when configured. `loadConfig` itself is careful: its debug dump goes through `redactPushConfig` (`config/validate.ts`). The `check` command bypasses that.

Found by reading the code while planning `provider-config-strict-validation`; not run. Confirm by running `node packages/cadre-provider/dist/bin/provider.js check -c <file with a push block>`.

Expected: `check` prints the configuration with every secret replaced (push private keys and both Stripe secrets), or prints only "Configuration is valid". One redaction function should cover both the debug dump and this output, so a secret field added later is redacted in both places or neither.
