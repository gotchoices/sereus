----
description: We still publish a package we wrote off as deprecated, and every release packs and installs it as part of the pre-release check. It has been decided that we stop shipping it, so it needs to come out of the build, the release process, and the repository.
files: package.json, packages/strand-proto/, docs/testing.md, docs/strand-proto.md, AGENTS.md, eslint.config.mjs, scripts/release-preflight.mjs
prereq: retire-backwards-compatibility-affordances
difficulty: easy
----

# Do we still publish `@serfab/strand-proto`? — **decided: no**

> **Decision (2026-08-20, maintainer).** Stop. There are no live instances and no external
> consumers, and the standing position is that any break we know we want should be taken now while
> it is free. Delete the package, drop it from the publish chain and the release pre-flight, and
> remove the eslint and type-check exemptions that exist only to carve it out. This ticket left
> `blocked/` because the question it asked has been answered — what remains is execution, and the
> shape of that is what the plan stage should settle.
>
> One thing the original ticket did not cover, now tracked by
> `plan/retire-backwards-compatibility-affordances` item 5: `docs/strand-proto.md:4` holds the
> protocol id at `/sereus/bootstrap/1.0.0` explicitly "for backward compatibility", while
> `docs/architecture.md:518` says the live formation transport mirrors a *non-deprecated*
> seed-bootstrap service. Establish whether those are the same protocol before deleting anything,
> so a live protocol id does not leave with the dead package.
>
> Note also that this ticket's original `files:` named `docs/STATUS.md`, which no longer exists —
> its content moved to `docs/testing.md` in `3ca8737`.

## What is true today

Three separate places call this package deprecated:

- `AGENTS.md`, in the repo orientation: "`strand-proto` deprecated".
- `eslint.config.mjs` skips `packages/strand-proto/**`, with the comment "deprecated package".
- `docs/STATUS.md` names it deprecated when explaining why its tests sit outside the type-check
  program.

Nothing in this repository depends on it: no other package's `package.json` lists
`@serfab/strand-proto` in `dependencies` or `devDependencies`.

Yet it is still first in the publish chain. The root `package.json` has:

```
"pub": "yarn pub:strand-proto && yarn pub:quereus-plugin-sereus && ... ",
"pub:strand-proto": "node scripts/publish-package.mjs strand-proto",
```

so `yarn pub` pushes a new 0.9.0-line release of it alongside the packages we actually support.

## Why it is being raised now

The new release gate `yarn smoke:published` derives its publishable set from those `pub:*` scripts —
deliberately, so a newly publishable package is covered the moment it gets one. That means every
pre-release run now also packs `strand-proto`, installs it into the scratch project, and reports on
it. The visible cost is small (one extra tarball, and two of the seven lines in the duplicate-copy
report are its nested `@multiformats/multiaddr` and `it-length-prefixed`), but the gate is now
spending time proving a deprecated package installs cleanly.

## The decision

Someone has to say which of these is true, because the code cannot infer it:

- **Keep publishing it.** Then "deprecated" is the wrong word for it in `AGENTS.md`, `eslint.config.mjs`
  and `docs/STATUS.md` — it is a supported-but-frozen package, and it should be linted and covered like
  the rest of the publishable set.
- **Stop publishing it.** Then drop `pub:strand-proto` from the `pub` chain (and, if npm deprecation is
  wanted, mark the published versions deprecated). The smoke gate follows automatically; nothing else
  in the repo needs to change.

There may be external consumers of `@serfab/strand-proto` that this repository cannot see — that is
exactly the part only a human can answer, and it is why this is not a backlog item.

Out of scope either way: deleting `packages/strand-proto/` itself. Nothing here argues for removing the
source, only for settling whether new versions of it keep going to npm.

## For the next release specifically: leave it out (2026-08-03)

The interim release (`docs/releasing.md` → "The interim release") ships five packages, not six, and
skips this one. That is a deliberately narrower call than the question above, and it does not
pre-empt it:

- Nothing in `packages/strand-proto/` has changed since the `chore: release v0.9.0` commit except a
  type-check config edit (`git log -- packages/strand-proto`). A new version would carry a version
  number and nothing else.
- **Not publishing a new version is not unpublishing.** 0.9.0 stays on npm and keeps resolving for
  any external consumer this repo cannot see, so skipping one release costs nobody anything and
  forecloses nothing.

The permanent question — keep shipping it or stop for good, and correct the three places that call
it deprecated accordingly — is still this ticket's, and still a human's.
