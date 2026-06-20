// Metro configuration for workspace symlink resolution.
// Resolves workspace packages (cadre-core, etc.) and hoisted node_modules.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const config = getDefaultConfig(__dirname);

// Resolve workspace root for symlinked packages
const workspaceRoot = path.resolve(__dirname, '../..');
const optimysticRoot = path.resolve(__dirname, '../../../optimystic');
const quereusRoot = path.resolve(__dirname, '../../../quereus');

config.watchFolders = [
  ...(config.watchFolders ?? []),
  workspaceRoot,
  optimysticRoot,
  quereusRoot,
];

config.resolver.unstable_enableSymlinks = true;

const nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths ?? []),
  path.resolve(__dirname, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
  path.resolve(optimysticRoot, 'node_modules'),
  path.resolve(quereusRoot, 'node_modules'),
];
config.resolver.nodeModulesPaths = nodeModulesPaths;

// Polyfill Node.js built-ins for React Native.
//   os, crypto       — real shims providing subset APIs via react-native / @noble/hashes
//   stream, buffer   — npm packages providing Node-equivalent APIs
//   net, tls         — empty stubs (imported by transitive libp2p deps but never called at runtime)
//   http2            — empty stub: cadre-core's server-only push-notifier (APNs HTTP/2) is reachable
//                      via CadreNode's guarded dynamic import, but a phone never sets config.push so the
//                      fan-out/notifier never loads — the stub only satisfies Metro's graph resolution.
const emptyShim = path.resolve(__dirname, 'polyfills/empty.js');
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  'node:os': path.resolve(__dirname, 'polyfills/node-os.js'),
  'node:stream': require.resolve('readable-stream'),
  'node:buffer': require.resolve('buffer'),
  'node:crypto': path.resolve(__dirname, 'polyfills/node-crypto.js'),
  'node:net': emptyShim,
  'node:tls': emptyShim,
  'node:http2': emptyShim,
  os: path.resolve(__dirname, 'polyfills/node-os.js'),
  stream: require.resolve('readable-stream'),
  buffer: require.resolve('buffer'),
  crypto: path.resolve(__dirname, 'polyfills/node-crypto.js'),
  net: emptyShim,
  tls: emptyShim,
  http2: emptyShim,
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

