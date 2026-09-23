description: Two different strands (or two different parties) can end up sharing one storage folder on Windows and Mac, because those systems treat "Folder" and "folder" as the same name while the rest of the system treats them as different.
architecture: docs/architecture.md#storage-scope-keys
files:
  - packages/cadre-core/src/storage-scope.ts (`isValidStrandScopeKey`, `controlStorageScope`, and the module comment stating the guarantee)
  - docs/architecture.md (the *Storage scope keys* bullet, ~line 1459)
  - packages/cadre-core/src/types.ts (`RawStorageProvider` doc), packages/cadre-core/README.md
  - packages/cadre-cli/src/commands/node-session.ts (the file provider that joins the scope key onto the storage path — where the collision actually happens)
repro: verified
severity: corruption
likelihood: unusual
tradeoffs: Closing it means either narrowing the published character set (a breaking change for any embedder that already uses mixed-case strand ids) or changing how scope keys are spelled on disk (a storage-layout change); the collision needs an id that was deliberately constructed to collide, so a maintainer may reasonably judge the existing character check enough for the realistic threat.
----

# A storage scope key is unique as a string, but not as a filename

## What the system promises

cadre-core hands an embedder a **storage scope key** and tells it the key is safe to use directly as a folder name, a file name or a database name. There are two kinds: a strand's key, which is the strand's id used as-is, and a party's control-database key, which is `control-` followed by an encoded form of the party id. Two promises rest on this (both stated in `docs/architecture.md`, *Storage scope keys*):

- Two different strands get two different stores.
- Two different parties on one device get two different control stores — otherwise a node started for party B reads party A's records as if they were its own.

Both promises hold only if two different keys always produce two different names.

## Why they do not

Windows (NTFS) and macOS (APFS/HFS+ in their default setup) compare file and folder names **without regard to letter case**. The rest of the system — the control database, the in-memory maps that track running strands — compares them **with** regard to case. So two keys that differ only in capitalization are two different things everywhere except on disk, where they are one.

Measured on this machine (Windows 11, Node): with a folder `strand-abc` already present, creating `STRAND-ABC` fails with `EEXIST` — the system reports the folder already exists. Creating `strand-abc.` (a trailing dot) did **not** collide, and folders named `CON`, `NUL`, `aux`, `com1` and `lpt1` all created normally, so those older Windows hazards are not part of this report.

Two ways to reach it:

- **Strands.** A strand's key is its id, verbatim. A party member publishes a strand whose id is another strand's id with different capitalization. A node that joins both runs two independent strands over one folder. Nothing cadre-core mints is mixed-case (its own ids are lowercase hexadecimal, and both reference apps use lowercase), so this needs an id that came from somewhere else — which is exactly the situation the scope-key check was added for.
- **Parties.** The control key encodes the party id in base64url, which is case-significant, so two different party ids can encode to two strings that differ only in case. Demonstrated by search over short party ids: `" ̀"` and `" ́"` encode to `IMKA` and `IMKa`. On a case-insensitive filesystem those are one control store — the precise outcome the encoding exists to prevent.

## What would settle it

The character check that landed in `bug-strand-scope-key-charset-unenforced` asks "is this key usable as a name?". The missing question is "is this key *distinct* as a name?", and no check on a single key in isolation can answer it. Two directions, both of which make the bad state unrepresentable rather than detected:

- **Spell keys in a case-free alphabet.** If a key can only contain one case, distinct-as-a-string and distinct-as-a-name become the same thing, for both kinds of key at once. For strand keys that means narrowing the published character set; for control keys it means an encoding without case, such as base32 or lowercase hexadecimal. This is the recommended direction — it is one rule, it covers both arms, and it needs no per-node bookkeeping.
- **Refuse the second of two colliding keys at the seam that hands keys out.** Keeps the character set as published, but only protects a node that happens to hold both keys at once, and says nothing about a node that meets the second key after a restart.

Either way the published guarantee in `docs/architecture.md`, `packages/cadre-core/README.md` and the `RawStorageProvider` documentation should say which property it actually promises.

Note that this is a storage-layout change however it is decided: existing stores are named with the current spelling. The repository does not yet carry a backwards-compatibility obligation, so the layout may simply change — but somebody should say so deliberately rather than discover it.
