// Metro configuration for workspace symlink resolution.
// Resolves workspace packages (cadre-core, etc.) and hoisted node_modules.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const config = getDefaultConfig(__dirname);

// Resolve workspace root for symlinked packages. optimystic/db-p2p portals
// `p2p-fret` (the FRET DHT) from the sibling ../Fret monorepo, so Metro must be
// allowed to follow that symlink out to Fret's real path or the release bundle
// fails with "Unable to resolve module p2p-fret". On EAS the portal resolutions
// are stripped (see scripts/eas-build-pre-install.sh) and p2p-fret comes from
// npm, so — exactly like optimystic/quereus — this sibling root only matters for
// local bundling and is harmless when the directory is absent.
const workspaceRoot = path.resolve(__dirname, '../..');
const optimysticRoot = path.resolve(__dirname, '../../../optimystic');
const quereusRoot = path.resolve(__dirname, '../../../quereus');
const fretRoot = path.resolve(__dirname, '../../../Fret');

config.watchFolders = [
  ...(config.watchFolders ?? []),
  workspaceRoot,
  optimysticRoot,
  quereusRoot,
  fretRoot,
];

config.resolver.unstable_enableSymlinks = true;

const nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths ?? []),
  path.resolve(__dirname, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
  path.resolve(optimysticRoot, 'node_modules'),
  path.resolve(quereusRoot, 'node_modules'),
  path.resolve(fretRoot, 'node_modules'),
];
config.resolver.nodeModulesPaths = nodeModulesPaths;

// Polyfill Node.js built-ins for React Native.
//   os               — real shim: networkInterfaces()/platform() subset via react-native.
//   crypto           — real shim: createHash (sha256/sha512) via @noble/hashes. Still demanded by
//                      transitive deps unrelated to push: multiformats sha2/sha1 (Node variant's
//                      `import crypto from 'crypto'` → createHash), @chainsafe/libp2p-noise's
//                      crypto/index (imports node:crypto), and @libp2p/crypto's Node key modules
//                      before the browser rewrite below redirects them to their noble variants.
//                      cadre-core's FCM/APNs push notifiers no longer reach it — they moved behind
//                      the Node-only '@serfab/cadre-core/push-node' subpath.
//   stream, buffer   — npm packages providing Node-equivalent APIs
//   net, tls         — empty stubs (imported by transitive libp2p deps but never called at runtime)
const emptyShim = path.resolve(__dirname, 'polyfills/empty.js');
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  'node:os': path.resolve(__dirname, 'polyfills/node-os.js'),
  'node:stream': require.resolve('readable-stream'),
  'node:buffer': require.resolve('buffer'),
  'node:crypto': path.resolve(__dirname, 'polyfills/node-crypto.js'),
  'node:net': emptyShim,
  'node:tls': emptyShim,
  os: path.resolve(__dirname, 'polyfills/node-os.js'),
  stream: require.resolve('readable-stream'),
  buffer: require.resolve('buffer'),
  crypto: path.resolve(__dirname, 'polyfills/node-crypto.js'),
  net: emptyShim,
  tls: emptyShim,
};

// Several @libp2p packages ship parallel `.browser.js` variants of their
// Node-using modules and declare the rewrite in their package.json `browser`
// field:
//
//   @libp2p/crypto — ed25519/secp256k1/rsa/ecdh keys, webcrypto, hmac, aes-gcm.
//     The browser variants use @noble/curves + WebCrypto and run correctly under
//     Hermes; the Node variants call crypto.generateKeyPairSync /
//     createPrivateKey / sign / verify which our minimal polyfills/node-crypto.js
//     does not implement.
//   @libp2p/webrtc — webrtc/index, private-to-public/{listener,transport}, and
//     get-rtcpeerconnection. The Node variants pull `node-datachannel` (a native
//     addon absent on RN); the browser variants read the WebRTC engine off the
//     globals react-native-webrtc's registerGlobals() installs (see
//     polyfills/webrtc.js). The `browser` field also lists `node:net`/`node:os`
//     → false, but those `node:*` specifiers are already neutralised by the
//     extraNodeModules empty shims above, so we skip the non-string targets here.
//     We force the `browser` (not `react-native`) variant deliberately: the
//     `react-native` field only remaps webrtc/index.js, leaving the three
//     private-to-public modules resolving to their node-datachannel originals,
//     whereas the `browser` field covers the whole node-datachannel surface.
//
// With `unstable_enablePackageExports: true` (Expo SDK 52+ default) Metro
// resolves these packages via `exports` and the `browser`-field rewrite is not
// reliably applied to their internal relative imports.  We apply it explicitly
// via resolveRequest so key generation and the WebRTC transport resolve their
// Hermes-safe variants on first launch.
//
// Bare `require.resolve('@libp2p/<pkg>')` is blocked by exports enforcement on
// Node 20+ (the `"."` entry only lists `import`), so locate each package by
// walking the nodeModulesPaths we already configure for Metro.
function loadLibp2pBrowserMap(scope, name) {
  for (const nmRoot of nodeModulesPaths) {
    const pkgDir = path.join(nmRoot, scope, name);
    const pkgJson = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    const map = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).browser;
    if (!map || typeof map !== 'object') return null;
    const out = Object.create(null);
    for (const [from, to] of Object.entries(map)) {
      // Skip non-path targets such as `"node:net": false` — those specifiers are
      // handled by extraNodeModules empty shims, and path.resolve(pkgDir, false)
      // would be nonsense.
      if (typeof to !== 'string') continue;
      out[path.resolve(pkgDir, from)] = path.resolve(pkgDir, to);
    }
    return out;
  }
  return null;
}
const libp2pBrowserMap = Object.assign(
  Object.create(null),
  loadLibp2pBrowserMap('@libp2p', 'crypto') ?? {},
  loadLibp2pBrowserMap('@libp2p', 'webrtc') ?? {},
);

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = upstreamResolveRequest
    ? upstreamResolveRequest(context, moduleName, platform)
    : context.resolveRequest(
        { ...context, resolveRequest: undefined },
        moduleName,
        platform,
      );
  if (
    resolved &&
    resolved.type === 'sourceFile' &&
    libp2pBrowserMap[resolved.filePath]
  ) {
    return {
      type: 'sourceFile',
      filePath: libp2pBrowserMap[resolved.filePath],
    };
  }
  return resolved;
};

module.exports = config;

