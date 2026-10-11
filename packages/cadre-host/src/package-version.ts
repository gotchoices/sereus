import { createRequire } from 'node:module';

// src/package-version.ts and dist/package-version.js both sit one level below package.json.
export const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
