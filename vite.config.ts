import previewDebugPlugin from './vite-plugin-preview-debug.mjs';
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [previewDebugPlugin(), react()],
})
