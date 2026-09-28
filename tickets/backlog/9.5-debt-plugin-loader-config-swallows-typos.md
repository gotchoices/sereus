description: A misspelled setting in the Sereus SQL plugin's configuration is silently ignored or quietly swapped for a default, so someone who typos a setting gets behaviour they never asked for and no warning that anything was wrong.
files: packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/README.md
tradeoffs: Rejecting unknown keys is a compatibility cliff — a host whose settings file carries an extra key (its own, a newer plugin version's, or a retired one) stops loading instead of ignoring it, and the plugin loader passes through whatever the host holds.
----

# Loader config: validate what is read, reject what is not

`parseConfig` turns the plugin loader's `Record<string, SqlValue>` settings map into typed
connection options. It reads the keys it knows and coerces each one with a `typeof` test that falls
back to a default; every other key in the map is dropped without a word. A user who misspells a
setting, or carries a setting from an older version of the plugin, gets a running database
configured differently from what their settings file says.

## What is swallowed today

| written in settings | what happens now |
| --- | --- |
| `fret_profile = 'cor'` (typo for `core`) | silently becomes `'edge'` |
| `port = '4001'` (string, not number) | silently becomes `0` (ephemeral port) |
| `enable_cache = 'false'` (string) | silently stays enabled — the string is truthy |
| `sapp_version = 2` (number) | silently becomes `'1.0.0'` |
| `mode = 'bootstrap'` (retired key) | dropped; the connection takes every default |
| `transactr = 'local'` (misspelled key) | dropped; the connection runs on the network |

One key already behaves the other way: `transactor` validates against its three known values and
throws on anything else, because a typo'd storage engine surfaces only as a mystifying hang on a
machine with no peers. That is the behaviour this ticket generalises — the file is currently
inconsistent with itself, and the inconsistency is what makes it hard for a reader to know which
keys they can trust to be checked.

## Expected behaviour

Two independent halves; either can be taken without the other, and the second is the one with a
compatibility cost:

- **Every key that is read is validated.** A value of the wrong type, or an enum value outside the
  known set, is rejected with a message naming the key and the accepted values — the shape
  `parseTransactor` already uses. A key that is genuinely optional stays optional; the rejection is
  for a value that was *supplied and unusable*, not for an absent one.
- **A key that is not read is rejected** (an allowlist), so a retired or misspelled setting is a
  load failure rather than a silent no-op. This is the arm a maintainer might decline: the loader
  hands through the host's whole settings map, and a host that puts its own keys in the same map
  would break. If it is declined, record that as an accepted tradeoff at the site rather than
  leaving the current silence undocumented.

Note that the Node loader (`plugin.ts`) reads one key — `storage_path` — outside `parseConfig`
entirely, so any allowlist has to account for keys consumed by the platform entry points.

## Use cases

- An operator writes `fret_profile = 'cor'` in a host config and wants to be told, not to run a
  differently-tuned node for months.
- A host upgrades the plugin across a release that retired a setting; the stale key should surface
  at load, when someone is watching, rather than at the first behaviour that depends on it.
- A test fixture passes `port` as a string from an environment variable; today that node listens on
  an ephemeral port and the fixture's dial fails somewhere far from the cause.

## Evidence

`transactor`'s validating parser landed in `drop-strand-mode-option-from-sql-plugin`, and its review
pass noted the resulting inconsistency with the rest of the file. `plugin.spec.ts` currently pins
the silent-drop behaviour ("should ignore a key it does not know, including the retired `mode`") as
a decision on record — that test is the one to flip if the allowlist arm is taken.
