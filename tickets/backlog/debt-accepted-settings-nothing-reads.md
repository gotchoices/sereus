description: Several programs accept, validate and document settings that no code ever reads, so an operator can set them, see no error, and get none of the behaviour the setting's name promises. Nothing checks that a declared setting has a reader.
architecture: docs/contributing/gates.md#checks-that-run-as-tests
files: packages/cadre-provider/src/config/schema.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/config/env.ts, packages/cadre-provider/src/config/loader.ts, packages/cadre-provider/src/service/billing-service.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/server/auth.ts, packages/cadre-host/src/installer/config.ts, packages/cadre-host/src/server/routes/settings.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/package.json, packages/cadre-cli/src/commands/enroll.ts, packages/config-check/src
tradeoffs: The READMEs now say of each of these settings that it is not read, so nobody is misled who reads that far, and a mechanical "every key has a reader" check needs a way to find readers that is not a text search, which may cost more than deleting the five instances by hand.
----

# Settings that are accepted and validated but never read

## The class

A setting is declared in a config schema, a typed options object or a command's option list. The program validates it, sometimes maps an environment variable onto it, sometimes redacts it in output, and then no code reads it. The operator gets no error and no effect.

Strict config checking (`@serfab/config-check`) already refuses a key the schema does not know. Nothing does the opposite check, that a key the schema knows is used. The instances below were each found by a person reading the code during the documentation rewrite, and each was confirmed for this ticket by searching the package's `src` for every reference to the name.

## What this ticket delivers

An invariant, enforced by a test or check that runs under `yarn test` or `yarn lint`: every setting a program declares is read by that program, or is marked in its declaration as passed through for the embedding application's own code. With the invariant in place, each instance below is either wired to a reader, removed, or marked.

How the check finds a reader is the open design point. A text search over source would be a weak check. Two mechanisms that avoid one, to be weighed when this is planned:

- The TypeScript compiler's `noUnusedLocals` option reports a private class field that is assigned and never read. No `tsconfig` in the repository turns it on. It should report the billing hooks instance; this was not tried. It does not see properties of an interface.
- The TypeScript language service can list the references to each property of a config type. A check script could require at least one reference outside the package's `config/` folder for every property of the config types that the schema accepts.

A related mark is already wished for at the same place: the `NOTE:` above the redaction list in `packages/cadre-provider/src/config/loader.ts` says the schema's secret mark "carries no metadata", so the redaction list and the schema can drift apart. If the schema entries carried metadata, both the redaction list and a "passed through, not read here" mark could come from it.

## Instances

### cadre-provider: Stripe keys

`billing.stripeSecretKey` and `billing.stripeWebhookSecret` are in `BillingConfig`, in the schema, mapped from `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `config/env.ts`, and redacted in `config/loader.ts`. No other file in `packages/cadre-provider/src` mentions them. The provider calls no payment processor.

### cadre-provider: token-checking settings

`auth.jwksUri`, `auth.issuer` and `auth.audience` are in `AuthConfig` with the comments "JWKS endpoint", "expected issuer" and "expected audience", in the schema, and mapped from `PROVIDER_JWKS_URI`, `PROVIDER_ISSUER` and `PROVIDER_AUDIENCE`. Nothing reads them. In `oauth` mode a bearer token that the provider did not issue goes to the embedder's `validateJwt` hook (`oauthIdentity` in `server/auth.ts`), which receives the token alone. With no hook the token is rejected.

This instance can mislead in a way that matters for security: an operator who sets "expected issuer" and "expected audience" may believe the provider checks them. A hook that verifies only the signature would then accept a token minted for a different audience.

### cadre-provider: billing hooks (a missing feature)

`createProviderServer` accepts `billingHooks` (`BillingHooks`: `processPayment`, `getPaymentMethod`, `sendInvoice`), and the type is exported from the package. `BillingService` stores the object in its `hooks` field and never reads the field. No hook is ever called.

An embedder who passes `processPayment` would reasonably expect the provider to call it. The provider computes no charges (see the README's Billing section), so there is no moment at which it could. Either the hooks are removed from the public surface, or charging is designed and they are called. Charging is a feature decision, not a cleanup.

### cadre-host: a second copy of the port-mapping switch

`HostConfigFile.upnpEnabled` in `installer/config.ts` is written by the installer and required by `isHostConfigShape`. Its comment says it decides "whether UPnP/NAT-PMP should be attempted at start time". Nothing reads it for that. The setting the NAT service acts on is `upnpEnabled` in `nat.json` (`NatStore`), which the installer seeds from the same answer.

The two copies can disagree. `PUT /api/settings` writes both. `cadre-host nat settings` and the UI's Connectivity page call `PUT /nat/settings`, which writes only `nat.json`. After either, `GET /api/settings` returns the old value from `host.config.json`.

### quereus-plugin-sereus: app id and app version

`StrandConnectionBaseOptions` declares `sAppId` and `sAppVersion`. The virtual-table arguments `sapp_id` and `sapp_version` are parsed in `parse-config.ts` (defaults `'unknown'` and `'1.0.0'`) and copied into those options, and `package.json` lists both as plugin settings with those defaults. No file in `packages/quereus-plugin-sereus/src` reads either option. The schema version that the connection does act on is the separate `schemaVersion`.

### cadre-cli: a config option on a command that reads no config

`cadre enroll register` declares `-c, --config <path>` with the help text "accepted for compatibility; not used by this offline check". The action never reads `options.config`. The project has no backward-compatibility commitment yet, so the option has no reason to exist.

## Not swept

The five programs' full key lists were not checked against their readers; only the names above were. The check this ticket asks for is what would find the rest.
