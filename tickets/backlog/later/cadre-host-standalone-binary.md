---
description: Standalone single-executable cadre-host distribution — bundled Node runtime, platform installers (.msi/.pkg/.deb/.rpm), code-signing, signed-binary update path
prereq: cadre-host-installer, cadre-host-update-flow
files: packages/cadre-host/build/ (new), .github/workflows/cadre-host-release.yml (new)
difficulty: hard
---

## Why this is separate

The npm-distributed install (`npm install -g @serfab/cadre-host && cadre-host install`) gets a self-host user running today. A standalone executable that doesn't require Node and ships in platform-native installers is **polish on top of a working install path**, not a prerequisite. The standalone-binary work pulls in:

- Cross-platform CI for three OS / architecture matrices (linux x64/arm64, macOS x64/arm64, Windows x64).
- Bundling with `node-sea` (preferred — built into Node 22) or `pkg`, then platform installers (`fpm` / `pkgbuild` / `WiX`).
- An Authenticode code-signing certificate (real money — ~$200/yr for OV, ~$400/yr for EV) and the secret-management story to keep the key out of CI logs.
- Apple notarization (Developer ID; another $99/yr) and the notarization-staple step.
- The signed-binary update path: download a replacement binary to a side path, swap on next start, fall back if the new binary won't launch.
- AV-heuristic mitigation (signed binaries help; reputation building takes weeks of distribution before Defender stops flagging).
- Bundled NSSM for the Windows installer (instead of asking the user to install NSSM themselves).

None of that blocks an opinionated technical user from running cadre-host. It does block "Mom's basement PC" — but Mom's basement PC isn't the v1 audience.

## Scope outline (when promoted)

- Pick the bundler: lean is `node-sea` if Node 22 is acceptable as the package minimum; fallback `pkg` fork.
- Build matrix in CI: 5 targets (linux-x64, linux-arm64, macos-x64, macos-arm64, win-x64). Output a single signed artifact per target.
- Platform installers:
  - Windows: `.msi` via WiX, bundles NSSM.
  - macOS: `.pkg` via `pkgbuild` + `productbuild`, notarized + stapled.
  - Linux: `.deb` + `.rpm` via `fpm`; AppImage as a stretch.
- Code-signing pipeline: secrets in GitHub Actions, signing per-target via the appropriate tool (`signtool` for Windows, `codesign` + `notarytool` for macOS, GPG for `.deb`/`.rpm`).
- Update manifest: add a per-platform artifact list with SHA-256 digests + per-artifact Ed25519 signatures. `cadre-host update apply` (standalone variant) downloads the artifact, verifies digest + signature, swaps the binary, restarts the service.
- Side-by-side swap and rollback: install dir contains `current/` → symlink/junction to `versions/<v>/`. New version installed to `versions/<new>/`, atomically flip the symlink, restart. If the new binary fails to launch (detected by service-host restart loop), flip back to previous.
- Bundled NSSM: ship `nssm.exe` inside the Windows installer's program-files dir instead of asking the user to install it separately.

## What this ticket does NOT cover

- A separate auto-updater binary (the cadre-host binary updates itself in-place; that's fine for v1).
- ARM Windows or x86 (not on the v1 platform list).
- macOS Universal binaries (just ship per-arch artifacts).
- Snap / Flatpak / Chocolatey / Homebrew — distribution-channel polish that comes after the standalone exists at all.

When this is promoted to plan stage, look at the npm-distributed install's actual rough edges first; the standalone-binary work should be motivated by real installation pain, not "it would be nicer to have a .msi".
