import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// The SPA is served by @serfab/cadre-host from `dist/ui/` and mounted at
// the site root. Use relative asset URLs (`base: './'`) so a future shift
// to a sub-path or to opening the bundle directly via file:// keeps working.
export default defineConfig({
	root: here,
	base: './',
	plugins: [svelte()],
	build: {
		outDir: resolve(here, '..', 'dist', 'ui'),
		emptyOutDir: true,
		target: 'es2022',
		sourcemap: true,
	},
	server: {
		// `vite` dev server proxies API calls to a running cadre-host on 8765.
		// Operators that want a different port pass it via CADRE_HOST_PORT.
		port: 5173,
		proxy: proxyTargets(process.env['CADRE_HOST_PORT'] ?? '8765'),
	},
});

function proxyTargets(port: string): Record<string, string> {
	const target = `http://127.0.0.1:${port}`;
	return {
		'/api': target,
		'/auth': target,
		'/nat': target,
		'/update': target,
	};
}
