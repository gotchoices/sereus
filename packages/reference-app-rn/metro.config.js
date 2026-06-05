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

// @libp2p/crypto ships parallel `.browser.js` variants of its Node-using
// modules (ed25519/secp256k1/rsa/ecdh keys, webcrypto, hmac, aes-gcm).  The
// browser variants use @noble/curves + WebCrypto and run correctly under
// Hermes; the Node variants call crypto.generateKeyPairSync / createPrivateKey
// / sign / verify which our minimal polyfills/node-crypto.js does not
// implement.
//
// The package declares the mapping in its `browser` field, but with
// `unstable_enablePackageExports: true` (Expo SDK 52+ default) Metro resolves
// via `exports` and the browser rewrite is not reliably applied.  We apply it
// explicitly via resolveRequest so Ed25519 key generation (and any future
// consumer of these modules) works on first launch.
//
// Bare `require.resolve('@libp2p/crypto')` is blocked by exports enforcement
// on Node 20+ (the `"."` entry only lists `import`), so locate the package by
// walking the nodeModulesPaths we already configure for Metro.
function loadLibp2pCryptoBrowserMap() {
  for (const nmRoot of nodeModulesPaths) {
    const pkgDir = path.join(nmRoot, '@libp2p', 'crypto');
    const pkgJson = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const map = pkg.browser;
    if (!map || typeof map !== 'object') return null;
    const out = Object.create(null);
    for (const [from, to] of Object.entries(map)) {
      out[path.resolve(pkgDir, from)] = path.resolve(pkgDir, to);
    }
    return out;
  }
  return null;
}
const libp2pCryptoBrowserMap = loadLibp2pCryptoBrowserMap();

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
    libp2pCryptoBrowserMap &&
    resolved &&
    resolved.type === 'sourceFile' &&
    libp2pCryptoBrowserMap[resolved.filePath]
  ) {
    return {
      type: 'sourceFile',
      filePath: libp2pCryptoBrowserMap[resolved.filePath],
    };
  }
  return resolved;
};

module.exports = config;

