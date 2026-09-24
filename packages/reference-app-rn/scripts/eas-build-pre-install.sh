#!/bin/bash
# EAS Build pre-install hook
# Runs before `yarn install` on EAS build servers.
#
# Fixes two issues:
# 1. The committed .yarnrc.yml has no nmHoistingLimits, which the RN build needs
#    on top of the node-modules linker — appended below, not restated, so the
#    two cannot drift
# 2. Root package.json has portal: resolutions pointing to sibling repos
#    (../optimystic, ../quereus) that don't exist on EAS — strip them so
#    yarn resolves from npm instead
#
# Strategy: strip portals, delete stale lockfile, run yarn install ourselves.
# EAS's subsequent `yarn install --immutable` then succeeds (lockfile exists).

set -euo pipefail

echo "=== EAS pre-install: enabling corepack + yarn 4 ==="
corepack enable
corepack prepare yarn@4.12.0 --activate

# Navigate to monorepo root (EAS runs this from the package directory)
MONO_ROOT="$(cd ../.. && pwd)"

echo "=== EAS pre-install: adding hoisting limits to .yarnrc.yml ==="
YARNRC="$MONO_ROOT/.yarnrc.yml"
if [ ! -f "$YARNRC" ]; then
	echo "$YARNRC is missing — it is committed, so the checkout is wrong" >&2
	exit 1
fi
# Appending twice would give Yarn a duplicate key, and EAS may re-run this hook.
if ! grep -q '^nmHoistingLimits:' "$YARNRC"; then
	cat >> "$YARNRC" << 'YARNRC_APPEND'

# Hoisting limits for React Native (added by the EAS pre-install hook)
nmHoistingLimits: workspaces
YARNRC_APPEND
fi

echo "=== EAS pre-install: stripping portal resolutions from package.json ==="
node -e "
const fs = require('fs');
const path = require('path');
const pkgPath = path.join('$MONO_ROOT', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.resolutions) {
  const stripped = {};
  let removed = 0;
  for (const [key, value] of Object.entries(pkg.resolutions)) {
    if (typeof value === 'string' && value.startsWith('portal:')) {
      console.log('  Removing portal resolution:', key, '->', value);
      removed++;
    } else {
      stripped[key] = value;
    }
  }
  if (Object.keys(stripped).length === 0) {
    delete pkg.resolutions;
  } else {
    pkg.resolutions = stripped;
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('  Removed', removed, 'portal resolution(s)');
}
"

# The lock file contains portal: entries that will fail resolution.
# Delete it and run yarn install ourselves so a fresh lockfile is generated.
# EAS's subsequent `yarn install --immutable` will then succeed.
echo "=== EAS pre-install: removing stale yarn.lock and running fresh install ==="
rm -f "$MONO_ROOT/yarn.lock"
cd "$MONO_ROOT"
YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install

echo "=== EAS pre-install: done ==="
