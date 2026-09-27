// Metro configuration. @serfab/cadre-rn/metro supplies everything a Sereus app needs
// (symlinks, Node built-in shims, one copy of each native peer, the libp2p browser
// rewrites); this file only names the local checkouts linked into the app.

const { getDefaultConfig } = require('expo/metro-config');
const { withCadreMetro } = require('@serfab/cadre-rn/metro');
const path = require('path');

// optimystic/db-p2p portals `p2p-fret` (the FRET DHT) from the sibling ../Fret monorepo,
// so Metro must be allowed to follow that symlink out to Fret's real path or the release
// bundle fails with "Unable to resolve module p2p-fret". On EAS the portal resolutions are
// stripped (see scripts/eas-build-pre-install.sh) and p2p-fret comes from npm, so, exactly
// like optimystic/quereus, this sibling root only matters for local bundling and is
// harmless when the directory is absent.
// NOTE: local bundling now depends on three sibling monorepos (optimystic, quereus, Fret)
// being present and portaled. If a fourth portaled sibling is ever added to the graph, the
// local release bundle fails with "Unable to resolve module <x>" until its root is added to
// linkedRoots here.
const workspaceRoot = path.resolve(__dirname, '../..');
const optimysticRoot = path.resolve(__dirname, '../../../optimystic');
const quereusRoot = path.resolve(__dirname, '../../../quereus');
const fretRoot = path.resolve(__dirname, '../../../Fret');

// NOTE: accepted tradeoff — whole repo roots are watched, tickets/ and docs/
// included; no resolver.blockList. Measured 2026-09-16: a write outside the bundle's
// module graph (tickets, docs, logs, optimystic's tickets/.index/index.db) sends the
// phone an empty HMR update, which flashes "Refreshing..." and clears LogBox and any
// red box but never reloads (.md is not a watched extension and sends nothing). A
// blockList would only remove those flashes, and any unanchored pattern also blocks
// module resolution inside node_modules. Device runs that must not change use
// `yarn start:frozen` (docs/reference-app-rn.md § Device test runs). Revisit if a
// cleared red box ever hides a failure mid-run: add a blockList anchored to each
// root's top-level tickets/, docs/, ops/, tmp/ and .runs/, keeping dist and
// node_modules watched.
module.exports = withCadreMetro(getDefaultConfig(__dirname), {
  projectRoot: __dirname,
  linkedRoots: [workspaceRoot, optimysticRoot, quereusRoot, fretRoot],
});
