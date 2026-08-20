---
description: The node's configuration file is read without any checking — a misspelled setting is silently ignored rather than reported, so the node starts up with a default the operator never intended and no error to explain why.
files: packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/example.cadre.yaml
prereq: collapse-cli-identity-key-file-formats
tradeoffs: Strict rejection of unknown keys is a real usability cliff — it turns a harmless stray comment-turned-key or a forward-compatible field written by a newer orchestrator into a node that refuses to start, and someone has to decide which of those cases deserve to be fatal.
---

# The config file is cast, not validated

## What this is about

`cadre-cli` reads its configuration file like this (`config/loader.ts`, `loadConfigFile`):

```ts
return yaml.load(content) as CliConfigFile;
```

That `as` is a promise to the compiler, not a check. Whatever the YAML happens to contain becomes
the config object. A key the code does not know about is not an error — it is simply never read.

The practical effect: **every setting in the file is one typo away from silently not existing.**
Write `storagetype` instead of `storage.type`, or `listenAddr` instead of `listenAddrs`, and the
node starts happily on the default. There is no warning, and the only evidence is behaviour the
operator did not ask for.

Some individual values *are* validated once they are read — `strandFilter`, the push credentials
block, and the multiaddr lists all fail loudly on a malformed value. That is validation of values
that arrived. It cannot help with a value that never arrived because its key was misspelled.

## Why now

`collapse-cli-identity-key-file-formats` hits this directly. It removes two config keys, and a
removed key under the current loader is *silently ignored* — which for the identity block means the
node quietly generates a brand-new identity instead of using the operator's key. To avoid shipping
that, it adds an explicit allowlist for the `identity` block alone: exactly one accepted key,
everything else throws, with pointed messages for the two retired names.

That is the right guard, and it is deliberately scoped to one block. Generalising it to the whole
config is the obvious next step and is what this ticket is for. The identity block is the worked
example to follow.

## What makes this more than tidiness

The identity block is the sharpest case because a wrong value there costs the node its network
identity. But the same silent-default failure reaches everything else in the file: storage paths,
listen and announce addresses, relay settings, the node-state directory. Several of those produce
symptoms far from their cause — a node that quietly stores nothing durable, or advertises an address
nobody can reach.

It is also the class of bug that gets *worse* with time rather than better: every config key added
from here on inherits the same silent-typo behaviour by default, and every key ever removed becomes
a silent no-op for anyone still naming it.

## The decision this needs

Strictness is the real question, not mechanism. Options a maintainer should weigh:

- **Reject unknown keys outright.** Catches every typo. Also means a config written by a newer
  orchestrator against an older CLI fails to start, which may or may not be acceptable given the
  provider and host both generate config files programmatically.
- **Warn on unknown keys, reject malformed known ones.** No startup cliff, but a warning in a log
  nobody reads is close to the current behaviour in practice.
- **Reject unknown keys, with an explicit escape hatch** for a namespaced block reserved for
  forward-compatible or third-party fields.

Mechanism is secondary — a hand-written validator mirroring `CliConfigFile`, or a schema library —
and should be chosen after the strictness question is settled. Whichever is picked has to cover the
environment-variable overrides too: `ENV_MAPPINGS` writes into the same object via dotted paths, and
a retired or misspelled `CADRE_*` variable is silently ignored by exactly the same mechanism.

## What a fix needs to establish

- A misspelled key anywhere in the config produces an error naming the key and the file, not a
  silent default.
- A retired key produces an error naming its replacement, so the `identity` block's special-cased
  messages can fold into the general mechanism rather than staying a one-off.
- A retired or unknown `CADRE_*` environment variable is reported, not ignored.
- Every config file the repo itself generates or ships still validates: `example.cadre.yaml`, the
  Docker entrypoint's generated `cadre.yaml`, the host orchestrator's per-node `cadre.json`, and the
  provider's per-tenant config. A change that makes the CLI reject its own generated configs is
  worse than the problem.
