// The `qrcode` package's encoder on its own. The package root also loads its canvas and
// SVG-string renderers (and, under Node, the PNG one), none of which a React Native screen
// draws with; `share-code.tsx` imports this path so the bundle carries the encoder only.
declare module 'qrcode/lib/core/qrcode' {
	export { create } from 'qrcode';
}
