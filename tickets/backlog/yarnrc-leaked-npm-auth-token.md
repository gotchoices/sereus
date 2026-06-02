description: A live npm auth token is committed in the repo root `.yarnrc.yml` — rotate it and stop tracking it
files: .yarnrc.yml, .gitignore
----

# Leaked npm auth token committed in `.yarnrc.yml`

## Problem

The repo root `.yarnrc.yml` contains a hardcoded npm registry credential:

```yaml
npmAuthToken: "REDACTED_NPM_TOKEN"
```

This is a live secret tracked in version control and present in the git history. Anyone
with read access to the repo (or to any clone/fork) can use it against the npm registry
scope it is authorized for. It was surfaced during the
`cadre-cli-docker-yarn-workspace-build` review — the Docker build deliberately uses a
minimal Docker-specific `.yarnrc.yml` (`nodeLinker: node-modules` only) precisely to avoid
baking this token into images, but the secret itself remains in the repo.

## Expected behavior

- The token is **rotated/revoked** at the npm provider (the committed value must be treated
  as compromised — revocation is the only real fix; removing it from the working tree does
  not un-leak it).
- The working tree no longer carries a literal token. Standard approaches: move auth to a
  `${NPM_AUTH_TOKEN}` environment-variable interpolation in `.yarnrc.yml`, or to an
  untracked `.yarnrc.yml`/`.npmrc` with the tracked file holding only non-secret config.
- Confirm whether the token is even required for the normal install (the public
  `@optimystic/*` / `@quereus/*` packages installed fine in a scratch dir with **no** token
  during the Docker review). If nothing in the dependency tree needs auth, the token can be
  dropped entirely rather than re-homed.

## Notes

- Requires access to the npm account that issued the token, so this is human-driven, not
  agent-completable end-to-end.
- Consider purging the value from git history (e.g. `git filter-repo`) as a follow-on, but
  rotation is the priority — history rewriting does not help if the token is still valid.
