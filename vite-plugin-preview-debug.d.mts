// Types for the dev-only preview-debug plugin (vite-plugin-preview-debug.mjs).
// The plugin is plain JavaScript with no types of its own, and an app's
// `npm run build` type-checks its vite.config with `tsc -b` first: without this
// declaration the config's import fails with TS7016 ("Could not find a
// declaration file for module './vite-plugin-preview-debug.mjs'") and the app
// can never be published.
import type { Plugin } from 'vite';

export default function previewDebugPlugin(): Plugin;
