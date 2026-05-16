priority: 4
description: Trigger first EAS Build (Android), verify dev client, document troubleshooting
prereq: packages/reference-app-rn, eas.json, Expo account with EAS access
files: packages/reference-app-rn/eas.json, packages/reference-app-rn/package.json, docs/reference-app-rn.md
----

## Context

The reference app has EAS Build configured (`eas.json` with development/preview/production profiles, Node 22.17.0, corepack pre-install hook) but has never been built. The Metro bundle smoke test (`yarn test:bundle`) passes, confirming import resolution is correct. This task validates that native compilation succeeds on EAS servers.

## What to Do

### Phase 1: Trigger Development Build (Android)

From `packages/reference-app-rn`:

```bash
npx eas build --profile development --platform android
```

**Expected behavior:**
- EAS picks up `eas.json` with `node: "22.17.0"` from `base` profile
- `eas-build-pre-install` hook enables corepack + yarn 4.12.0
- Yarn workspace hoisting resolves `workspace:^` deps (cadre-core)
- Native modules compile (react-native-mmkv is the critical one)
- Output: `.apk` or downloadable link

**Known risks:**
- Yarn 4 workspace resolution on EAS — the `eas-build-pre-install` script activates corepack but EAS may need the full monorepo context. If it fails, we may need `EAS_BUILD_MONOREPO_ROOT` or a custom build hook.
- `react-native-mmkv` native compilation — requires CMake on Android. EAS images include it by default.
- Portal resolutions in `.yarnrc.yml` for `@optimystic/*` and `@quereus/*` packages — EAS needs to resolve these. If they point to local paths, the build will fail. Check if they resolve to npm versions.

### Phase 2: Install and Verify

1. Download the `.apk` from EAS dashboard or `eas build:list`
2. Install on Android emulator or physical device: `adb install <path>.apk`
3. Start Metro: `cd packages/reference-app-rn && npx expo start --dev-client`
4. Open the dev client — it should connect to Metro and render the chat UI
5. Navigate to Settings tab — verify the screen renders without crashes
6. Verify no native module crashes (MMKV initialization in particular)

### Phase 3: Document

Update `docs/reference-app-rn.md` Build & Development Workflow section with:
- Exact commands that worked (or workarounds needed)
- Any EAS configuration changes required
- Troubleshooting notes for common failures
- Add a "Build Troubleshooting" subsection

## TODO
- [ ] Verify `.yarnrc.yml` portal resolutions won't break EAS (portals are local-only; npm versions needed)
- [ ] Run `npx eas build --profile development --platform android`
- [ ] If build fails, diagnose and fix (likely workspace resolution or native deps)
- [ ] Install dev client APK, verify Metro connects
- [ ] Verify MMKV initializes without crash
- [ ] Update docs/reference-app-rn.md with build troubleshooting section
