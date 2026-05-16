priority: 3
description: GitHub Actions CI pipeline with EAS Build + Maestro Cloud UI tests
prereq: first-eas-build (must succeed first), packages/reference-app-rn, packages/cadre-cli
files: .github/workflows/ci.yml, packages/reference-app-rn/maestro/, docs/reference-app-rn.md
----

## Context

No CI pipeline exists yet. The monorepo uses Yarn 4 workspaces with 6 packages. The reference-app-rn has a Metro bundle smoke test (`yarn test:bundle`). The cadre-cli has a Docker setup and can run as a drone fixture. Maestro Cloud is the target for automated UI testing (per project goals).

## Architecture

```
GitHub Actions Workflow (ci.yml)
├── Job: lint-test-typecheck
│   ├── yarn install
│   ├── yarn typecheck (workspace-wide)
│   ├── yarn lint (workspace-wide)
│   └── yarn test (vitest, workspace-wide)
│
├── Job: bundle-check
│   ├── yarn install
│   └── yarn workspace @serfab/reference-app-rn test:bundle
│
├── Job: eas-preview-build (on push to master or PR)
│   ├── expo/eas-build-action (preview profile, Android)
│   └── Outputs: build URL / artifact
│
└── Job: maestro-e2e (needs: eas-preview-build)
    ├── Build cadre-cli
    ├── Start drone as background fixture
    ├── Run Maestro Cloud against preview APK
    └── Report pass/fail
```

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `EXPO_TOKEN` | EAS Build authentication (Expo account access token) |
| `MAESTRO_CLOUD_API_KEY` | Maestro Cloud API authentication |

### Maestro Test Flows

Basic flows for the reference app's two screens:

1. **app-launches.yaml** — App starts, chat screen visible
2. **navigate-settings.yaml** — Tap settings, verify settings screen renders
3. **configure-drone.yaml** — Enter drone address in settings (validates input fields work)

These are minimal smoke tests. Full E2E (drone fixture + seed exchange + message send) is Phase 2 (tracked in separate E2E task).

### Drone Fixture Strategy

For the `maestro-e2e` job, the drone runs as a background process:

```bash
cd packages/cadre-cli && yarn build
node dist/bin/cadre.js start \
  -c ../reference-app-rn/drone.cadre.yaml \
  --listen-for-seeds &
```

The drone listens on TCP 4001 + WS 4002. For Maestro Cloud, the drone would need to be network-accessible to the cloud device — this is a constraint. Options:
- **Phase 1**: Maestro flows test only UI (no live drone needed)
- **Phase 2**: Use a tunnel (ngrok/cloudflared) or self-hosted Maestro runner with local drone

## Implementation Plan

### 1. Create `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: corepack enable && corepack prepare yarn@4.12.0 --activate
      - run: yarn install --immutable
      - run: yarn typecheck
      - run: yarn test

  bundle-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: corepack enable && corepack prepare yarn@4.12.0 --activate
      - run: yarn install --immutable
      - run: yarn workspace @serfab/reference-app-rn test:bundle

  eas-build:
    if: github.event_name == 'push' && github.ref == 'refs/heads/master'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}
      - run: corepack enable && corepack prepare yarn@4.12.0 --activate
      - run: yarn install --immutable
      - working-directory: packages/reference-app-rn
        run: eas build --profile preview --platform android --non-interactive --no-wait

  maestro-e2e:
    needs: eas-build
    if: github.event_name == 'push' && github.ref == 'refs/heads/master'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mobile-dev-inc/action-maestro-cloud@v1
        with:
          api-key: ${{ secrets.MAESTRO_CLOUD_API_KEY }}
          app-file: # TBD: EAS build artifact URL
          workspace: packages/reference-app-rn/maestro
```

### 2. Create Maestro Test Flows

Directory: `packages/reference-app-rn/maestro/`

### 3. Update Documentation

Add CI/CD section to `docs/reference-app-rn.md` covering:
- How the pipeline works
- Required secrets setup
- How to run Maestro flows locally

## TODO
- [ ] Create `.github/workflows/ci.yml` with lint-test and bundle-check jobs
- [ ] Add EAS preview build job (gated on master push)
- [ ] Create `packages/reference-app-rn/maestro/` directory with initial test flows
- [ ] Add Maestro Cloud job (gated on successful EAS build)
- [ ] Document CI pipeline and required secrets in docs/reference-app-rn.md
- [ ] Verify workflow syntax with `actionlint` or dry-run
